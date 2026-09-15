/**
 * cli#341 S1a — the launch-path control.
 *
 *   T2 = the env bypass is gone: `TPS_FORCE_NO_NONO=1` no longer turns the control
 *        off, and `--no-sandbox` is refused outside an interactive TTY.
 *   T3 = a generated unit that dropped `--sandbox-required` is refused by the
 *        launcher in a non-TTY context.
 *   T4 = the KeepAlive clause: generated agent units use `{SuccessfulExit:false}`
 *        ONLY together with "the launcher logs the refusal and exits 0".
 *
 * The launcher cases spawn the real built binary (`dist/bin/tps.js`) with piped
 * stdio — a non-TTY context — so they exercise the same path launchd would.
 * Flag/env literals are duplicated here on purpose: these tests must fail on
 * `main` (where none of this exists) as well as pass on the branch.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildPlist } from "../src/commands/mail-watch.js";
import { generateOfficePlist, generateTunnelPlist } from "../src/commands/office-supervision.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const SANDBOX_REQUIRED = "--sandbox-required";
const NO_SANDBOX = "--no-sandbox";
const SUPERVISED = "TPS_SUPERVISED";

/** Run the built launcher with piped stdio (stdin/stdout are NOT a TTY). */
function runLauncher(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", [TPS_BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function output(r: { stdout?: string | null; stderr?: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

beforeAll(() => {
  if (!existsSync(TPS_BIN)) {
    throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
  }
});

// ---------------------------------------------------------------------------
// T2 — env bypass removed; --no-sandbox is interactive-TTY-only
// ---------------------------------------------------------------------------

describe("T2 — env bypass gone / --no-sandbox is TTY-only", () => {
  test("TPS_FORCE_NO_NONO=1 cannot rescue a non-TTY --no-sandbox (refused, exit 78)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost", NO_SANDBOX, SANDBOX_REQUIRED], {
      TPS_FORCE_NO_NONO: "1",
    });
    const out = output(r).toLowerCase();
    expect(out).toContain(NO_SANDBOX);
    expect(out).toContain("interactive tty");
    expect(r.status).toBe(78);
  });
});

// ---------------------------------------------------------------------------
// T3 — a generated unit missing --sandbox-required is refused in non-TTY
// ---------------------------------------------------------------------------

describe("T3 — missing --sandbox-required is refused in non-TTY", () => {
  test("agent launcher without the flag is refused (names the flag, exit 78)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost"]);
    const out = output(r);
    expect(out).toContain(SANDBOX_REQUIRED);
    expect(r.status).toBe(78);
  });

  test("the same invocation WITH the flag is not refused for that reason (reaches config check)", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost", SANDBOX_REQUIRED]);
    const out = output(r);
    expect(out).not.toContain(`${SANDBOX_REQUIRED} is required`);
    expect(r.status).toBe(1); // config not found → the control let it through
  });
});

// ---------------------------------------------------------------------------
// T4 — KeepAlive coupling on the generated units + exit-0-on-refusal
// ---------------------------------------------------------------------------

describe("T4 — KeepAlive {SuccessfulExit:false} only with exit-0-on-refusal", () => {
  test("mail-watch unit asserts the flag, marks itself supervised, and couples KeepAlive", () => {
    const xml = buildPlist("test-agent", "/usr/local/bin/tps.js", []);
    expect(xml).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(xml).not.toContain("<key>Crashed</key>");
    expect(xml).toContain(`<string>${SANDBOX_REQUIRED}</string>`);
    expect(xml).toMatch(/<key>TPS_SUPERVISED<\/key>\s*<string>1<\/string>/);
    expect(xml).toContain("logs the refusal and exits 0");
  });

  test("office unit couples KeepAlive; the tunnel unit stays bare KeepAlive:true", () => {
    const office = generateOfficePlist({ name: "s1a", home: "/tmp/s1a-home" });
    expect(office).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(office).toContain(`<string>${SANDBOX_REQUIRED}</string>`);
    expect(office).toMatch(/<key>TPS_SUPERVISED<\/key>\s*<string>1<\/string>/);

    const tunnel = generateTunnelPlist({
      name: "s1a",
      localPort: 33700,
      tunnelVia: "host",
      home: "/tmp/s1a-home",
    });
    expect(tunnel).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(tunnel).not.toContain("SuccessfulExit");
  });

  test("exit-0-on-refusal: a supervised refusal exits 0, so {SuccessfulExit:false} cannot storm", () => {
    const r = runLauncher(["agent", "start", "--id", "ghost"], { [SUPERVISED]: "1" });
    expect(output(r)).toContain(SANDBOX_REQUIRED);
    expect(r.status).toBe(0);
  });
});
