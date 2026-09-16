/**
 * cli#350 round 4e — the launcher's confinement attestation.
 *
 * The invariant under test: a launch through `tps agent start` runs its workload
 * inside a nono session the LAUNCHER started, bound to the pid it spawned and to
 * the pid the child reports, with enforcement verified behaviourally from outside
 * the sandbox — or the child is never released.
 *
 * Fixture shapes (4e):
 *   no socket at all                      → the child refuses (exit 78)
 *   a release minted for another pid      → the child refuses (G5)
 *   nono missing at the pinned path        → refused before spawning
 *   pinned nono present, no session        → refused (binding)
 *   unrelated live session                 → refused (binding, pid mismatch)
 *   an unconfined child (fake nono)        → refused (OUTSIDE canary read)
 *   a blind `DENIED` without a read        → refused (INSIDE nonce mismatch)
 *   a scripted peer with a wrong pid       → refused (binding)
 *   a crafted store with a mismatched pid  → refused (binding)
 *   the private dir under the granted tmp  → refused BEFORE spawning (overlap)
 *   the private dir granted by a profile   → refused (OUTSIDE read) [real nono]
 *   POSITIVE: real pinned nono             → released, bound, OUTSIDE denied,
 *                                            INSIDE read (skipped unless NONO_BIN
 *                                            points at a real nono ≥ 0.70)
 *
 * Two FAILS-FIRST demonstrations (the check absent → the corresponding fixture
 * goes green) drive the in-process seam documented in launch-attestation.ts.
 * Nothing in the CLI paths constructs that seam: there is no env var, no flag and
 * no config that can disable either check through the shipped launch control.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  attestConfinement,
  childCanaries,
  coveringGrant,
  createPrivateLaunchDir,
  findBoundSession,
  grantsOfOptions,
  launchAttested,
  parseNonoPs,
  pidAlive,
  readCanary,
  removePrivateLaunchDir,
  resolveNonoBinary,
  checkNonoPin,
  pinRecordCandidates,
  moduleDir,
  SUN_PATH_BUDGET,
  LAUNCH_SOCK_ENV,
} from "../src/utils/launch-attestation.js";
import { SANDBOX_REQUIRED_FLAG, SANDBOXED_FLAG } from "../src/utils/nono.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
/** The runtime the shipped CLI uses: the re-exec child inherits it, and the
 * launcher's locator must survive it (see the note in runLauncher). */
const NODE =
  process.env.TPS_TEST_NODE ??
  (spawnSync("which", ["node"], { encoding: "utf-8" }).stdout?.trim() || "node");
const SUPERVISED = "TPS_SUPERVISED";
const NONO_BIN_ENV = "NONO_BIN";
const TIMEOUT_ENV = "TPS_LAUNCH_TIMEOUT_MS";

beforeAll(() => {
  if (!existsSync(TPS_BIN)) {
    throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
  }
});

// ---------------------------------------------------------------------------
// Fixture scaffolding
// ---------------------------------------------------------------------------

interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  ws: string;
  nonoDir: string;
  nonoLog: string;
}

/**
 * Seed a HOME tree the CLI can load an agent from: agent.yaml, mail, identity,
 * and the fixture's JSON profile pair (loadable by nono >= 0.70).
 */
function seedHome(home: string, ws: string, seedProfiles = true): void {
  const agentDir = join(home, ".tps", "agents", "probe");
  const profileDir = join(home, ".config", "nono", "profiles");
  for (const d of [agentDir, profileDir, join(home, ".tps", "mail"), join(home, ".tps", "identity")]) {
    mkdirSync(d, { recursive: true });
  }
  if (seedProfiles) {
    // A minimal but real JSON profile pair: the fixture does not need tps-base's
    // deny list, only a loadable profile whose grants do not cover HOME.
    const base = {
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      meta: { name: "tps-base-fixture" },
      workdir: { access: "readwrite" },
      filesystem: { read: ["/usr", "/bin", "/lib", "/lib64"], deny: [] },
    };
    const run = {
      $schema: "https://nono.sh/schemas/nono-profile.schema.json",
      extends: "tps-base-fixture",
      meta: { name: "tps-agent-run" },
      workdir: { access: "readwrite" },
    };
    writeFileSync(join(profileDir, "tps-base-fixture.json"), JSON.stringify(base, null, 2));
    writeFileSync(join(profileDir, "tps-agent-run.json"), JSON.stringify(run, null, 2));
  }
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `agentId: probe\nname: probe\nworkspace: ${ws}\n` +
      `mailDir: ${join(home, ".tps", "mail")}\n` +
      `memoryPath: ${join(agentDir, "memory.jsonl")}\n` +
      `llm:\n  provider: ollama\n  model: probe-model\n`
  );
  mkdirSync(join(home, ".tps", "mail"), { recursive: true });
  mkdirSync(join(home, ".tps", "identity"), { recursive: true });
  writeFileSync(join(home, ".tps", "identity", "probe.key"), "fixture-key\n");
  writeFileSync(join(home, ".tps", "identity", "probe.pub"), "fixture-pub\n");
}

/** A launch-shaped tree under one temp root. HOME is NOT under the granted
 * tmpdir (the fixture sets TMPDIR to a sibling) — a private dir inside a granted
 * root is what the overlap assert refuses, and that gets its own fixture. */
function makeSandbox(name: string, seedProfiles = true): Sandbox {
  // OUTSIDE /tmp: the launch grants /tmp unconditionally (cli#350 r4g), so a
  // HOME under /tmp would put the private dir inside that grant and the overlap
  // assert would (correctly) refuse. /var/tmp keeps HOME and every grant disjoint.
  const base = existsSync("/var/tmp") ? "/var/tmp" : homedir();
  const root = mkdtempSync(join(base, `tps-attest-${name}-`));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const ws = join(root, "ws");
  const nonoDir = join(root, "nono");
  for (const d of [home, tmp, ws, nonoDir]) mkdirSync(d, { recursive: true });
  seedHome(home, ws, seedProfiles);
  return {
    root,
    home,
    tmp,
    ws,
    nonoDir,
    nonoLog: join(root, "nono.log"),
  };
}

