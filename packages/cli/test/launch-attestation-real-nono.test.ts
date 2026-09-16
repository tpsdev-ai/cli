/**
 * cli#350 round 4e — the POSITIVE: the attested launch against REAL nono.
 *
 * This file runs only where a real nono >= 0.70 is reachable by an ABSOLUTE path
 * (NONO_BIN, or one of the pinned locations). Everywhere else it skips, so the
 * unit lane stays green while the Docker lane (non-root, Linux/Landlock) and the
 * nono-profile-gate job (ubuntu + macos) run it for real.
 *
 * What it proves:
 *   1. the premise — this host's nono really enforces: a file under $HOME outside
 *      every grant is DENIED while a granted twin is readable (measured by the
 *      fixture itself, outside the launcher);
 *   2. end to end — `tps agent start --sandbox-required` with the pinned absolute
 *      nono is RELEASED by the launcher, i.e. nono reports a running session
 *      bound to the pid the launcher spawned and to the pid the child reported,
 *      and the child could not read the canary planted outside every grant.
 */
import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveNonoBinary, checkNonoPin } from "../src/utils/launch-attestation.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
/** The runtime the shipped CLI uses: the re-exec child inherits it, and the
 * launcher's locator must survive it (see the note in runLauncher). */
const NODE =
  process.env.TPS_TEST_NODE ??
  (spawnSync("which", ["node"], { encoding: "utf-8" }).stdout?.trim() || "node");
const SANDBOX_REQUIRED = "--sandbox-required";

// cli#350 r4g — these tests wait on a real release window (up to 45s / 60s);
// raise the file default well above the waits so the per-test 5s default cannot
// stop the process (and its cleanup) mid-flight.
setDefaultTimeout(90_000);

/** The real pinned nono, or null (→ skip). */
function realNono(): string | null {
  const resolved = resolveNonoBinary();
  if (!resolved.bin) return null;
  const pin = checkNonoPin(resolved.bin);
  if (!pin.ok) return null;
  const v = spawnSync(resolved.bin, ["--version"], { encoding: "utf-8" });
  if (v.status !== 0) return null;
  return resolved.bin;
}

const NONO = realNono();

/** Every ancestor of `p` (excluding the filesystem root). Bun resolves modules
 * by walking up from the entry script, so a script that lives under a
 * repo checkout needs its ancestor chain readable — the production layout does
 * not (the installed CLI sits under /usr/local, which the harness grants). */
function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = resolve(p);
  while (cur !== "/" && cur !== dirname(cur)) {
    out.push(cur);
    cur = dirname(cur);
  }
  return out;
}

const SYSTEM_READ = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/opt/homebrew", "/private/etc/ssl"];

function seedHome(home: string, ws: string, nonoBin: string): void {
  const profileDir = join(home, ".config", "nono", "profiles");
  const agentDir = join(home, ".tps", "agents", "probe");
  for (const d of [profileDir, agentDir, join(home, ".tps", "mail"), join(home, ".tps", "identity"), ws]) {
    mkdirSync(d, { recursive: true });
  }
  // A minimal JSON profile: reads the toolchain, grants the workspace, and — the
  // point of this fixture — grants NOTHING under $HOME, so the launcher's OUTSIDE
  // canary is genuinely outside every grant.
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const read = [
    ...new Set([
      ...SYSTEM_READ,
      join(home, ".bun"),
      ...ancestors(repoRoot),
      ...ancestors(dirname(process.execPath)),
    ]),
  ];
  const base = {
    $schema: "https://nono.sh/schemas/nono-profile.schema.json",
    meta: { name: "tps-base-fixture" },
    workdir: { access: "readwrite" },
    filesystem: { read, deny: [] },
  };
  const run = {
    $schema: "https://nono.sh/schemas/nono-profile.schema.json",
    extends: "tps-base-fixture",
    meta: { name: "tps-agent-run" },
    workdir: { access: "readwrite" },
  };
  writeFileSync(join(profileDir, "tps-base-fixture.json"), JSON.stringify(base, null, 2));
  writeFileSync(join(profileDir, "tps-agent-run.json"), JSON.stringify(run, null, 2));
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `agentId: probe\nname: probe\nworkspace: ${ws}\n` +
      `mailDir: ${join(home, ".tps", "mail")}\n` +
      `memoryPath: ${join(agentDir, "memory.jsonl")}\n` +
      `llm:\n  provider: ollama\n  model: probe-model\n`
  );
  writeFileSync(join(home, ".tps", "identity", "probe.key"), "fixture-key\n");
  writeFileSync(join(home, ".tps", "identity", "probe.pub"), "fixture-pub\n");
  void nonoBin;
}

/**
 * A fixture tree OUTSIDE /tmp: bun's own temp directory is /tmp regardless of
 * TMPDIR (measured: `os.tmpdir()` returns /tmp inside the sandbox even with
 * TMPDIR set), so the launch must keep granting /tmp — and a fixture HOME under
 * /tmp would then sit inside that grant, which the launcher's overlap assert
 * refuses (correctly). /var/tmp keeps HOME and the granted tmpdir disjoint.
 */
