import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { sandboxProfileGrantRefusal } from "../packages/cli/src/utils/nono.js";

const bin = process.env.NONO_BIN;
assert(bin && isAbsolute(bin), "NONO_BIN must name the real nono binary by absolute path");
const root = mkdtempSync(join(tmpdir(), "tps-custom-profile-"));
const home = join(root, "home");
const ws = join(root, "workspace");
const profiles = join(home, ".config", "nono", "profiles");
const env = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  TMPDIR: join(root, "temp"),
  NONO_NO_UPDATE_CHECK: "1",
};
let checks = 0;
const run = (args: string[]) => spawnSync(bin, args, { cwd: ws, env, encoding: "utf8", timeout: 20_000 });
const write = (name: string, doc: object) => {
  const path = join(profiles, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc));
  const validated = run(["profile", "validate", "--strict", path]);
  assert.equal(validated.status, 0, `${name}: ${validated.stdout}${validated.stderr}`);
  return path;
};

try {
  for (const dir of [profiles, ws, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.TMPDIR, join(home, ".tps", "secrets")]) {
    mkdirSync(dir, { recursive: true });
  }
  const inside = join(ws, "granted");
  const protectedFile = join(home, ".tps", "secrets", "fixture");
  writeFileSync(inside, "granted-control");
  writeFileSync(protectedFile, "protected-control");
  write("parent", { groups: { exclude: ["system_read_macos", "system_write_macos", "system_write_linux", "user_tools"] }, filesystem: { read: ["/usr", "/bin", "/lib", "/lib64"] } });
  const safe = write("safe", {
    extends: ["parent"],
    filesystem: { read: [{ path: ws, when: ["linux", "macos"] }] },
  });
  assert.equal(sandboxProfileGrantRefusal("safe", env, undefined, bin), null);

  const bundled = join(import.meta.dir, "../packages/cli/nono-profiles");
  for (const file of readdirSync(bundled).filter((file) => file.endsWith(".json"))) {
    copyFileSync(join(bundled, file), join(profiles, file));
  }
  const relocated = { ...env, CODEX_HOME: join(home, ".local", "bin"), NONO_BIN: bin };
  mkdirSync(relocated.CODEX_HOME, { recursive: true });
  const credential = join(relocated.CODEX_HOME, "auth.json");
  writeFileSync(credential, "relocated-control");
  const inherited = run(["why", "--json", "--profile", join(profiles, "tps-agent-run-claude-code.json"), "--path", credential, "--op", "read"]);
  assert.equal(inherited.status, 0, `${inherited.stdout}${inherited.stderr}`);
  assert.equal(JSON.parse(inherited.stdout).status, "allowed");
  assert(sandboxProfileGrantRefusal("tps-agent-run-claude-code", relocated, "claude-code", bin)?.includes(credential));
  const agentDir = join(home, ".tps", "agents", "probe");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.yaml"), `agentId: probe\nname: probe\nworkspace: ${ws}\nllm:\n  provider: ollama\n  model: probe-model\n`);
  const launch = spawnSync(process.execPath, [join(import.meta.dir, "../packages/cli/test/helpers/runtime-dir-launch-driver.ts")], {
    cwd: ws, env: relocated, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(launch.status, 78, `${launch.stdout}${launch.stderr}`);
  assert(launch.stderr.includes(credential), `${launch.stdout}${launch.stderr}`);
  assert(!launch.stdout.includes("HANDOFF "));
  checks++;

  const platform = process.platform === "darwin" ? "macos" : "linux";
  const cases: Array<{ name: string; doc: object; reason: string; op: string }> = [];
  for (const key of ["read", "allow", "write", "read_file", "allow_file", "write_file"]) {
    const op = key.startsWith("write") ? "write" : key.startsWith("allow") ? "readwrite" : "read";
    for (const conditional of [false, true]) {
      cases.push({
        name: `${key}-${conditional ? "conditional" : "string"}`,
        doc: { filesystem: { [key]: [conditional ? { path: protectedFile, when: platform } : protectedFile] } },
        reason: `filesystem.${key}`,
        op,
      });
    }
  }
  write("protected-parent", { filesystem: { read: [protectedFile] } });
  cases.push({ name: "array-parent", doc: { extends: ["parent", "protected-parent"] }, reason: "filesystem.read", op: "read" });
  cases.push({ name: "override", doc: { platform_overrides: { [platform]: { filesystem: { read: [protectedFile] } } } }, reason: "platform_overrides", op: "read" });
  cases.push({ name: "glob", doc: { filesystem: { read: [join(home, ".tps", "*", "*")] } }, reason: "glob", op: "read" });
  for (const { name, doc, reason, op } of cases) {
    const path = write(name, doc);
    const effective = run(["why", "--path", protectedFile, "--op", op, "--profile", path]);
    assert.equal(effective.status, 0, `${name}: ${effective.stdout}${effective.stderr}`);
    assert.match(`${effective.stdout}${effective.stderr}`, /ALLOWED/, name);
    assert(sandboxProfileGrantRefusal(name, env, undefined, bin)?.includes(reason), name);
    checks++;
  }
  console.log(`profile validation and policy checks: ${checks} pass, 0 fail`);
  const allowed = run(["run", "-s", "--block-net", "--profile", safe, "--workdir", ws, "--allow-cwd", "--", "/bin/cat", inside]);
  assert.equal(allowed.status, 0, `${allowed.stdout}${allowed.stderr}`);
  assert.equal(allowed.stdout.trim(), "granted-control");
  const denied = run(["run", "-s", "--block-net", "--profile", safe, "--workdir", ws, "--allow-cwd", "--", "/bin/cat", protectedFile]);
  assert.notEqual(denied.status, 0, `${denied.stdout}${denied.stderr}`);
  assert(!denied.stdout.includes("protected-control"));
  checks++;

  console.log(`custom profile checks: ${checks} pass, 0 fail`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
