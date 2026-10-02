/**
 * cli#475 — scripts/test-suite.mjs must run when started through a symlinked
 * path.
 *
 * The launcher ran main() only when `pathToFileURL(process.argv[1]).href`
 * equalled `import.meta.url`. `import.meta.url` is resolved through symlinks
 * while argv[1] keeps the path it was invoked with, so through a symlinked path
 * (on macOS `/var/...` is a symlink to `/private/var/...`) the comparison was
 * false and the script exited 0 having run no tests. A runner that can pass
 * having run nothing is a check that cannot fire.
 *
 * This drives the real launcher through a symlink to its own directory and
 * asserts the run executed the fixture's test — a report naming it — not merely
 * that the process exited 0.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../../../scripts/test-suite.mjs";

const FIXTURE = 'import { test, expect } from "bun:test";\ntest("runs through a symlink", () => { expect(1).toBe(1); });\n';

describe("test-suite.mjs entry point through a symlinked path (cli#475)", () => {
  test("a run started through a symlink executes the suite's tests", () => {
    const root = mkdtempSync(join(tmpdir(), "cli475-entry-"));
    const home = mkdtempSync(join(tmpdir(), "cli475-home-"));
    const reportDir = join(root, "reports");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(root, "fixture.test.ts"), FIXTURE);
    // A symlink to the launcher's directory: argv[1] keeps this path, while
    // import.meta.url inside the module resolves to the real one.
    symlinkSync(join(REPO, "scripts"), join(root, "scripts-link"), "dir");
    const viaLink = join(root, "scripts-link", "test-suite.mjs");
    try {
      // Under node: import.meta.url is resolved through the symlink while
      // argv[1] keeps the invoked path, which is the comparison the bug is in.
      const res = spawnSync("node", [viaLink, "fixture", "./fixture.test.ts"], {
        cwd: root,
        env: { ...process.env, TPS_TEST_REPORT_DIR: reportDir, HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(res.error).toBeUndefined();
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
      // The point of the fix: the suite RAN. The report names the executed file
      // and the output carries its pass count — not the launcher's exit code only.
      const report = join(reportDir, "fixture.xml");
      expect(existsSync(report), `${res.stdout}\n${res.stderr}`).toBe(true);
      expect(readFileSync(report, "utf8")).toContain("fixture.test.ts");
      expect(`${res.stdout}${res.stderr}`).toMatch(/1 pass/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  test("scripts/check-test-reports.mjs runs through a symlinked path too", () => {
    const root = mkdtempSync(join(tmpdir(), "cli475-guard-"));
    const home = mkdtempSync(join(tmpdir(), "cli475-guard-home-"));
    const reportDir = join(root, "reports");
    mkdirSync(reportDir, { recursive: true });
    symlinkSync(join(REPO, "scripts"), join(root, "scripts-link"), "dir");
    const viaLink = join(root, "scripts-link", "check-test-reports.mjs");
    try {
      const res = spawnSync("node", [viaLink], {
        cwd: root,
        env: { ...process.env, TPS_TEST_REPORT_DIR: reportDir, HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(res.error).toBeUndefined();
      // A guard that exits 0 having printed nothing is the failure this test is
      // for; its report header is printed whatever the reports say.
      expect(res.stdout ?? "", `${res.stderr}`).toContain("test coverage (cli#411):");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