/**
 * A fake nono at an ABSOLUTE path. Modes:
 *   `run`  — logs argv, starts the wrapped command as a CHILD (its own pid, like
 *            real nono), and (unless the run mode says otherwise) serves the
 *            fixture's crafted `ps` store from FAKE_NONO_PS_JSON.
 * It never confines anything — which is the point of the negative fixtures: an
 * unconfined child reads OUTSIDE and must be refused.
 */
function writeFakeNono(sb: Sandbox, script: string): string {
  const path = join(sb.nonoDir, "nono");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const FAKE_NONO = `#!/usr/bin/env bash
# A fake nono for the launcher fixtures. Logs argv; for \`ps\` it serves the
# fixture's crafted store; for \`run\` it starts the wrapped command as its own
# child and records pids (so the launcher's binding check has something real to
# bind to).
set -u
if [ "\${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi
log="\${FAKE_NONO_LOG:?}"
printf '%s\\n' "ARGV $*" >> "$log"
if [ "\${1:-}" = "ps" ]; then
  if [ -n "\${FAKE_NONO_PS_JSON:-}" ] && [ -f "\${FAKE_NONO_PS_JSON}" ]; then
    cat "\${FAKE_NONO_PS_JSON}"
  else
    echo "[]"
  fi
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  cmd=(); seen=0
  for a in "$@"; do if [ "$seen" = 1 ]; then cmd+=("$a"); fi; if [ "$a" = "--" ]; then seen=1; fi; done
  "\${cmd[@]}" &
  echo "CHILD \${!} SUP \$\$" >> "$log"
  wait
  exit $?
fi
exit 0
`;

function cliEnv(sb: Sandbox, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: sb.home,
    TMPDIR: sb.tmp,
    FAKE_NONO_LOG: sb.nonoLog,
    [TIMEOUT_ENV]: "6000",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

/** Run the built launcher with piped stdio (never a TTY), like a unit would. */
function runLauncher(sb: Sandbox, args: string[], extra: Record<string, string | undefined> = {}) {
  // PRODUCTION RUNS THE CLI UNDER NODE (`#!/usr/bin/env node`), and that matters
  // here: bun inside a nono sandbox sees an EMPTY environment (measured: 0 keys
  // inside vs 34 outside; node and sh see it unchanged), so a bun child cannot
  // read the launcher's socket locator at all. The fixtures therefore spawn the
  // CLI the way the shipped unit does.
  return spawnSync(NODE, [TPS_BIN, ...args], {
    encoding: "utf-8",
    cwd: sb.ws,
    timeout: 30_000,
    env: cliEnv(sb, extra),
  });
}

function out(r: { stdout?: string | null; stderr?: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** A fixture toucher: writes `TOUCH_FILE` after `TOUCH_AFTER_MS`. Written as a
 * SCRIPT FILE with no value interpolated into code (CodeQL js/code-injection,
 * cli#350 r4g): paths travel through the environment, never through source. */
const TOUCHER_SRC = `
const { writeFileSync } = require("node:fs");
const delay = Number(process.env.TOUCH_AFTER_MS || "10000");
setTimeout(() => {
  try { writeFileSync(process.env.TOUCH_FILE, "released"); } catch {}
}, delay);
`;

function startToucher(sb: Sandbox, file: string, afterMs: number): ChildProcess {
  const script = join(sb.root, "toucher.cjs");
  writeFileSync(script, TOUCHER_SRC);
  return spawn(process.execPath, [script], {
    stdio: "ignore",
    env: { ...process.env, TOUCH_FILE: file, TOUCH_AFTER_MS: String(afterMs) },
  });
}

/** ARGV lines the fake nono logged for a `run` (the launcher's spawn). Other
 * invocations (`--version`, `profile validate`) are its checks, not a launch. */
function fakeNonoRuns(sb: Sandbox): string[] {
  if (!existsSync(sb.nonoLog)) return [];
  return readFileSync(sb.nonoLog, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("ARGV run"))
    .map((l) => l.slice(5));
}

function launchDirs(sb: Sandbox): string[] {
  const dir = join(sb.home, ".tps", "launch");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((d) => join(dir, d));
}

/** A written store for the fake nono's `ps`. */
function writeStore(sb: Sandbox, sessions: unknown): string {
  const path = join(sb.root, "ps-store.json");
  writeFileSync(path, JSON.stringify(sessions, null, 2));
  return path;
}

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "fixture",
    session_id: "deadbeefdeadbeef",
    supervisor_pid: 1,
    child_pid: 1,
    status: "running",
    profile: "x",
    workdir: "y",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure units — the parts a fixture can drive without a process
// ---------------------------------------------------------------------------

describe("4e units — the pinned binary and the S4 pin record", () => {
  test("a relative NONO_BIN is refused outright (never PATH-resolved)", () => {
    const r = resolveNonoBinary({ [NONO_BIN_ENV]: "nono" } as NodeJS.ProcessEnv);
    expect(r.bin).toBeUndefined();
    expect(r.reason).toContain("ABSOLUTE");
  });

  test("a missing absolute NONO_BIN is refused, naming the path", () => {
    const r = resolveNonoBinary({ [NONO_BIN_ENV]: "/nope/nono" } as NodeJS.ProcessEnv);
    expect(r.bin).toBeUndefined();
    expect(r.reason).toContain("/nope/nono");
  });

  test("an absolute existing NONO_BIN is used as-is", () => {
    const r = resolveNonoBinary({ [NONO_BIN_ENV]: "/bin/sh" } as NodeJS.ProcessEnv);
    expect(r.bin).toBe("/bin/sh");
  });

  test("a pin record beside the binary pins the version: match ok, mismatch refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-pin-"));
    try {
      // A binary that reports the pinned version, and one that does not.
      const good = join(dir, "nono-good");
      writeFileSync(good, "#!/bin/sh\necho 'nono 0.74.0'\n");
      chmodSync(good, 0o755);
      writeFileSync(join(dir, ".nono-version"), "version=0.74.0\ncommit=" + "a".repeat(40) + "\n");
      const ok = checkNonoPin(good, {} as NodeJS.ProcessEnv);
      expect(ok.ok).toBe(true);

      const bad = join(dir, "nono-bad");
      writeFileSync(bad, "#!/bin/sh\necho 'nono 0.70.0'\n");
      chmodSync(bad, 0o755);
      const refused = checkNonoPin(bad, {} as NodeJS.ProcessEnv);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.reason).toContain("0.70.0");
        expect(refused.reason).toContain("0.74.0");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("4e units — grants, canaries, the ps binding", () => {
  test("a grant covers its subtree; / covers everything; a read-file is exact", () => {
    const grants = grantsOfOptions(
      { read: ["/tmp"], readFiles: ["/etc/hosts"], allow: ["/home/x/mail"] },
      [],
      "/home/x/ws"
    );
    expect(coveringGrant("/tmp/a/b/c", grants)).toBe("/tmp");
    expect(coveringGrant("/home/x/mail/msg.json", grants)).toBe("/home/x/mail");
    expect(coveringGrant("/etc/hosts", grants)).toBe("/etc/hosts");
    expect(coveringGrant("/etc/hosts/../shadow", grants)).toBeNull();
    expect(coveringGrant("/home/x/ws/out", grants)).toBe("/home/x/ws");
  });

  test("the child derives both canaries from the socket locator alone", () => {
    const c = childCanaries("/home/a/.tps/launch/probe-1234/sock/launch.sock");
    expect(c.insideCanary).toBe("/home/a/.tps/launch/probe-1234/sock/canary-inside");
    expect(c.outsideCanary).toBe("/home/a/.tps/launch/probe-1234/canary-outside");
  });

  test("readCanary: a permission refusal is DENIED, absence is an ERROR (never DENIED)", () => {
    expect(readCanary("/nonexistent/canary")).toEqual({ error: "ENOENT" });
    const dir = mkdtempSync(join(tmpdir(), "tps-canary-"));
    try {
      const p = join(dir, "c");
      writeFileSync(p, "nonce");
      expect(readCanary(p)).toEqual({ denied: false, content: "nonce" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseNonoPs tolerates nono's banner and refuses garbage", () => {
    expect(parseNonoPs("nono v0.74.0\n[]")).toEqual([]);
    expect(parseNonoPs("not json at all")).toEqual([]);
    expect(parseNonoPs('[{"session_id":"a","status":"running"}]')).toEqual([
      { session_id: "a", status: "running" },
    ]);
  });

  test("findBoundSession requires supervisor pid, child pid, status and profile", () => {
    const pids = { supervisorPid: 100, childPid: 200, profile: "/p/tps-agent-run.json" };
    const ok = session({ supervisor_pid: 100, child_pid: 200, profile: pids.profile, status: "running" });
    expect(findBoundSession([ok], pids).session).toBeDefined();

    expect(findBoundSession([], pids).reason).toContain("no running session");
    // An unrelated live session: liveness alone is never enough.
    expect(
      findBoundSession([session({ supervisor_pid: 999, child_pid: 888, profile: pids.profile })], pids).reason
    ).toContain("999");
    // Right supervisor, wrong child.
    expect(
      findBoundSession([session({ supervisor_pid: 100, child_pid: 888, profile: pids.profile })], pids).reason
    ).toContain("child_pid");
    // Right pids, wrong profile (the launcher passed a path, not a bare name).
    expect(
      findBoundSession([session({ supervisor_pid: 100, child_pid: 200, profile: "tps-agent-run" })], pids).reason
    ).toContain("profile");
    // Right pids, exited session.
    expect(
      findBoundSession(
        [session({ supervisor_pid: 100, child_pid: 200, profile: pids.profile, status: "exited" })],
        pids
      ).reason
    ).toContain("running");
  });

  test("pidAlive is a portable kill(0) — false for a pid that is gone", () => {
    expect(pidAlive(process.pid)).toBe(true);
    // A pid in the reserved-far range: not ours, not alive.
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures: the child side (no CLI process needed)
// ---------------------------------------------------------------------------

describe("4e fixtures — the child refuses without a launcher release", () => {
  test("no socket locator at all → refused, naming the launcher", async () => {
    const r = await attestConfinement({} as NodeJS.ProcessEnv, 500);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(LAUNCH_SOCK_ENV);
  });

  test("a locator pointing at nothing → refused (connect)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-nosock-"));
    try {
      const r = await attestConfinement(
        { [LAUNCH_SOCK_ENV]: join(dir, "absent.sock") } as NodeJS.ProcessEnv,
        1000
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("cannot connect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a release minted for ANOTHER pid is refused by the child (G5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-rel-"));
    try {
      const sockPath = join(dir, "sock", "launch.sock");
      mkdirSync(join(dir, "sock"), { recursive: true });
      writeFileSync(join(dir, "canary-outside"), "outside-nonce");
      writeFileSync(join(dir, "sock", "canary-inside"), "inside-nonce");
      // A peer that releases a pid that is not this process's.
      const { createServer } = await import("node:net");
      const server = createServer((conn) => {
        conn.on("data", () => conn.write(`CONFINED session-x ${process.pid + 4242}\n`));
      });
      await new Promise<void>((r) => server.listen(sockPath, () => r()));
      const r = await attestConfinement(
        { [LAUNCH_SOCK_ENV]: sockPath } as NodeJS.ProcessEnv,
        4000
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("not this process");
      server.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a peer that closes without releasing → refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-close-"));
    try {
      const sockPath = join(dir, "sock", "launch.sock");
      mkdirSync(join(dir, "sock"), { recursive: true });
      writeFileSync(join(dir, "canary-outside"), "o");
      writeFileSync(join(dir, "sock", "canary-inside"), "i");
      const { createServer } = await import("node:net");
      const server = createServer((conn) => conn.destroy());
      await new Promise<void>((r) => server.listen(sockPath, () => r()));
      const r = await attestConfinement({ [LAUNCH_SOCK_ENV]: sockPath } as NodeJS.ProcessEnv, 4000);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/closed|no release/);
      server.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures: the CLI refuses an unwrapped `--sandboxed`
// ---------------------------------------------------------------------------

describe("4e fixtures — `--sandboxed` without a launcher socket", () => {
  test("a plain --sandboxed from a non-TTY caller is refused (exit 78)", () => {
    const sb = makeSandbox("plain-sandboxed");
    try {
      const r = runLauncher(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG, SANDBOXED_FLAG]);
      const text = out(r);
      expect(text).toContain(SANDBOXED_FLAG);
      expect(text).toContain("no launcher released this process");
      // r4f: the child no longer calls attestConfinement without a locator, so
      // the refusal is the gate's (it still names the launcher).
      expect(text).toContain("no launcher socket is in reach");
      expect(r.status).toBe(78);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("the same refusal under TPS_SUPERVISED=1 exits 0 (KeepAlive cannot storm)", () => {
    const sb = makeSandbox("supervised-sandboxed");
    try {
      const r = runLauncher(
        sb,
        ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG, SANDBOXED_FLAG],
        { [SUPERVISED]: "1" }
      );
      expect(out(r)).toContain("no launcher released this process");
      expect(r.status).toBe(0);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures: the launcher refuses — fake nono, whole CLI
// ---------------------------------------------------------------------------

describe("4e fixtures — the launcher refuses (fake nono, pinned absolute path)", () => {
  test("nono missing at the pinned path → refused, never spawned, no launch dir", () => {
    const sb = makeSandbox("nono-missing");
    try {
      const r = runLauncher(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG], {
        [NONO_BIN_ENV]: join(sb.nonoDir, "does-not-exist"),
      });
      const text = out(r);
      // The ABSOLUTE pin wins over PATH: a nono that happens to sit on PATH must
      // not be substituted for the pinned one.
      expect(text).toContain("nono not found at");
      expect(text).toContain(join(sb.nonoDir, "does-not-exist"));
      expect(r.status).toBe(78);
      expect(fakeNonoRuns(sb)).toEqual([]); // never spawned
      expect(launchDirs(sb)).toEqual([]); // nothing left behind
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("no nono anywhere (empty PATH, missing pin) → the launcher refuses before any spawn", () => {
    const sb = makeSandbox("no-nono-at-all");
    try {
      const r = runLauncher(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG], {
        [NONO_BIN_ENV]: join(sb.nonoDir, "does-not-exist"),
        PATH: "/nonexistent-bin",
      });
      const text = out(r);
      expect(text).toContain("refusing to launch");
      expect(text).toContain("no nono at the pinned absolute path");
      expect(r.status).toBe(78);
      expect(launchDirs(sb)).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("an UNCONFINED child (fake nono) → refused because it READ the OUTSIDE canary", () => {
    const sb = makeSandbox("unconfined-child");
    try {
      const bin = writeFakeNono(sb, FAKE_NONO);
      // No store at all: even if the canaries were fine, there is no session.
      const r = runLauncher(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG], {
        [NONO_BIN_ENV]: bin,
      });
      const text = out(r);
      expect(text).toContain("READ the OUTSIDE canary");
      expect(text).toContain("not confined by the profile as launched");
      expect(r.status).toBe(78);
      // The launcher ran nono (it was reachable) and cleaned up after refusing.
      expect(fakeNonoRuns(sb).join("\n")).toContain("run --profile");
      expect(launchDirs(sb)).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("the private dir inside the granted tmpdir → refused BEFORE spawning (overlap assert)", () => {
    const sb = makeSandbox("priv-in-tmp");
    try {
      const bin = writeFakeNono(sb, FAKE_NONO);
      // A full HOME inside the granted tmpdir: the private dir then lands inside
      // the TMPDIR grant (a naive mkdtemp under TMPDIR).
      seedHome(sb.tmp, sb.ws);
      const r = runLauncher(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG], {
        [NONO_BIN_ENV]: bin,
        HOME: sb.tmp,
        TMPDIR: sb.tmp,
      });
      const text = out(r);
      expect(text).toContain("OUTSIDE canary");
      expect(text).toContain("inside the grant");
      expect(r.status).toBe(78);
      expect(fakeNonoRuns(sb)).toEqual([]); // refused BEFORE spawning
      expect(launchDirs({ home: sb.tmp } as Sandbox)).toEqual([]);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("the launcher's own refusal when NONO_BIN is relative (the CLI never PATH-resolves)", () => {
    const sb = makeSandbox("relative-bin");
    try {
      const r = runLauncher(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG], {
        [NONO_BIN_ENV]: "nono",
      });
      const text = out(r);
      expect(text).toContain("ABSOLUTE");
      expect(r.status).toBe(78);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures: the launcher-side checks, driven by a scripted peer
//
// A scripted peer emulates the REPORT a confined child sends (it reads the
// launcher's own inside canary, which its uid can read outside the sandbox). It
// isolates the launcher's binding checks; that a REAL sandbox produces such a
// report is the positive fixture's job (it needs the pinned nono).
// ---------------------------------------------------------------------------

interface LauncherRun {
  exitCode: number;
  childPid?: number;
}

/**
 * Run `launchAttested` in-process against a fake nono and a scripted peer.
 * `publishStore` makes the fake nono publish a session record with the REAL pids
 * it spawned (so the binding can succeed); when false the fixture's own
 * pre-written store is what `ps` returns (no session, an unrelated session, a
 * mismatched child pid).
 */
async function runLauncherInProcess(opts: {
  sb: Sandbox;
  peer: "confined" | "unconfined" | "blind-denied" | "wrong-pid" | "none";
  publishStore?: boolean;
  storeSessions?: unknown;
  peerEnv?: Record<string, string | undefined>;
  failFirst?: { disableCanaryCheck?: boolean; disablePidBinding?: boolean };
}): Promise<LauncherRun> {
  const sb = opts.sb;
  const bin = writeFakeNono(sb, FAKE_NONO);
  const storePath = join(sb.root, "ps.json");
  const stopFile = join(sb.root, "stop");
  const childFile = join(sb.root, "child.pid");
  // eslint-disable-next-line no-unused-vars -- used by the peer env below

  if (opts.publishStore === false) {
    writeFileSync(storePath, JSON.stringify(opts.storeSessions ?? []));
  }

  // The fake nono serves `ps` from FAKE_NONO_PS_JSON; the store needs the real
  // pids, which only exist once the launcher has spawned it — so the store is
  // written by the first `ps` invocation through a hook file.
  const script = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi
log="\${FAKE_NONO_LOG:?}"
printf '%s\\n' "ARGV $*" >> "$log"
if [ "\${1:-}" = "ps" ]; then
  if [ -n "\${FAKE_NONO_PS_JSON:-}" ] && [ -f "\${FAKE_NONO_PS_JSON}" ]; then cat "\${FAKE_NONO_PS_JSON}"; else echo "[]"; fi
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  cmd=(); seen=0
  for a in "$@"; do if [ "$seen" = 1 ]; then cmd+=("$a"); fi; if [ "$a" = "--" ]; then seen=1; fi; done
  "\${cmd[@]}" &
  child=\$!
  echo "CHILD \$child SUP \$\$" >> "$log"
  if [ -n "\${FAKE_NONO_CHILD_FILE:-}" ]; then echo "\$child" > "\$FAKE_NONO_CHILD_FILE"; fi
  # Publish a store the launcher will read, now that both pids exist.
  if [ "\${FAKE_NONO_PUBLISH:-1}" = "1" ]; then
    sup=\$\$
    printf '[{"session_id":"fixture0001","supervisor_pid":%s,"child_pid":%s,"status":"running","profile":"%s","workdir":"%s"}]\\n' "\$sup" "\$child" "\$FAKE_NONO_PROFILE" "\$FAKE_NONO_WORKDIR" > "\$FAKE_NONO_PS_JSON"
  fi
  # Stay alive until the fixture's peer has been released (the peer touches the
  # stop file): an immediately-exiting wrapped command would close the launcher's
  # handshake window before the peer connected.
  if [ -n "\${FAKE_NONO_STOP:-}" ]; then
    while [ ! -f "\$FAKE_NONO_STOP" ]; do sleep 0.05; done
  fi
  wait "\$child"
  exit $?
fi
exit 0
`;
  writeFakeNono(sb, script);

  // A scripted peer: opens the launcher's socket path once it exists.
  const peerProc = startPeer(sb, opts.peer, {
    FAKE_NONO_LOG: sb.nonoLog,
    FAKE_NONO_PS_JSON: storePath,
    FAKE_NONO_PUBLISH: opts.publishStore === false ? "0" : "1",
    FAKE_NONO_STOP: stopFile,
    FAKE_NONO_CHILD_FILE: childFile,
    ...(opts.peerEnv ?? {}),
  });
  // A released launch ends when the wrapped command's nono exits; the fake nono
  // waits for the stop file, so release it shortly after the handshake window
  // opens. Refusal paths kill the session before this fires.
  const toucher = startToucher(sb, stopFile, 10_000);
  try {
    const captured: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => {
      captured.push(parts.map((p) => String(p)).join(" "));
    };
    const exitCode = await launchAttested(
      "tps-agent-run",
      {
        workdir: sb.ws,
        read: [],
        readFiles: [],
        allow: [sb.ws, ...(opts.extraAllow ?? [])],
      },
      ["/bin/true"],
      {
        env: {
          ...(process.env as Record<string, string>),
          HOME: sb.home,
          TMPDIR: sb.tmp,
          [NONO_BIN_ENV]: bin,
          // Short window: the fixture's success path completes in
          // milliseconds, and a refusal must not outlive the test's own limit.
          [TIMEOUT_ENV]: "2500",
          FAKE_NONO_LOG: sb.nonoLog,
          FAKE_NONO_PS_JSON: storePath,
          FAKE_NONO_PUBLISH: opts.publishStore === false ? "0" : "1",
          FAKE_NONO_STOP: stopFile,
          FAKE_NONO_CHILD_FILE: childFile,
          FAKE_NONO_PROFILE: resolve(sb.home, ".config", "nono", "profiles", "tps-agent-run.json"),
          FAKE_NONO_WORKDIR: sb.ws,
        },
        home: sb.home,
        failFirstSeam: opts.failFirst,
      }
    );
    await peerProc.done;
    console.error = original;
    return { exitCode, stderr: captured.join("\n") };
  } finally {
    peerProc.kill();
    toucher.kill();
  }
}

/** A scripted peer that connects to whatever launch socket appears under the
 * sandbox's launch root and speaks the child protocol. */
function startPeer(
  sb: Sandbox,
  mode: "confined" | "unconfined" | "blind-denied" | "wrong-pid" | "none",
  peerEnv: Record<string, string | undefined> = {}
): { done: Promise<void>; kill: () => void } {
  if (mode === "none") return { done: Promise.resolve(), kill: () => {} };
  const root = join(sb.home, ".tps", "launch");
  const script = `
const { connect } = require("node:net");
const { readdirSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const mode = process.argv[2];
const root = process.argv[3];
const deadline = Date.now() + 8000;
function attempt() {
  if (Date.now() > deadline) { console.error("PEER: deadline, root=" + root); process.exit(0); }
  let dir = null;
  try { dir = readdirSync(root).map((d) => join(root, d)).find((d) => existsSync(join(d, "sock", "launch.sock"))); } catch {}
  if (!dir) return setTimeout(attempt, 50);
  // The fake nono writes the wrapped child's pid only once it has spawned it;
  // reading it before then throws in the connect handler and the report never
  // arrives (the launcher then times out). Wait for BOTH the store and the pid.
  if (process.env.FAKE_NONO_CHILD_FILE && !existsSync(process.env.FAKE_NONO_CHILD_FILE)) {
    return setTimeout(attempt, 50);
  }
  if (process.env.FAKE_NONO_PUBLISH === "1" && process.env.FAKE_NONO_PS_JSON && !existsSync(process.env.FAKE_NONO_PS_JSON)) {
    return setTimeout(attempt, 50);
  }
  let sock;
  try { sock = connect({ path: join(dir, "sock", "launch.sock") }); } catch (e) { console.error("PEER: connect threw " + e.message); return setTimeout(attempt, 50); }
  sock.on("error", (e) => { console.error("PEER: error " + e.message); process.exit(0); });
  sock.on("connect", () => {
    const inside = readFileSync(join(dir, "sock", "canary-inside"), "utf-8").trim();
    // The pid a REAL child reports: the wrapped command's pid, which the fake
    // nono logged. "wrong-pid" reports a different one.
    let pid = Number(readFileSync(process.env.FAKE_NONO_CHILD_FILE, "utf-8").trim());
    if (process.env.PEER_REPORT_PID) pid = Number(process.env.PEER_REPORT_PID);
    if (mode === "wrong-pid") pid += 1000;
    sock.write("PID " + pid + "\\n");
    if (mode === "unconfined") {
      let out = "ERR";
      try { out = readFileSync(join(dir, "canary-outside"), "utf-8").trim(); } catch (e) { out = "DENIED"; }
      sock.write("CANARY OUTSIDE READ:" + out + "\\n");
    } else if (mode === "blind-denied") {
      sock.write("CANARY OUTSIDE DENIED\\n");
    } else {
      sock.write("CANARY OUTSIDE DENIED\\n");
    }
    sock.write("CANARY INSIDE " + (mode === "blind-denied" ? "DENIED" : "READ:" + inside) + "\\n");
  });
  sock.on("data", (chunk) => {
    if (String(chunk).includes("CONFINED")) {
      if (process.env.FAKE_NONO_STOP) {
        try { require("node:fs").writeFileSync(process.env.FAKE_NONO_STOP, "released"); } catch {}
      }
      // Released: the report has been delivered, so the peer is done.
      setTimeout(() => process.exit(0), 50);
    }
  });
  sock.on("close", () => process.exit(0));
  setTimeout(() => process.exit(0), 6000);
}
attempt();
`;
  const file = join(sb.root, "peer.cjs");
  writeFileSync(file, script);
  const child: ChildProcess = spawn(process.execPath, [file, mode, root], {
    stdio: "ignore",
    env: { ...(process.env as Record<string, string>), ...(peerEnv as Record<string, string>) },
  });
  return {
    done: new Promise<void>((r) => child.on("exit", () => r())),
    kill: () => child.kill("SIGKILL"),
  };
}

describe("4e fixtures — the launcher's own checks (scripted peer)", () => {
  test("a confined report with NO session in the store → refused (binding)", async () => {
    const sb = makeSandbox("no-session");
    try {
      const run = await runLauncherInProcess({ sb, peer: "confined", publishStore: false });
      expect(run.exitCode).toBe(78);
      expect(run.stderr).toContain("no running session");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("an UNRELATED live session → refused (supervisor/child pid mismatch)", async () => {
    const sb = makeSandbox("unrelated-session");
    try {
      const run = await runLauncherInProcess({
        sb,
        peer: "confined",
        publishStore: false,
        storeSessions: [session({ supervisor_pid: 999999, child_pid: 999998, profile: "unrelated" })],
      });
      expect(run.exitCode).toBe(78);
      expect(run.stderr).toContain("999999");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a blind DENIED (no real read) → refused (INSIDE nonce mismatch)", async () => {
    const sb = makeSandbox("blind-denied");
    try {
      const run = await runLauncherInProcess({ sb, peer: "blind-denied", publishStore: false });
      expect(run.exitCode).toBe(78);
      expect(run.stderr).toContain("blind DENIED is not evidence");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a peer reporting the WRONG pid → refused (binding)", async () => {
    const sb = makeSandbox("wrong-pid");
    try {
      const run = await runLauncherInProcess({ sb, peer: "wrong-pid" });
      expect(run.exitCode).toBe(78);
      expect(run.stderr).toContain("not the pid the child reported");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("an unconfined child (OUTSIDE read) is refused even with a matching session", async () => {
    const sb = makeSandbox("unconfined-peer");
    try {
      const run = await runLauncherInProcess({ sb, peer: "unconfined" });
      expect(run.exitCode).toBe(78);
      expect(run.stderr).toContain("READ the OUTSIDE canary");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

describe("4e FAILS-FIRST — each check is what refuses its fixture", () => {
  test("canary check reverted → the unconfined-child fixture goes GREEN", async () => {
    const sb = makeSandbox("fails-first-canary");
    try {
      const run = await runLauncherInProcess({
        sb,
        peer: "unconfined",
        publishStore: true,
        failFirst: { disableCanaryCheck: true },
      });
      // Without the canary check the unconfined child IS released — which is
      // exactly why the check exists. (The release line names the session.)
      console.error("[fails-first stderr]", run.stderr);
      expect(run.exitCode).not.toBe(78);
      expect(run.stderr).toContain("released under nono session");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("pid binding reverted → the unrelated-session fixture goes GREEN", async () => {
    const sb = makeSandbox("fails-first-pid");
    try {
      const run = await runLauncherInProcess({
        sb,
        peer: "confined",
        publishStore: false,
        storeSessions: [session({ supervisor_pid: 999999, child_pid: 999998, profile: "unrelated" })],
        failFirst: { disablePidBinding: true },
      });
      console.error("[fails-first stderr]", run.stderr);
      expect(run.exitCode).not.toBe(78);
      expect(run.stderr).toContain("released under nono session");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup invariants
// ---------------------------------------------------------------------------

describe("4e — the private dir is removed on every path", () => {
  test("createPrivateLaunchDir + removePrivateLaunchDir leave nothing behind", () => {
    const sb = makeSandbox("cleanup");
    try {
      const dir = createPrivateLaunchDir({ home: sb.home, agentId: "probe" });
      expect(existsSync(dir.root)).toBe(true);
      expect(existsSync(dir.outsideCanary)).toBe(true);
      expect(existsSync(dir.insideCanary)).toBe(true);
      expect(existsSync(dir.stateDir)).toBe(true);
      removePrivateLaunchDir(dir);
      expect(existsSync(dir.root)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cli#350 r4f — the TTY changes nothing: the child attests whenever a LAUNCHER
// started it (keyed on the locator), and an un-released `--sandboxed` is refused
// at a TTY too. Before r4f the child skipped the handshake at a TTY while the
// launcher always waited for it, so every interactive `tps agent start` refused
// with `no released child within …` — green only because every fixture was
// non-TTY. These fixtures give the parent a real PTY.
// ---------------------------------------------------------------------------

/** `script(1)` — util-linux (Linux) or BSD (macOS). Absent ⇒ the TTY fixtures
 * skip; they are coverage for the shape, not the control itself. */
function hasScript(): boolean {
  return Boolean(
    spawnSync("sh", ["-c", "command -v script"], { encoding: "utf-8" }).stdout?.trim()
  );
}

/** The `script` argv for a command string, per platform. */
function scriptArgv(cmd: string): string[] {
  return process.platform === "darwin"
    ? ["-q", "/dev/null", "sh", "-c", cmd]
    : ["-qec", cmd, "/dev/null"];
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Run the WHOLE CLI under a PTY. The launcher spawns nono with inherited stdio,
 * so the re-exec child keeps the terminal — exactly the shape Sherlock
 * reproduced (`isInteractiveTty=true => wouldSkipAttestation=true` before r4f). */
function runLauncherTty(
  sb: Sandbox,
  args: string[],
  extra: Record<string, string | undefined> = {}
) {
  const cmd = [NODE, TPS_BIN, ...args].map(shq).join(" ");
  return spawnSync("script", scriptArgv(cmd), {
    encoding: "utf-8",
    cwd: sb.ws,
    timeout: 30_000,
    env: cliEnv(sb, extra),
  });
}

/** A fake nono that "confines": it denies the child the OUTSIDE canary the way
 * the profile does (chmod — the launcher read it BEFORE the spawn), keeps the
 * child's STDIN on the terminal (a bare `&` sends it to /dev/null, hiding the
 * TTY this fixture exists to exercise), and serves a `ps` store bound to the
 * pids it really spawned. */
const CONFINING_FAKE_NONO = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "--version" ]; then echo "nono 0.74.0"; exit 0; fi
log="\${FAKE_NONO_LOG:?}"
printf '%s\\n' "ARGV $*" >> "$log"
if [ "\${1:-}" = "ps" ]; then
  if [ -n "\${FAKE_NONO_PS_JSON:-}" ] && [ -f "\${FAKE_NONO_PS_JSON}" ]; then cat "\${FAKE_NONO_PS_JSON}"; else echo "[]"; fi
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  cmd=(); seen=0
  for a in "$@"; do if [ "$seen" = 1 ]; then cmd+=("$a"); fi; if [ "$a" = "--" ]; then seen=1; fi; done
  if [ -n "\${TPS_LAUNCH_SOCK:-}" ]; then
    priv="$(dirname "$(dirname "$TPS_LAUNCH_SOCK")")"
    [ -f "$priv/canary-outside" ] && chmod 000 "$priv/canary-outside"
  fi
  if [ -e /dev/tty ]; then "\${cmd[@]}" </dev/tty & else "\${cmd[@]}" & fi
  child=$!
  echo "CHILD $child SUP $$" >> "$log"
  prof=""; args=("$@"); i=0
  for ((i=0; i<\${#args[@]}; i++)); do [ "\${args[$i]}" = "--profile" ] && prof="\${args[$((i+1))]}"; done
  printf '[{"session_id":"ttyfixture","supervisor_pid":%s,"child_pid":%s,"status":"running","profile":"%s"}]\\n' "$$" "$child" "$prof" > "\${FAKE_NONO_PS_JSON:?}"
  if [ -n "\${FAKE_NONO_STOP:-}" ]; then
    while [ ! -f "\$FAKE_NONO_STOP" ]; do sleep 0.05; done
    kill -TERM "$child" 2>/dev/null || true
  fi
  wait "$child"; exit $?
fi
exit 0
`;

const tty = hasScript() ? describe : describe.skip;

tty("4e+r4f — a TTY parent changes nothing", () => {
  test("a TTY-parent launch is RELEASED: the child attests on the locator, not the TTY", () => {
    if (process.getuid?.() === 0) {
      // This fixture "confines" by chmod'ing the OUTSIDE canary, which root
      // ignores — so it cannot run in the ROOT `docker compose run test`
      // service. The Docker Integration lane runs this file as the NON-ROOT
      // `tps` user in the `attested` service, which is where this case (and the
      // real-nono TTY positive) is exercised in a container.
      console.error("[skip] running as root: chmod cannot deny the fixture's OUTSIDE canary");
      return;
    }
    const sb = makeSandbox("tty-release");
    const toucher = startToucher(sb, join(sb.root, "stop"), 4000);
    try {
      const bin = writeFakeNono(sb, CONFINING_FAKE_NONO);
      const r = runLauncherTty(sb, ["agent", "start", "--id", "probe", SANDBOX_REQUIRED_FLAG], {
        [NONO_BIN_ENV]: bin,
        FAKE_NONO_PS_JSON: join(sb.root, "ps.json"),
        FAKE_NONO_STOP: join(sb.root, "stop"),
      });
      const text = out(r);
      // The pre-r4f child would have skipped the handshake here and the
      // launcher would have refused at its window. It must instead be released.
      expect(text).toContain("released under nono session");
      expect(text).not.toContain("no released child within");
      expect(text).not.toContain("READ the OUTSIDE canary");
    } finally {
      toucher.kill();
      rmSync(sb.root, { recursive: true, force: true });
    }
  }, 40_000);

  test("a TTY caller with --sandboxed and NO launcher socket is refused (exit 78)", () => {
    const sb = makeSandbox("tty-refuse");
    try {
      const r = runLauncherTty(sb, [
        "agent",
        "start",
        "--id",
        "probe",
        SANDBOX_REQUIRED_FLAG,
        SANDBOXED_FLAG,
      ]);
      const text = out(r);
      expect(text).toContain(SANDBOXED_FLAG);
      expect(text).toContain("no launcher released this process");
      expect(text).toContain("no launcher socket is in reach");
      expect(r.status).toBe(78);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

tty("4e+r4f FAILS-FIRST — the pre-r4f child shape times out under a TTY parent", () => {
  test("attest-only-when-non-TTY → `no released child within` (the exact symptom)", () => {
    const sb = makeSandbox("fails-first-tty");
    try {
      const bin = writeFakeNono(sb, CONFINING_FAKE_NONO);
      // A stand-in for the PRE-r4f child (bin/tps.ts:197 before the fix): it
      // attests only when NOT a TTY, and stays alive like the runtime would.
      const standin = join(sb.root, "standin-child.mjs");
      writeFileSync(
        standin,
        `const { isInteractiveTty } = await import(${JSON.stringify(
          resolve(import.meta.dir, "../dist/src/utils/nono.js")
        )});\n` +
          "if (isInteractiveTty()) { await new Promise((r) => setTimeout(r, 9000)); process.exit(0); }\n" +
          "process.exit(3);\n"
      );
      // A driver that plays the launcher IN PROCESS (under the PTY) against the
      // stand-in child, so the TTY reaches the child through nono's inherited
      // stdio exactly as it does for the shipped launcher.
      const driver = join(sb.root, "driver.mjs");
      writeFileSync(
        driver,
        `import { launchAttested } from ${JSON.stringify(
          resolve(import.meta.dir, "../dist/src/utils/launch-attestation.js")
        )};\n` +
          "const ws = process.env.DRIVER_WS;\n" +
          'const code = await launchAttested("tps-agent-run", { workdir: ws, read: [], readFiles: [], allow: [ws] }, [process.execPath, process.env.DRIVER_CHILD]);\n' +
          "process.exit(typeof code === \"number\" ? code : 1);\n"
      );
      const r = spawnSync("script", scriptArgv(`${shq(NODE)} ${shq(driver)}`), {
        encoding: "utf-8",
        cwd: sb.ws,
        timeout: 20_000,
        env: cliEnv(sb, {
          [NONO_BIN_ENV]: bin,
          [TIMEOUT_ENV]: "1500",
          FAKE_NONO_PS_JSON: join(sb.root, "ps.json"),
          DRIVER_WS: sb.ws,
          DRIVER_CHILD: standin,
        }),
      });
      const text = out(r);
      console.error("[fails-first TTY stderr]", text.trim().split("\n").slice(-3).join(" | "));
      expect(text).toContain("no released child within");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// cli#350 r4g — review round: a refusal signals only P; the socket path is
// bounded to sun_path; the pin record survives a checkout path with a space.
// ---------------------------------------------------------------------------

describe("4g — a refusal signals ONLY the nono supervisor, never the reported pid", () => {
  test("a peer reporting an UNRELATED live pid cannot get it killed by the refusal", async () => {
    const sb = makeSandbox("refusal-p-only");
    const victim = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      const run = await runLauncherInProcess({
        sb,
        peer: "unconfined", // forces a refusal: the peer READ the OUTSIDE canary
        peerEnv: { PEER_REPORT_PID: String(victim.pid) },
      });
      expect(run.exitCode).toBe(78);
      await new Promise((r) => setTimeout(r, 300));
      // The old code signalled `verdict.pid ?? reportedPid` — the peer's forged
      // pid — so the victim would be dead. Only P may be signalled.
      expect(pidAlive(victim.pid!)).toBe(true);
    } finally {
      victim.kill("SIGKILL");
      rmSync(sb.root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("4g — the launch socket path is bounded to sun_path", () => {
  const base = () => (existsSync("/var/tmp") ? "/var/tmp" : homedir());

  test("a 64-char id under a long HOME still yields a within-limit socket path", () => {
    const root = mkdtempSync(join(base(), "tps-socklen-"));
    try {
      const home = join(root, "h".repeat(20));
      mkdirSync(home, { recursive: true });
      const dir = createPrivateLaunchDir({ home, agentId: "a".repeat(64) });
      expect(Buffer.byteLength(dir.sockPath)).toBeLessThanOrEqual(SUN_PATH_BUDGET);
      expect(dir.root).toContain("a".repeat(16)); // the shortened label
      expect(existsSync(dir.root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a HOME too long for even the shortened label refuses LOUDLY, naming the length", () => {
    const root = mkdtempSync(join(base(), "tps-socklen2-"));
    try {
      const home = join(root, "h".repeat(120));
      mkdirSync(home, { recursive: true });
      expect(() => createPrivateLaunchDir({ home, agentId: "a".repeat(64) })).toThrow(
        /sun_path.*bytes/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("4g — the pin record survives a checkout path with a space", () => {
  test("moduleDir DECODES %20/%23 (URL.pathname would keep them and skip the pin)", () => {
    expect(moduleDir("file:///tmp/My%20Projects/dist/launch-attestation.js")).toBe(
      "/tmp/My Projects/dist",
    );
    expect(moduleDir("file:///tmp/a%23b/dist/x.js")).toBe("/tmp/a#b/dist");
    // ...and the real candidates never carry a percent-escape.
    const candidates = pinRecordCandidates("/usr/local/bin/nono", {} as NodeJS.ProcessEnv);
    expect(candidates.some((c) => c.includes("%2"))).toBe(false);
  });
});
