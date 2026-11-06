// cli#757 — the agent config records the runtime, and `tps heartbeat` skips the
// gateway probe only for an exact `native`. Every test spawns the built CLI
// with a fresh temporary HOME and a fake `openclaw` on PATH.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const DEAD_FLAIR = "http://127.0.0.1:19926";

let home: string;
let fakeBin: string;

function liveGateway(): void {
  writeFileSync(
    join(fakeBin, "openclaw"),
    '#!/usr/bin/env bash\nif [[ "$1" == "gateway" && "$2" == "status" ]]; then echo "gateway: ok"; exit 0; fi\nexit 0\n',
    "utf-8",
  );
  chmodSync(join(fakeBin, "openclaw"), 0o755);
}

function deadGateway(probe?: string): void {
  writeFileSync(
    join(fakeBin, "openclaw"),
    `#!/bin/sh
${probe ? `echo probed > '${probe}'\n` : ""}for arg in "$@"; do
  if [ "$arg" = "--require-rpc" ]; then exit 1; fi
done
exit 0
`,
  );
  chmodSync(join(fakeBin, "openclaw"), 0o755);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-runtime-757-"));
  fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  liveGateway();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function runTps(args: string[], env: Record<string, string> = {}): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, TPS_BIN, ...args], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      HOME: home,
      TMPDIR: home,
      FLAIR_URL: DEAD_FLAIR,
      ...env,
    },
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

function writeAgentConfig(agent: string, runtime?: string): string {
  const dir = join(home, ".tps", "agents", agent);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".tps", "branch-office", agent), { recursive: true });
  const lines = [
    `agentId: ${agent}`,
    `name: ${agent}`,
    `workspace: ${join(home, ".tps", "branch-office", agent)}`,
    `mailDir: ${join(home, ".tps", "mail")}`,
  ];
  if (runtime !== undefined) lines.push(`runtime: ${runtime}`);
  const configPath = join(dir, "agent.yaml");
  writeFileSync(configPath, `${lines.join("\n")}\n`, "utf-8");
  return configPath;
}

describe("cli#757 — heartbeat and the recorded runtime", () => {
  test("a native agent without openclaw skips the gateway probe", async () => {
    const agent = "agent-a";
    writeAgentConfig(agent, "native");
    rmSync(join(fakeBin, "openclaw"));

    const result = await runTps(["heartbeat", agent], { PATH: fakeBin });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Heartbeat for ${agent}: online`);
    expect(result.stdout).toContain("gateway skipped: native runtime");
  }, 20000);

  test("an openclaw agent with a dead gateway still probes and fails", async () => {
    const agent = "agent-b";
    const probe = join(home, "gateway-probed");
    writeAgentConfig(agent, "openclaw");
    deadGateway(probe);

    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("gateway unreachable");
    expect(result.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 20000);

  test("an agent with no recorded runtime is probed (fail closed)", async () => {
    const agent = "agent-c";
    const probe = join(home, "gateway-probed");
    writeAgentConfig(agent);
    deadGateway(probe);

    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("gateway unreachable");
    expect(result.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 20000);

  test("an unrecognised runtime value is probed (fail closed)", async () => {
    const agent = "agent-d";
    const probe = join(home, "gateway-probed");
    writeAgentConfig(agent, "gateway");
    deadGateway(probe);

    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("gateway unreachable");
    expect(result.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 20000);
});

describe("cli#757 — recording the runtime", () => {
  test("agent creation records the runtime for each kind", async () => {
    for (const kind of ["native", "openclaw"]) {
      const agent = `agent-create-${kind}`;
      const result = await runTps(["agent", "create", "--id", agent, "--runtime", kind]);
      expect(result.status).toBe(0);
      const config = readFileSync(join(home, ".tps", "agents", agent, "agent.yaml"), "utf-8");
      expect(config).toContain(`runtime: ${kind}`);
    }
  }, 30000);

  test("tps init records the native runtime", async () => {
    const agent = "agent-init";
    const result = await runTps(["init", "--id", agent]);
    expect(result.status).toBe(0);
    const config = readFileSync(join(home, ".tps", "agents", agent, "agent.yaml"), "utf-8");
    expect(config).toContain("runtime: native");
  }, 30000);

  test("set-runtime accepts each valid value and leaves the other lines unchanged", async () => {
    const agent = "agent-e";
    const configPath = writeAgentConfig(agent, "openclaw");
    const otherLines = (value: string): string[] =>
      value.split("\n").filter((line) => !line.startsWith("runtime:"));

    for (const kind of ["native", "openclaw"]) {
      const before = readFileSync(configPath, "utf-8");
      const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", kind]);
      expect(result.status).toBe(0);
      const after = readFileSync(configPath, "utf-8");
      expect(after).toContain(`runtime: ${kind}`);
      expect(otherLines(after)).toEqual(otherLines(before));
    }
  }, 20000);

  test("set-runtime inserts the field when it is absent", async () => {
    const agent = "agent-f";
    const configPath = writeAgentConfig(agent);

    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(after.match(/^runtime:/gm)).toHaveLength(1);
    expect(after).toContain("runtime: native");
    expect(after).toContain(`agentId: ${agent}`);
  }, 20000);

  test("set-runtime refuses an invalid value and leaves the config unchanged", async () => {
    const agent = "agent-g";
    const configPath = writeAgentConfig(agent, "native");
    const before = readFileSync(configPath, "utf-8");

    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "bogus"]);
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("only 'openclaw' and 'native' are accepted");
    expect(output).toContain("tps agent set-runtime --id");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  }, 20000);
});