function sandbox(): { root: string; home: string; tmp: string; ws: string } {
  const base = existsSync("/var/tmp") ? "/var/tmp" : homedir();
  const root = mkdtempSync(join(base, "tps-realnono-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const ws = join(root, "ws");
  for (const d of [home, tmp, ws]) mkdirSync(d, { recursive: true });
  seedHome(home, ws, NONO ?? "");
  return { root, home, tmp, ws };
}

beforeAll(() => {
  if (!existsSync(TPS_BIN)) throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
});

const real = NONO ? describe : describe.skip;

real("4e positive — real nono (Landlock/Seatbelt): the premise", () => {
  test("nono denies a path outside every grant while the granted twin is readable", () => {
    const sb = sandbox();
    try {
      const granted = join(sb.ws, "canary-inside");
      const denied = join(sb.home, "canary-outside");
      writeFileSync(granted, "inside-nonce");
      writeFileSync(denied, "outside-nonce");
      const profile = join(sb.home, ".config", "nono", "profiles", "tps-agent-run.json");
      const env = {
        ...process.env,
        HOME: sb.home,
        XDG_STATE_HOME: join(sb.root, "nono-state"),
      };
      mkdirSync(env.XDG_STATE_HOME, { recursive: true });
      const outside = spawnSync(
        NONO!,
        ["run", "-s", "--profile", profile, "--allow-cwd", "--workdir", sb.ws, "--allow", sb.ws, "--", "cat", denied],
        { encoding: "utf-8", cwd: sb.root, env }
      );
      const inside = spawnSync(
        NONO!,
        ["run", "-s", "--profile", profile, "--allow-cwd", "--workdir", sb.ws, "--allow", sb.ws, "--", "cat", granted],
        { encoding: "utf-8", cwd: sb.root, env }
      );
      expect(inside.stdout.trim()).toBe("inside-nonce");
      expect(outside.stdout.trim()).not.toBe("outside-nonce");
      expect(inside.status).toBe(0);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

real("4e positive — the attested launch against the pinned nono", () => {
  test("tps agent start is RELEASED: real nono, canaries verified, session bound to the spawned pid", async () => {
    const sb = sandbox();
    try {
      // Spawned ASYNC: once released, the agent runtime keeps running (it is a
      // long-lived process), so the fixture reads the launch output until the
      // release line appears and then stops the tree.
      const child = spawn(NODE, [TPS_BIN, "agent", "start", "--id", "probe", SANDBOX_REQUIRED], {
        cwd: sb.ws,
        env: {
          ...process.env,
          HOME: sb.home,
          NONO_BIN: NONO!,
          TPS_LAUNCH_TIMEOUT_MS: "20000",
        },
      });
      let text = "";
      const released = await new Promise<boolean>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(false), 45_000);
        const onData = (chunk: Buffer) => {
          text += chunk.toString("utf-8");
          if (text.includes("released under nono session")) {
            clearTimeout(timer);
            resolvePromise(true);
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("exit", () => {
          clearTimeout(timer);
          resolvePromise(text.includes("released under nono session"));
        });
      });
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      child.kill("SIGKILL");
      expect(released).toBe(true);
      // The release line is written only after the launcher bound the live nono
      // session to the pid it spawned and to the pid the child reported, and only
      // after the child reported the OUTSIDE canary DENIED and its granted twin
      // read. Its absence means the control refused — never that it passed.
      expect(text).toContain("released under nono session");
      expect(text).toMatch(/released under nono session \S+ \(child pid \d+\)/);
      expect(text).not.toContain("READ the OUTSIDE canary");
      // The agent actually ran inside that session (the runtime writes its pid
      // file first thing).
      const pidFile = join(sb.ws, ".tps-agent.pid");
      expect(existsSync(pidFile)).toBe(true);
      if (existsSync(pidFile)) {
        const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});

describe("4e positive — the fake-path fixtures never run here", () => {
  test("this file skips cleanly when no real nono is reachable", () => {
    // Documents the skip: in the unit lane there is no pinned nono, so the two
    // suites above are skipped and this one is the only evidence recorded.
    expect(typeof NONO === "string" || NONO === null).toBe(true);
  });
});

/** `script(1)` — util-linux (Linux) or BSD (macOS). The Docker lane is Linux;
 * this file skips entirely in the unit lane without a pinned nono. */
function hasScript(): boolean {
  return Boolean(
    spawnSync("sh", ["-c", "command -v script"], { encoding: "utf-8" }).stdout?.trim()
  );
}

real("4e+r4f positive — a TTY parent still RELEASES (real nono)", () => {
  test("script(1) gives the launch a PTY; real nono keeps it and the child attests anyway", async () => {
    if (!hasScript()) {
      console.error("[skip] no script(1) on this host");
      return;
    }
    const sb = sandbox();
    const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const cmd = [NODE, TPS_BIN, "agent", "start", "--id", "probe", SANDBOX_REQUIRED]
      .map(shq)
      .join(" ");
    const argv =
      process.platform === "darwin"
        ? ["-q", "/dev/null", "sh", "-c", cmd]
        : ["-qec", cmd, "/dev/null"];
    const child = spawn("script", argv, {
      cwd: sb.ws,
      env: {
        ...process.env,
        HOME: sb.home,
        NONO_BIN: NONO!,
        TPS_LAUNCH_TIMEOUT_MS: "20000",
      },
    });
    let text = "";
    const released = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 60_000);
      const onData = (chunk: Buffer) => {
        text += chunk.toString("utf-8");
        if (text.includes("released under nono session")) {
          clearTimeout(timer);
          resolvePromise(true);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", () => {
        clearTimeout(timer);
        resolvePromise(text.includes("released under nono session"));
      });
    });
    // Stop the tree: the released agent is long-lived.
    const pidFile = join(sb.ws, ".tps-agent.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    child.kill("SIGKILL");
    try {
      // Pre-r4f the child skipped the handshake at a TTY and the launcher
      // refused at its window; with the locator keyed instead of the TTY, the
      // interactive path is RELEASED like the piped one.
      expect(released).toBe(true);
      expect(text).toContain("released under nono session");
      expect(text).not.toContain("no released child within");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
