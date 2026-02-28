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

  test("supervisor monitor traps SIGTERM/SIGINT and fans out to all child pids", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('cat > "$MONITOR_SCRIPT" <<\'EOS\'');
    expect(sh).toContain("trap shutdown SIGTERM SIGINT");
    expect(sh).toContain("for pid in $pids; do");
    expect(sh).toContain('kill -TERM "$pid"');
    expect(sh).toContain('wait "$pid"');
  });

  test("supervisor writes /workspace/.tps/pids.json after launch", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('PIDS_FILE="/workspace/.tps/pids.json"');
    expect(sh).toContain('} > "$PIDS_FILE"');
    expect(sh).toContain('chmod 644 "$PIDS_FILE"');
  });

  test("agent launch path keeps su -m privilege-drop semantics", () => {
    const sh = src("docker/tps-office-supervisor.sh");
    expect(sh).toContain('su -m -s /bin/bash "$user" -c "exec nono run');
    expect(sh).toContain('su -m -s /bin/bash "$user" -c "exec tps-agent start');
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
  test.todo("steady-state supervisor process runs non-root after launch");
});
