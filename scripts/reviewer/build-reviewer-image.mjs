#!/usr/bin/env node
/**
 * build-reviewer-image.mjs — build one reviewer sandbox image from the trusted
 * runtime table.
 *
 * Every build arg (base digest, runtime versions and checksums, image id) is
 * read from docker/reviewer/runtime-matrix.json. The tag defaults to
 * reviewer-image:<id>. Prints the built image id and, when the engine reports
 * one, its repo digest.
 *
 *   node scripts/reviewer/build-reviewer-image.mjs <imageId> [--tag <tag>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_TABLE = resolve(REPO, "docker", "reviewer", "runtime-matrix.json");

export function loadTable(path = DEFAULT_TABLE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The exact build args for one matrix image. Pure: unit-tested against the
 *  table so a wrong version or checksum cannot be passed silently. */
export function buildArgsFor(image, table) {
  const node = table.artifacts?.node?.[image.node];
  const bun = table.artifacts?.bun?.[image.bun];
  const gh = table.artifacts?.gh?.[image.gh];
  const missing = [];
  if (!node) missing.push(`node ${image.node}`);
  if (!bun) missing.push(`bun ${image.bun}`);
  if (!gh) missing.push(`gh ${image.gh}`);
  if (missing.length > 0) {
    throw new Error(`image ${image.id} pins runtimes absent from the table: ${missing.join(", ")}`);
  }
  return [
    "--build-arg", `BASE_REF=${table.base.image}@${table.base.digest}`,
    "--build-arg", `NODE_VERSION=${image.node}`,
    "--build-arg", `NODE_SHA256=${node.sha256}`,
    "--build-arg", `BUN_VERSION=${image.bun}`,
    "--build-arg", `BUN_SHA256=${bun.sha256}`,
    "--build-arg", `GH_VERSION=${image.gh}`,
    "--build-arg", `GH_SHA256=${gh.sha256}`,
    "--build-arg", `REVIEWER_IMAGE_ID=${image.id}`,
  ];
}

function main(argv) {
  let tag;
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag") {
      tag = argv[++i];
      continue;
    }
    if (a.startsWith("--")) continue;
    positional.push(a);
  }
  const imageId = positional[0];
  if (!imageId) {
    process.stderr.write("usage: build-reviewer-image.mjs <imageId> [--tag <tag>]\n");
    return 2;
  }
  tag = tag ?? `reviewer-image:${imageId}`;
  const table = loadTable();
  const image = (table.images ?? []).find((i) => i.id === imageId);
  if (!image) {
    process.stderr.write(`no such matrix image: ${imageId}\n`);
    return 2;
  }
  const buildArgs = buildArgsFor(image, table);
  const res = spawnSync(
    "docker",
    ["build", "--file", resolve(REPO, "docker", "reviewer", "Dockerfile"), "--tag", tag, ...buildArgs, REPO],
    { stdio: "inherit" },
  );
  if (res.status !== 0) return res.status ?? 1;
  const inspect = spawnSync("docker", ["inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" });
  process.stdout.write(`${JSON.stringify({ image_id: imageId, tag, image_sha256: (inspect.stdout ?? "").trim() })}\n`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("build-reviewer-image.mjs")) {
  process.exit(main(process.argv));
}
