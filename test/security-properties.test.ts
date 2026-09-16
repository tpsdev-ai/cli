import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function src(path: string): string {
  return readFileSync(join(ROOT, path), "utf-8");
}

describe("security properties regression checks", () => {
  test("supervisor enforces proxy socket type check (S56)", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('PROXY_SOCK="/var/run/tps-proxy.sock"');
    expect(sh).toContain('[[ -e "$PROXY_SOCK" ]] && [[ ! -S "$PROXY_SOCK" ]]');
    expect(sh).toContain('Invalid proxy socket at $PROXY_SOCK (not a UNIX socket)');
  });

  test("supervisor includes fail-closed secrets ready gate + cleanup (S33B-E/S54)", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('SECRETS_DIR="/run/secrets"');
    expect(sh).toContain('while [[ ! -f "$SECRETS_DIR/.ready" ]]');
    expect(sh).toContain('Timed out waiting for $SECRETS_DIR/.ready');
    expect(sh).toContain('rm -f "$SECRETS_DIR/.ready"');
    expect(sh).toContain('rm -f "$secret_file"');
  });

  test("supervisor has SIGTERM/SIGINT fan-out logic (trap + kill + wait)", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    const hasTrap = sh.includes("trap shutdown SIGTERM SIGINT") || (sh.includes("trap 'on_signal TERM' SIGTERM") && sh.includes("trap 'on_signal INT' SIGINT"));
    expect(hasTrap).toBe(true);
    expect(sh.includes('kill -TERM "$pid"') || sh.includes('kill -"$signal" "$pid"')).toBe(true);
    expect(sh).toContain('wait "$pid"');
  });

  test("supervisor writes /workspace/.tps/pids.json after launch", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('PIDS_FILE="/workspace/.tps/pids.json"');
    expect(sh).toContain('} > "$PIDS_FILE"');
    expect(sh).toContain('chmod 644 "$PIDS_FILE"');
  });

  test("agent processes are launched under non-root per-agent users, inside nono (cli#341 S2)", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('user="agent-$id"');
    expect(sh).toContain('useradd -u "$uid" -g tps -m -s /bin/bash "$user"');
    // Every agent launch goes through nono with the tps-office profile — since
    // cli#352 r3 as the RESOLVED ABSOLUTE PATH (a bare name is unresolvable in
    // the shipped image; see the profile-resolution tests below)...
    expect(sh).toContain('launch_args=(run --profile "$NONO_PROFILE" --name');
    expect(sh).toContain("-- tps-agent start --id '$id' --config '$config_path'");
    // ...and the UID-only fallback (nono-less agent launch) is gone — fail closed.
    expect(sh).not.toContain("exec tps-agent start");
    expect(sh).toContain("refusing to launch the agent without isolation");
  });

  test("supervisor launch path derives the identity grant from the roster entry, not the config (cli#352 r)", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    // The roster id is validated with the same charset/traversal rule the CLI uses.
    expect(sh).toContain('^[a-zA-Z0-9._-]{1,64}$');
    expect(sh).toContain('"$id" == *..*');
    // The grant path is derived from the roster state root + roster id...
    // ...where the state root is the roster FILE's own directory, with NO
    // override (cli#352 r5, CWE-668): a value diverging from TEAM_FILE could
    // grant another state tree's key for the same id.
    expect(sh).not.toContain("TPS_STATE_ROOT");
    expect(sh).toContain('STATE_ROOT="$(dirname "$TEAM_FILE")"');
    expect(sh).toContain('for k in "$STATE_ROOT/identity/$id.key" "$STATE_ROOT/identity/$id.pub"');
    // ...never read from the config: the supervisor never extracts agentId
    // itself (the rule lives in the runtime, reached via `tps-agent check`).
    expect(sh).not.toMatch(/jq[^\n]*agentId/);
    expect(sh).toContain('tps-agent check --id "$id" --config "$config_path"');
    expect(sh).toContain("refusing to launch — ");
  });

  test("nono allowlist does not include /run/secrets (S52)", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh.includes("--allow /run/secrets")).toBe(false);
  });

  test("office start mounts /run/secrets as tmpfs", () => {
    const office = src("packages/cli/src/commands/office.ts");
    expect(office).toContain('mountArgs.push("--mount", "type=tmpfs,destination=/run/secrets")');
  });

  test("secret injection is fail-closed and removes container on injection error (S53)", () => {
    const office = src("packages/cli/src/commands/office.ts");
    expect(office).toContain("Secret injection failed:");
    expect(office).toContain('spawnSync("docker", ["rm", "-f", sName]');
    expect(office).toContain("process.exit(1)");
  });

  test(".ready marker is always touched by injection flow (including zero secrets)", () => {
    const office = src("packages/cli/src/commands/office.ts");
    expect(office).toContain('"exec", containerName, "touch", "/run/secrets/.ready"');
  });

  test("findCli rejects non-absolute and cwd-local binaries (S46)", () => {
    const auth = src("packages/cli/src/commands/auth.ts");
    expect(auth).toContain('if (!resolved.startsWith("/")) return null;');
    expect(auth).toContain('if (resolved.startsWith(cwd + "/") || resolved.startsWith(cwd + "\\\\"))');
    expect(auth).toContain("Security: refusing to run");
  });

  test("auth dir + credentials are persisted with locked-down permissions (S46)", () => {
    const auth = src("packages/cli/src/commands/auth.ts");
    expect(auth).toContain("mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });");
    expect(auth).toContain("writeFileSync(authPath(provider), JSON.stringify(creds, null, 2), { mode: 0o600 });");
  });

  test("token refresh syncs back to provider credential stores (S46)", () => {
    const auth = src("packages/cli/src/commands/auth.ts");
    expect(auth).toContain("syncToClaudeCode(refreshed)");
    expect(auth).toContain("syncToGeminiCli(refreshed)");
  });

  test.todo("supervisor removes pids.json on exit");
  test.todo("supervisor startup cleans stale pids from prior container lifecycle");
});

