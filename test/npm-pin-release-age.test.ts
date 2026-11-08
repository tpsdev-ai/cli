import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNpmPinReleaseAge, readNpmPin } from "../scripts/check-npm-pin-release-age.mjs";

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github/workflows/release.yml");
const CLI = join(REPO, "scripts/check-npm-pin-release-age.mjs");
const INSTALL = "npm install -g npm@11.21.1 --registry=https://registry.npmjs.org";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const POLICY = Bun.TOML.parse(readFileSync(join(REPO, "bunfig.toml"), "utf8")).install.minimumReleaseAge;
const CUTOFF = new Date(NOW - POLICY * 1000).toISOString();
const YOUNG = new Date(NOW - POLICY * 1000 + 1).toISOString();

function lookup(published: unknown) {
  return async () => Response.json({ time: { "11.21.1": published } });
}

test("the parser reads the exact pin and checked registry", () => {
  expect(readNpmPin(readFileSync(WORKFLOW, "utf8"))).toBe("11.21.1");
});

test.each([
  "npm install -g npm@^11.15.0 --registry=https://registry.npmjs.org",
  "npm install -g npm@11.21.1",
  "npm install -g npm@11.21.1 --registry=https://registry.example",
  `${INSTALL} --ignore-scripts`,
  `${INSTALL} --registry=https://registry.example`,
])("UnpinnedNpmVersion: refuses %s", (command) => {
  const workflow = readFileSync(WORKFLOW, "utf8").replace(INSTALL, command);
  expect(() => readNpmPin(workflow)).toThrow(expect.objectContaining({
    name: "UnpinnedNpmVersion",
    message: expect.stringContaining("must run exactly npm install -g npm@<x.y.z> --registry=https://registry.npmjs.org"),
  }));
});

test("a pin published at the policy cutoff passes", async () => {
  const requests: string[] = [];
  const result = await checkNpmPinReleaseAge({
    now: NOW,
    fetchImpl: async (url: string, options: RequestInit) => {
      requests.push(url);
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return lookup(CUTOFF)();
    },
  });
  expect(result).toMatchObject({ ok: true, pin: "11.21.1", bakeMs: POLICY * 1000 });
  expect(requests).toEqual(["https://registry.npmjs.org/npm"]);
});

test("a too-young pin is refused by version and policy", async () => {
  const result = await checkNpmPinReleaseAge({ now: NOW, fetchImpl: lookup(YOUNG) });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("npm@11.21.1");
  expect(result.reason).toContain(`bake: ${POLICY / 86400} days`);
});

test.each([undefined, "2020", "2026-02-30T00:00:00.000Z", "2020-01-01T24:00:00Z", 2020])(
  "missing or invalid publish time %j is refused by version",
  async (published) => {
    const result = await checkNpmPinReleaseAge({ now: NOW, fetchImpl: lookup(published) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("npm@11.21.1");
    expect(result.reason).toContain("no publish time or invalid UTC timestamp");
  },
);

test.each([
  async () => { throw new Error("unreadable registry"); },
  async () => new Response("unavailable", { status: 503 }),
  async () => new Response("not JSON"),
])("PublishTimeLookupFailed: refuses an unreadable registry %#", async (fetchImpl) => {
  await expect(checkNpmPinReleaseAge({ now: NOW, fetchImpl })).rejects.toMatchObject({
    name: "PublishTimeLookupFailed",
    message: expect.stringContaining("registry lookup failed for npm"),
  });
});

test("the workflow pin and bunfig policy are read from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-npm-policy-"));
  try {
    const workflowPath = join(root, "release.yml");
    writeFileSync(workflowPath, readFileSync(WORKFLOW, "utf8").replace(INSTALL, INSTALL.replace("11.21.1", "11.99.0")));
    writeFileSync(join(root, "bunfig.toml"), `[install]\nminimumReleaseAge = ${POLICY * 2}\n`);
    const result = await checkNpmPinReleaseAge({
      root, workflowPath, now: NOW,
      fetchImpl: async () => Response.json({ time: { "11.99.0": CUTOFF } }),
    });
    expect(result).toMatchObject({ ok: false, pin: "11.99.0", bakeMs: POLICY * 2000 });
    writeFileSync(join(root, "bunfig.toml"), '[install]\nminimumReleaseAge = "604800"\n');
    await expect(checkNpmPinReleaseAge({ root, workflowPath })).rejects.toMatchObject({ name: "InvalidReleaseAgePolicy" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ["cutoff", CUTOFF, 0, "meets the"],
  ["too-young", YOUNG, 1, "npm@11.21.1"],
  ["unreadable", null, 2, "PublishTimeLookupFailed"],
] as const)("the CLI reports the %s verdict without network", (_name, published, status, message) => {
  const root = mkdtempSync(join(tmpdir(), "cli-npm-clock-"));
  try {
    const preload = join(root, "registry.mjs");
    writeFileSync(preload, `Date.now = () => Number(process.env.TPS_TEST_NPM_NOW);
    const published = JSON.parse(process.env.TPS_TEST_NPM_PUBLISHED);
    globalThis.fetch = async () => {
      if (published === null) throw new Error("unreadable registry");
      return Response.json({ time: { "11.21.1": published } });
    };\n`);
    const result = spawnSync("bun", ["--no-install", "--preload", preload, CLI], {
      cwd: REPO,
      env: { ...process.env, TPS_TEST_NPM_NOW: String(NOW), TPS_TEST_NPM_PUBLISHED: JSON.stringify(published) },
      encoding: "utf8", timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout + result.stderr).toContain(message);
    if (status !== 0) expect(result.stdout).not.toContain("meets the");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
