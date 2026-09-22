/**
 * isolation.test.ts — the POSITIVE containment fixture for the launcher
 * (cli#398 round 2, item 1c).
 *
 * Run through the launcher (scripts/run-tests.mjs, i.e. `bun run test`), the
 * escaping sinks resolve inside the throwaway root: os.homedir() and the
 * outbox root are inside TPS_TEST_ROOT, and TPS_MAIL_DIR (the CLI archive /
 * branch-office root) is inside it too. Run WITHOUT the launcher this file
 * never executes — the bun test preload (test/preload-guard.ts) aborts the
 * whole run before any module loads.
 */
import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const ROOT = realpathSync(process.env.TPS_TEST_ROOT ?? "");
const inside = (p: string): boolean => p === ROOT || p.startsWith(ROOT + sep);

/** Realpath a path that the launcher created, so a symlinked tmpdir counts. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

describe("launcher isolation (cli#398 round 2)", () => {
  it("os.homedir() and process.env.HOME resolve inside the isolated test root", () => {
    expect(ROOT.length).toBeGreaterThan(0);
    expect(inside(realpathOrSelf(homedir()))).toBe(true);
    expect(inside(realpathOrSelf(process.env.HOME ?? ""))).toBe(true);
  });

  it("TPS_MAIL_DIR and the ~/.tps outbox root resolve inside the isolated test root", () => {
    // Both are launch-time values the launcher sets; if either escapes, the
    // suite would write into the LIVE outbox / archive.
    expect(inside(realpathOrSelf(process.env.TPS_MAIL_DIR ?? ""))).toBe(true);
    expect(inside(resolve(homedir(), ".tps", "outbox"))).toBe(true);
  });
});
