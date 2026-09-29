/**
 * launcher.test.ts — scripts/run-tests.mjs fails a run that exits 0 without
 * its JUnit report. With the DEFAULT reporter a missing report is a failure
 * (exit 1, one-line reason, no seal); a caller-supplied --reporter is the only
 * accepted reason for no report. `bun` is replaced by a fake on PATH, and the
 * nested launcher writes to its own report directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_TEST_TIMEOUT_MS = 120_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-launcher-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run the launcher with a fake bun that exits `exit` and writes the report
 *  only when `write` is set. */
function launch(opts: { exit: number; write: boolean; args?: string[] }) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "bun");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'for a in "$@"; do',
      '  case "$a" in --reporter-outfile=*) [ "$FAKE_BUN_WRITE" = 1 ] && printf "<testsuites></testsuites>" > "${a#--reporter-outfile=}";; esac',
      "done",
      'exit "${FAKE_BUN_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const reports = join(root, "reports");
  const res = spawnSync(process.env.TPS_LANE_NODE || "node", [join(pluginDir, "scripts", "run-tests.mjs"), ...(opts.args ?? [])], {
    cwd: pluginDir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: root,
      TPS_TEST_REPORT_DIR: reports,
      FAKE_BUN_EXIT: String(opts.exit),
      FAKE_BUN_WRITE: opts.write ? "1" : "0",
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
