/**
 * launcher.test.ts — scripts/run-tests.mjs fails a run that exits 0 without
 * its JUnit report. With the DEFAULT reporter a missing report is a failure
 * (exit 1, one-line reason, no seal); a caller-supplied --reporter is the only
 * accepted reason for no report. `bun` is replaced by a fake on PATH, and the
 * nested launcher writes to its own report directory.
 *
 * Its build gate, on a copy of the layout the launcher needs with no TypeScript
 * compiler: the build is skipped when neither node_modules/ nor dist/ exists,
 * and the run is refused when either exists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_TEST_TIMEOUT_MS = 120_000;

let root: string;
beforeEach(() => {
  // realpath'd: the launcher names its own directory by its resolved path.
  root = realpathSync(mkdtempSync(join(tmpdir(), "gr-launcher-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run the launcher with a fake bun on PATH that exits `exit` and writes the
 *  report only when `write` is set. The fake carries that behaviour in its own
 *  bytes: the launcher drops inherited variables that are not on its
 *  allowlist. */
function launch(opts: { exit: number; write: boolean; args?: string[]; plugin?: string }) {
  const plugin = opts.plugin ?? pluginDir;
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "bun");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      ...(opts.write
        ? [
            'for a in "$@"; do',
            '  case "$a" in --reporter-outfile=*) printf "<testsuites></testsuites>" > "${a#--reporter-outfile=}";; esac',
            "done",
          ]
        : []),
      `exit ${opts.exit}`,
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const reports = join(root, "reports");
  // A HOME of its own, outside its temp dir: this launcher treats a temp dir
  // inside the HOME it runs under as a destination it will not use.
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const res = spawnSync(process.env.TPS_LANE_NODE || "node", [join(plugin, "scripts", "run-tests.mjs"), ...(opts.args ?? [])], {
    cwd: plugin,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: root,
      TPS_TEST_REPORT_DIR: reports,
    },
    encoding: "utf8",
    timeout: LAUNCHER_TEST_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return { res, xml: join(reports, "github-review.xml"), seal: join(reports, "github-review.xml.sha256") };
}

describe("the isolated launcher and its report", () => {
  test("DEFAULT reporter, bun exits 0 but writes NO report → the launcher exits 1 with a one-line reason, and writes no seal", () => {
    const { res, seal } = launch({ exit: 0, write: false });
    expect(res.status).toBe(1);
    const reasons = res.stderr.split("\n").filter((l) => l.includes("wrote no report"));
    expect(reasons.length).toBe(1);
    expect(existsSync(seal)).toBe(false);
  }, LAUNCHER_TEST_TIMEOUT_MS);

  test("control: DEFAULT reporter, bun exits 0 and writes the report → exit 0, sealed", () => {
    const { res, xml, seal } = launch({ exit: 0, write: true });
    expect(res.status).toBe(0);
    expect(existsSync(xml)).toBe(true);
    expect(existsSync(seal)).toBe(true);
  }, LAUNCHER_TEST_TIMEOUT_MS);

  test("a caller-supplied --reporter is the one accepted reason for no report → exit 0", () => {
    const { res } = launch({ exit: 0, write: false, args: ["--reporter=dots", "test/"] });
    expect(res.status).toBe(0);
  }, LAUNCHER_TEST_TIMEOUT_MS);

  test("a failing bun run keeps its own exit code", () => {
    const { res } = launch({ exit: 3, write: false });
    expect(res.status).toBe(3);
  }, LAUNCHER_TEST_TIMEOUT_MS);
});

/**
 * A copy of what the launcher needs from the repo — scripts/test-home-guard.mjs
 * and this plugin's scripts/run-tests.mjs — with no TypeScript compiler, and
 * with the plugin's node_modules/ (a package, but no typescript) and dist/ (a
 * directory without dist/src/index.js) when asked. Returns the copied plugin
 * directory.
 */
function layoutWithoutCompiler(opts: { nodeModules: boolean; dist: boolean }): string {
  const repo = join(root, "repo");
  const plugin = join(repo, "plugins", "openclaw-github-review");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  copyFileSync(resolve(pluginDir, "..", "..", "scripts", "test-home-guard.mjs"), join(repo, "scripts", "test-home-guard.mjs"));
  copyFileSync(join(pluginDir, "scripts", "run-tests.mjs"), join(plugin, "scripts", "run-tests.mjs"));
  if (opts.nodeModules) {
    mkdirSync(join(plugin, "node_modules", "openclaw"), { recursive: true });
    writeFileSync(join(plugin, "node_modules", "openclaw", "package.json"), "{}");
  }
  if (opts.dist) mkdirSync(join(plugin, "dist"));
  return plugin;
}

/** The throwaway roots a launcher created in its temp dir (`root`). */
const isolatedRoots = () => readdirSync(root).filter((name) => name.startsWith("tps-"));

describe("the launcher's build gate, with no TypeScript compiler", () => {
  test("neither node_modules/ nor dist/ → the build is skipped and the suite runs", () => {
    const plugin = layoutWithoutCompiler({ nodeModules: false, dist: false });
    const { res, xml } = launch({ exit: 0, write: true, plugin });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("running the requested tests without a build");
    expect(existsSync(xml)).toBe(true); // the fake bun ran and wrote the report
  }, LAUNCHER_TEST_TIMEOUT_MS);

  for (const [present, layout] of [
    ["node_modules/", { nodeModules: true, dist: false }],
    ["dist/", { nodeModules: false, dist: true }],
  ] as const) {
    test(`${present} present but no tsc → refused before the suite runs, naming the missing compiler`, () => {
      const plugin = layoutWithoutCompiler(layout);
      const { res, xml, seal } = launch({ exit: 0, write: true, plugin });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("refusing to run the suite");
      expect(res.stderr).toContain(`${join(plugin, "node_modules", "typescript", "bin", "tsc")} is missing`);
      expect(res.stderr).toContain(`but ${join(plugin, present.slice(0, -1))} exists`);
      expect(res.stderr).not.toContain("without a build");
      expect(existsSync(xml)).toBe(false); // the fake bun did not run
      expect(existsSync(seal)).toBe(false);
      expect(isolatedRoots()).toEqual([]); // refused before the throwaway root was made
    }, LAUNCHER_TEST_TIMEOUT_MS);
  }
});
