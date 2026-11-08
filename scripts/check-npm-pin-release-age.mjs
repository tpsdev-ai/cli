#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { thresholdFromInstallTable } from "./lib/check-dep-ages-collect.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const WORKFLOW_REL = join(".github", "workflows", "release.yml");
const UPGRADE_STEP = "Upgrade npm to an OIDC/staging-capable version";
const EXACT_PIN = /^npm install -g npm@(\d+\.\d+\.\d+) --registry=(\S+)$/;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function namedError(name, message) {
  return Object.assign(new Error(message), { name });
}

function bunYaml() {
  const parse = globalThis.Bun?.YAML?.parse;
  if (typeof parse !== "function") {
    throw namedError(
      "BunYAMLUnavailable",
      "release.yml requires Bun.YAML.parse; run with bun --no-install",
    );
  }
  return parse;
}

export function readNpmPin(workflowText) {
  let workflow;
  try {
    workflow = bunYaml()(workflowText);
  } catch (error) {
    throw namedError(
      "UnreadableWorkflow",
      `release.yml is not parsable: ${error instanceof Error ? error.message : error}`,
    );
  }
  const steps = workflow?.jobs?.["publish-packages"]?.steps;
  if (!Array.isArray(steps)) {
    throw namedError(
      "UnpinnedNpmVersion",
      "release.yml has no publish-packages steps to read the npm pin from",
    );
  }
  const upgrades = steps.filter((step) => step?.name === UPGRADE_STEP);
  if (upgrades.length !== 1) {
    throw namedError(
      "UnpinnedNpmVersion",
      `expected exactly one "${UPGRADE_STEP}" step, found ${upgrades.length}`,
    );
  }
  const upgrade = upgrades[0];
  for (const key of ["if", "continue-on-error"]) {
    if (Object.hasOwn(upgrade, key)) {
      throw namedError("UnpinnedNpmVersion", `"${UPGRADE_STEP}" must not set "${key}"`);
    }
  }
  const run = typeof upgrade.run === "string" ? upgrade.run.trim() : "";
  const match = EXACT_PIN.exec(run);
  if (!match || match[2] !== DEFAULT_REGISTRY) {
    throw namedError(
      "UnpinnedNpmVersion",
      `"${UPGRADE_STEP}" must run exactly npm install -g npm@<x.y.z> --registry=${DEFAULT_REGISTRY}; found ${run}`,
    );
  }
  return match[1];
}

export async function checkNpmPinReleaseAge(options = {}) {
  const {
    root = join(dirname(fileURLToPath(import.meta.url)), ".."),
    workflowPath = join(root, WORKFLOW_REL),
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    timeoutMs = 15_000,
  } = options;
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`timeoutMs must be a positive integer: ${timeoutMs}`);
  }
  let install;
  try {
    install = Bun.TOML.parse(readFileSync(join(root, "bunfig.toml"), "utf8")).install;
  } catch (error) {
    throw namedError("UnreadablePolicy", `cannot read bunfig.toml: ${error.message}`);
  }
  const { seconds, error } = thresholdFromInstallTable(install);
  if (error !== null) throw namedError("InvalidReleaseAgePolicy", `bunfig.toml: ${error}`);
  const bakeMs = seconds * 1000;
  const bakeDays = seconds / 86_400;

  const pin = readNpmPin(readFileSync(workflowPath, "utf8"));
  const base = DEFAULT_REGISTRY;
  let metadata;
  try {
    const response = await fetchImpl(`${base}/npm`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    metadata = await response.json();
  } catch (error) {
    throw namedError(
      "PublishTimeLookupFailed",
      `registry lookup failed for npm: ${error instanceof Error ? error.message : error}`,
    );
  }

  const published = metadata?.time?.[pin];
  const publishedMs =
    typeof published === "string" && UTC_TIMESTAMP.test(published)
      ? Date.parse(published)
      : Number.NaN;
  if (
    !Number.isFinite(publishedMs) ||
    new Date(publishedMs).toISOString() !== published.replace(/(:\d{2})Z$/, "$1.000Z")
  ) {
    return {
      ok: false,
      pin,
      publishedAt: null,
      ageMs: null,
      bakeMs,
      reason: `npm@${pin} — no publish time or invalid UTC timestamp in the registry metadata: ${JSON.stringify(published)}`,
    };
  }
  const ageMs = now - publishedMs;
  if (ageMs < bakeMs) {
    const ageDays = (ageMs / 86_400_000).toFixed(1);
    return {
      ok: false,
      pin,
      publishedAt: published,
      ageMs,
      bakeMs,
      reason: `npm@${pin} — published ${published} (${ageDays} days ago; bake: ${bakeDays} days)`,
    };
  }
  return { ok: true, pin, publishedAt: published, ageMs, bakeMs, reason: "" };
}

async function main() {
  let result;
  try {
    const { values } = parseArgs({
      options: { "timeout-ms": { type: "string" } },
    });
    result = await checkNpmPinReleaseAge({
      timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
    });
  } catch (error) {
    console.error(
      `npm pin release-age check could not run: ${error instanceof Error ? `${error.name}: ${error.message}` : error}`,
    );
    process.exit(2);
  }

  if (!result.ok) {
    console.error(`npm pin is not old enough for the release-age bake: ${result.reason}`);
    process.exit(1);
  }
  console.log(
    `The pinned npm@${result.pin} meets the ${result.bakeMs / 86_400_000}-day minimum release age (published ${result.publishedAt}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