/**
 * cli#352 r — the supervisor and the CLI are two launch points for the same
 * workload. cli#351 put `sandboxChildEnv()` and the by-name system read files on
 * the CLI path; the supervisor's shell script repeats them. These assertions are
 * the COUPLING: change the helper without changing the script (or vice versa)
 * and CI fails here, so the two cannot drift.
 */
describe("supervisor ↔ CLI launch-path parity (cli#352 r)", () => {
  const sh = src("docker/tps-office-supervisor.sh");

  function shellArray(name: string): string[] {
    const match = sh.match(new RegExp(String.raw`^(?:readonly\s+)?${name}=\(([^)]*)\)$`, "m"));
    if (!match) throw new Error(`no ${name}=() assignment in the supervisor script`);
    return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }

  test("the supervisor's child-env exports equal sandboxChildEnv()", async () => {
    const { sandboxChildEnv } = await import("../packages/cli/src/utils/nono.ts");
    const expected = sandboxChildEnv({});
    expect(Object.keys(expected).sort()).toEqual(["GIT_CONFIG_GLOBAL", "TPS_NONO_ACTIVE"]);
    const fromShell = Object.fromEntries(
      shellArray("SBOX_ENV").map((pair) => {
        const idx = pair.indexOf("=");
        return [pair.slice(0, idx), pair.slice(idx + 1)];
      }),
    );
    expect(fromShell).toEqual(expected);
  });

  test("the supervisor's system read files equal systemReadFileCandidates('linux')", async () => {
    const { systemReadFileCandidates } = await import("../packages/cli/src/utils/nono.ts");
    expect(shellArray("SBOX_SYSTEM_READ_FILES")).toEqual(systemReadFileCandidates("linux"));
  });

  test("the supervisor grants the identity from the roster state root, by name", () => {
    // harnessReadFiles(agentId) is the CLI's shape: <home>/.tps/identity/<id>.{key,pub}.
    expect(sh).toContain('STATE_ROOT/identity/$id.key');
    expect(sh).toContain('STATE_ROOT/identity/$id.pub');
    expect(sh).toContain("launch_args+=(--read-file \"$k\")");
  });
});

/**
 * cli#352 r3 — Sherlock's blocker: the office image shipped no `tps-office`
 * profile and the supervisor passed the BARE NAME, which nono resolves against
 * its own config dir (never populated in the container), so the probe failed
 * for the wrong reason and fail-closed refused every agent. These assertions
 * are the coupling for the fix: the profile is resolved to an absolute path at
 * both launch sites, the image ships it where the resolver looks, and docker.yml
 * launches the BUILT image so a forgotten COPY cannot stay green.
 */
