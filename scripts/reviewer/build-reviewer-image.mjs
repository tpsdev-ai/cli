#!/usr/bin/env node
/**
 * build-reviewer-image.mjs — build one reviewer sandbox image from the trusted
 * runtime table, for linux/amd64.
 *
 * Every build input (platform, base digest, runtime versions and checksums, the
 * launcher's js-yaml tarball checksum, the image id) is read from
 * docker/reviewer/runtime-matrix.json. The tag defaults to reviewer-image:<id>.
 * Prints one JSON line with the LOCAL image id (`docker inspect .Id`): the host
 * builds at install time and records that id in its sandbox config
 * (`sandbox.docker.image: "sha256:…"`), a content-addressed reference the engine
 * itself resolves. No registry is involved, and a build on another host is not
 * claimed to produce the same id (apt packages are not pinned).
 *
 *   node scripts/reviewer/build-reviewer-image.mjs <imageId> [--tag <tag>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_TABLE = resolve(REPO, "docker", "reviewer", "runtime-matrix.json");
export const PLATFORM = "linux/amd64";

export function loadTable(path = DEFAULT_TABLE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The exact `docker build` arguments for one matrix image. Pure: unit-tested
 *  against the table so a wrong version, checksum or platform cannot pass silently. */
export function buildArgsFor(image, table) {
  const node = table.artifacts?.node?.[image.node];
  const bun = table.artifacts?.bun?.[image.bun];
  const gh = table.artifacts?.gh?.[image.gh];
  const jsyaml = table.launcherDeps?.["js-yaml"];
  const missing = [];
  if (!node) missing.push(`node ${image.node}`);
  if (!bun) missing.push(`bun ${image.bun}`);
  if (!gh) missing.push(`gh ${image.gh}`);
  if (!jsyaml?.version || !jsyaml?.sha256) missing.push("launcherDeps js-yaml");
  if (missing.length > 0) {
    throw new Error(`image ${image.id} pins inputs absent from the table: ${missing.join(", ")}`);
  }
  if (table.base?.platform !== PLATFORM || image.platform !== PLATFORM) {
    throw new Error(`image ${image.id} is not ${PLATFORM} (base ${table.base?.platform}, image ${image.platform})`);
  }
  return [
    "--platform", PLATFORM,
    "--build-arg", `BASE_REF=${table.base.image}@${table.base.digest}`,
    "--build-arg", `NODE_VERSION=${image.node}`,
    "--build-arg", `NODE_SHA256=${node.sha256}`,
    "--build-arg", `BUN_VERSION=${image.bun}`,
    "--build-arg", `BUN_SHA256=${bun.sha256}`,
    "--build-arg", `GH_VERSION=${image.gh}`,
    "--build-arg", `GH_SHA256=${gh.sha256}`,
    "--build-arg", `JSYAML_VERSION=${jsyaml.version}`,
    "--build-arg", `JSYAML_SHA256=${jsyaml.sha256}`,
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
    if (a.startsWith("--")) {
      process.stderr.write(`unknown option: ${a}\n`);
      return 2;
    }
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
    { stdio: ["ignore", 2, 2] },
  );
  if (res.status !== 0) return res.status ?? 1;
  const inspect = spawnSync("docker", ["inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" });
  const localImageId = (inspect.stdout ?? "").trim();
  if (inspect.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(localImageId)) {
    process.stderr.write(`could not read the local image id of ${tag}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ image_id: imageId, tag, platform: PLATFORM, local_image_id: localImageId })}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("build-reviewer-image.mjs")) {
  process.exit(main(process.argv));
}
