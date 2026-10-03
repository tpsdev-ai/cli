/** cli#475: Node’s default symlink resolution broke entry checks; compare canonical paths. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../../../scripts/test-suite.mjs";

const FIXTURE = 'import { test, expect } from "bun:test";\ntest("runs through a symlink", () => { expect(1).toBe(1); });\n';

describe("test-suite.mjs entry point through a symlinked path (cli#475)", () => {
  for (const nodeFlags of [[], ["--preserve-symlinks-main"]]) {
    test(`a symlinked launcher executes tests (${nodeFlags.join(" ") || "default"})`, () => {
      const root = mkdtempSync(join(tmpdir(), "cli475-entry-"));
      const home = mkdtempSync(join(tmpdir(), "cli475-home-"));
      const reportDir = join(root, "reports");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(root, "fixture.test.ts"), FIXTURE);
      symlinkSync(REPO, join(root, "repo-link"), "dir");
      const viaLink = join(root, "repo-link", "scripts", "test-suite.mjs");
      try {
        const res = spawnSync("node", [...nodeFlags, viaLink, "fixture", "./fixture.test.ts"], {
          cwd: root,
          env: { ...process.env, TPS_TEST_REPORT_DIR: reportDir, HOME: home },
          encoding: "utf8",
          timeout: 120_000,
        });
        expect(res.error).toBeUndefined();
        expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
        const report = join(reportDir, "fixture.xml");
        expect(existsSync(report), `${res.stdout}\n${res.stderr}`).toBe(true);
        expect(readFileSync(report, "utf8")).toContain("fixture.test.ts");
        expect(`${res.stdout}${res.stderr}`).toMatch(/1 pass/);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 180_000);

    test(`a symlinked guard prints coverage (${nodeFlags.join(" ") || "default"})`, () => {
      const root = mkdtempSync(join(tmpdir(), "cli475-guard-"));
      const home = mkdtempSync(join(tmpdir(), "cli475-guard-home-"));
      const reportDir = join(root, "reports");
      mkdirSync(reportDir, { recursive: true });
      symlinkSync(REPO, join(root, "repo-link"), "dir");
      const viaLink = join(root, "repo-link", "scripts", "check-test-reports.mjs");
      try {
        const res = spawnSync("node", [...nodeFlags, viaLink], {
          cwd: root,
          env: { ...process.env, TPS_TEST_REPORT_DIR: reportDir, HOME: home },
          encoding: "utf8",
          timeout: 120_000,
        });
        expect(res.error).toBeUndefined();
        expect(res.stdout ?? "", `${res.stderr}`).toContain("test coverage (cli#411):");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
