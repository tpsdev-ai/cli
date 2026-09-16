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
    // Every agent launch goes through nono with the tps-office profile...
    expect(sh).toContain("launch_args=(run --profile tps-office --name");
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
    expect(sh).toContain('STATE_ROOT="${TPS_STATE_ROOT:-"$(dirname "$TEAM_FILE")"}"');
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
