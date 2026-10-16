import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { assertListenerAddresses, assertRealFlairReport, EXPECTED_CASES } from "../../../scripts/real-flair-lane.js";
import { waitForOk, withScratchFlair, type ScratchFlair, type ScratchProcess } from "./helpers/scratch-flair.js";

const repo = resolve(import.meta.dir, "../../..");
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const report = () => `<testsuites>${Object.entries(EXPECTED_CASES).flatMap(([file, names]) => names.map((name) =>
  `<testcase file="test/${file}" name="${escape(name)}" time="0.1"/>`,
)).join("")}</testsuites>`;

test("the lane requires each named case in the fresh JUnit report to pass without skips", () => {
  expect(() => assertRealFlairReport(report())).not.toThrow();
  for (const [file, names] of Object.entries(EXPECTED_CASES)) {
    for (const name of names) {
      const entry = `<testcase file="test/${file}" name="${escape(name)}" time="0.1"/>`;
      for (const replacement of ["", entry.replace("/>", "><skipped/></testcase>"), entry.replace("/>", "><failure/></testcase>"), entry + entry]) {
        expect(() => assertRealFlairReport(report().replace(entry, replacement))).toThrow("expected a passed, unskipped case");
      }
    }
  }
  expect(() => assertRealFlairReport("")).toThrow();
});

test("the listener assertion rejects wildcard, external and missing binds", () => {
  expect(() => assertListenerAddresses(42000, ["127.0.0.1:42000"])).not.toThrow();
  for (const addresses of [[], ["*:42000"], ["0.0.0.0:42000"], ["[::]:42000"], ["192.0.2.1:42000"], ["127.0.0.1:42000", "*:42000"]]) {
    expect(() => assertListenerAddresses(42000, addresses)).toThrow();
  }
});

test("the workflow paths cover mail, identity, mail verification and lane inputs", () => {
  const workflow = load(readFileSync(resolve(repo, ".github/workflows/real-flair.yml"), "utf8")) as {
    on: { pull_request: { paths: string[] } };
  };
  const globs = workflow.on.pull_request.paths.map((path) => new Bun.Glob(path));
  for (const path of [
    "packages/cli/src/utils/mail.ts", "packages/cli/src/utils/identity.ts", "packages/cli/src/utils/mail-verify.ts",
    "packages/agent/src/io/mail.ts", "packages/cli/test/helpers/scratch-flair.ts", "scripts/real-flair-lane.ts",
    "packages/cli/test/real-flair-lane.test.ts", ".github/workflows/real-flair.yml", "package.json", "bun.lock",
    ...Object.keys(EXPECTED_CASES).map((file) => `packages/cli/test/${file}`),
  ]) {
    expect(globs.some((glob) => glob.match(path))).toBe(true);
  }
});

for (const stage of ["install", "setup", "seed", "test"] as const) {
  test(`scratch ownership removes its root after an injected ${stage} error`, async () => {
    let root = "";
    let child: ChildProcess | undefined;
    const failure = new Error(`injected ${stage} failure`);
    const initialize = async (instance: ScratchProcess): Promise<ScratchFlair & ScratchProcess> => {
      root = instance.root;
      expect(existsSync(root)).toBe(true);
      if (stage === "install" || stage === "setup") throw failure;
      child = instance.proc = spawn("node", ["-e", "setInterval(() => {}, 1000)", root], { stdio: "ignore" });
      await new Promise<void>((done, reject) => { child?.once("spawn", done); child?.once("error", reject); });
      if (stage === "seed") throw failure;
      return instance as ScratchFlair & ScratchProcess;
    };
    await expect(withScratchFlair(async () => { throw failure; }, initialize)).rejects.toThrow(failure.message);
    expect(existsSync(root)).toBe(false);
    if (child?.pid) expect(() => process.kill(child.pid as number, 0)).toThrow();
  }, 15_000);
}

test("a stalled health request is aborted at its deadline", async () => {
  let aborted = false;
  const restore = patchShared(globalThis, "fetch", ((_url: unknown, init: RequestInit) => new Promise((_done, reject) => {
    init.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal?.reason); }, { once: true });
  })) as typeof fetch);
  try {
    expect(await waitForOk("http://127.0.0.1:1/Health", Date.now() + 30)).toBe(false);
    expect(aborted).toBe(true);
  } finally {
    restore();
  }
});

test("omitting flag forwarding produces a skipped JUnit report that the lane rejects", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-flag-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "tmp"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), TPS_TEST_REPORT_DIR: join(root, "reports") };
  delete env.TPS_TEST_REAL_FLAIR;
  try {
    const names = Object.values(EXPECTED_CASES).flat().map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const run = spawnSync("node", [join(repo, "scripts/test-suite.mjs"), "missing-flag",
      ...Object.keys(EXPECTED_CASES).map((file) => `./test/${file}`), `--test-name-pattern=${names}`,
    ], { cwd: join(repo, "packages/cli"), env, encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    expect(run.status).toBe(0);
    const xml = readFileSync(join(root, "reports/missing-flag.xml"), "utf8");
    expect(xml).toContain("<skipped");
    expect(() => assertRealFlairReport(xml)).toThrow("expected a passed, unskipped case");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("an npm installation error removes the scratch root", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-npm-"));
  const originalPath = process.env.PATH;
  const marker = join(root, "prefix");
  const quoted = "'" + marker.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(root, "npm"), `#!/bin/sh\nprintf '%s' "$3" > ${quoted}\nexit 42\n`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath}`;
  try {
    await expect(withScratchFlair(async () => {})).rejects.toThrow();
    const prefix = readFileSync(marker, "utf8");
    expect(existsSync(dirname(prefix))).toBe(false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});
