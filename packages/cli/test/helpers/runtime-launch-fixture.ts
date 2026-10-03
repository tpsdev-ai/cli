import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  ws: string;
  nonoDir: string;
  nonoLog: string;
}

/** A fixture HOME (agent.yaml, mail, identity, JSON profile pair) + a nono dir. */
function seedHome(home: string, ws: string): void {
  const agentDir = join(home, ".tps", "agents", "probe");
  const profileDir = join(home, ".config", "nono", "profiles");
  for (const d of [agentDir, profileDir, join(home, ".tps", "mail"), join(home, ".tps", "identity")]) {
    mkdirSync(d, { recursive: true });
  }
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
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `agentId: probe\nname: probe\nworkspace: ${ws}\n` +
      `mailDir: ${join(home, ".tps", "mail")}\n` +
      `memoryPath: ${join(agentDir, "memory.jsonl")}\n` +
      `llm:\n  provider: ollama\n  model: probe-model\n`
  );
  writeFileSync(join(home, ".tps", "identity", "probe.key"), "fixture-key\n");
  writeFileSync(join(home, ".tps", "identity", "probe.pub"), "fixture-pub\n");
}

export function makeSandbox(): Sandbox {
  const base = process.platform === "linux" ? "/var/tmp" : tmpdir();
  const root = mkdtempSync(join(base, "tps-363-rt-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const ws = join(root, "ws");
  const nonoDir = join(root, "nono");
  for (const d of [home, tmp, ws, nonoDir]) mkdirSync(d, { recursive: true });
  seedHome(home, ws);
  return { root, home, tmp, ws, nonoDir, nonoLog: join(root, "nono.log") };
}

export function cliEnv(sb: Sandbox, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: "../home",
    SNOOPLOGG: "tps:agent*",
    TMPDIR: sb.tmp,
    FAKE_NONO_LOG: sb.nonoLog,
    TPS_LAUNCH_TIMEOUT_MS: "8000",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

