/**
 * The shared macOS identity probe used by branch daemon cleanup: a probe that
 * does not answer within its bound is "identity could not be verified", and a
 * stdout path outside the test root is not this test's daemon.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeStdoutUnderRoot, runBounded, stdoutUnderRoot } from "./helpers/branch-daemon-identity.js";

describe("branch daemon identity probe (cli#752)", () => {
  test("a timed-out or failed probe is not a verified identity", () => {
    expect(probeStdoutUnderRoot(1, tmpdir(), () => ({ status: null, stdout: "" }))).toBe("unverified");
    expect(probeStdoutUnderRoot(1, tmpdir(), () => ({ status: 1, stdout: "" }))).toBe("unverified");
  });

  test("a bounded probe returns after its deadline instead of waiting for a command that outlives it", () => {
    const started = Date.now();
    const result = runBounded("sleep", ["60"], 100);
    expect(result.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("only stdout inside the test root verifies the daemon", () => {
    const root = mkdtempSync(join(tmpdir(), "tps-branch-identity-"));
    const outside = mkdtempSync(join(tmpdir(), "tps-branch-identity-outside-"));
    try {
      const inside = join(root, "stdout.log");
      const elsewhere = join(outside, "stdout.log");
      writeFileSync(inside, "");
      writeFileSync(elsewhere, "");
      expect(stdoutUnderRoot(1, root, () => ({ status: 0, stdout: `p1\nn${inside}\n` }))).toBe(true);
      expect(stdoutUnderRoot(1, root, () => ({ status: 0, stdout: `p1\nn${elsewhere}\n` }))).toBe(false);
      expect(probeStdoutUnderRoot(1, root, () => ({ status: 0, stdout: `p1\nn${elsewhere}\n` }))).toBe("other");
      expect(stdoutUnderRoot(1, root, () => ({ status: 1, stdout: "" }))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);
});