describe("supervisor profile resolution (cli#352 r3)", () => {
  const sh = src("docker/tps-office-supervisor.sh");

  test("no launch point passes a bare profile name", () => {
    expect(sh).not.toContain("--profile tps-office");
  });

  test("both launch sites pass the resolved profile path", () => {
    // One text form in the launch argv, one in the probe's su -c string.
    const matches = sh.match(/--profile \\?"\$NONO_PROFILE\\?"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("an unresolvable profile is a named refusal, never a bare name", () => {
    expect(sh).toContain("profile file not found at");
    expect(sh).toContain("nono is never given a bare profile name");
  });

  test("the resolver searches the user dir then the bundled dir (resolveProfilePath's order)", () => {
    const userIdx = sh.indexOf("/.config/nono/profiles/$name.json");
    const bundledIdx = sh.indexOf("$BUNDLED_PROFILES_DIR/$name.json");
    expect(userIdx).toBeGreaterThan(-1);
    expect(bundledIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(bundledIdx);
  });

  test("the bundled candidate defaults to the image's COPY destination", () => {
    expect(sh).toContain('BUNDLED_PROFILES_DIR="${TPS_NONO_PROFILES_DIR:-/usr/local/share/tps/nono-profiles}"');
  });

  test("the launch runs the agent with a HOME the agent owns", () => {
    // `su -m` preserves the environment we need (PATH, SBOX_ENV) but must not
    // hand the agent the supervisor's HOME: /root in the image, where nono cannot
    // create its session/audit state root.
    expect(sh).toContain('AGENT_HOME="/home/$user"');
    expect(sh).toContain("HOME='$AGENT_HOME' exec nono");
  });

  test("the office image ships the profiles at that path", () => {
    expect(src("docker/Dockerfile")).toContain(
      "COPY packages/cli/nono-profiles/ /usr/local/share/tps/nono-profiles",
    );
  });

  test("docker.yml runs the built image against the bundled profile", () => {
    const yml = src(".github/workflows/docker.yml");
    expect(yml).toContain("/usr/local/share/tps/nono-profiles/tps-office.json");
    expect(yml).toContain("tps-office-supervisor");
  });
});

/**
 * cli#352 r4 — the supervisor's pre-flight calls `tps-agent check`, which only
 * the WORKSPACE agent has (the published 0.5.4's bin has no `check`). The office
 * image installs the PUBLISHED agent, so the launch control must exercise the
 * SHIPPED binary instead of substituting a stand-in, and packages/agent must be
 * at least the version that introduced `check` — otherwise the image is dead on
 * arrival and the smoke must say so, not paper over it. These assertions are the
 * coupling (Kern's item): delete the subcommand, drop the version, or reintroduce
 * a `tps-agent` shim in the smoke, and CI fails here.
 */
describe("office image ships an agent that answers `check` (cli#352 r4)", () => {
  const CHECK_INTRODUCED_IN = "0.5.5";

  function semver(v: string): [number, number, number] {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) throw new Error(`not a semver version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  function gte(a: string, b: string): boolean {
    const x = semver(a);
    const y = semver(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return true;
  }

  test("packages/agent is at least the version that introduced `check`", () => {
    const { version } = JSON.parse(src("packages/agent/package.json")) as { version: string };
    expect(gte(version, CHECK_INTRODUCED_IN)).toBe(true);
    // ...and the subcommand is really in the shipped bin, not just the version.
    expect(src("packages/agent/src/bin.ts")).toContain('command === "check"');
  });

  test("the image smoke runs the SHIPPED tps-agent — no stand-in is written", () => {
    const yml = src(".github/workflows/docker.yml");
    // The deleted stand-in wrote a `tps-agent` file into the fixture whose
    // `check` exited 0 unconditionally — the "harness supplies what ship lacks"
    // shape this round closes. Neither shape may come back.
    expect(yml).not.toContain("smoke/bin/tps-agent");
    expect(yml).not.toContain("check) exit 0");
    // The supervisor is what runs the SHIPPED `check` pre-flight and `start`.
    expect(yml).toContain("tps-office-supervisor >/tmp/sup.log");
  });

  test("the smoke asserts the real agent's readiness AND the supervisor's exit", () => {
    const yml = src(".github/workflows/docker.yml");
    // readiness is the agent's OWN signal: the pid file `start` writes.
    expect(yml).toContain("/workspace/smoke/.tps-agent.pid");
    // ...and the supervisor's exit status is asserted, not only readiness.
    expect(yml).toContain('wait "$sup"');
  });

  test("docker/Dockerfile keeps the published install and gates the tarball", () => {
    const df = src("docker/Dockerfile");
    // the SHIPPED path installs the published package at the tag version...
    expect(df).toContain('npm install -g "@tpsdev-ai/agent@${TPS_VERSION}"');
    // ...and the workspace tarball is the verification-only override.
    expect(df).toContain('ARG TPS_AGENT_TARBALL=""');
    expect(df).toContain("/tmp/agent.tgz");
  });
});
