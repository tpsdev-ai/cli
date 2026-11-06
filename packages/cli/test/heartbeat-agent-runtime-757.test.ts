// cli#757 — built CLI with temporary HOME; the native case removes the fake OpenClaw.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { loadAgentConfig } from "@tpsdev-ai/agent";

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

async function runTps(args: string[], env: Record<string, string> = {}, preload?: string): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const command = preload ? ["node", "--import", preload, TPS_BIN, ...args] : [process.execPath, TPS_BIN, ...args];
  const proc = Bun.spawn(command, {
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
  test("a plain top-level native line skips the gateway without openclaw", async () => {
    const agent = "agent-a";
    writeAgentConfig(agent, "native");
    rmSync(join(fakeBin, "openclaw"));

    const result = await runTps(["heartbeat", agent], { PATH: fakeBin });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Heartbeat for ${agent}: online`);
    expect(result.stdout).toContain("gateway skipped: native runtime");
  }, 20000);

  test("a merged native runtime is probed with a dead gateway", async () => {
    const agent = "runtime-merge";
    const configPath = writeAgentConfig(agent);
    writeFileSync(configPath, `${readFileSync(configPath, "utf-8")}defaults: &D {runtime: native}\n<<: *D\n`);
    expect((yaml.load(readFileSync(configPath, "utf-8")) as { runtime: string }).runtime).toBe("native");
    const probe = join(home, "gateway-probed");
    deadGateway(probe);
    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 20000);

  test("a quoted native runtime is probed with a dead gateway", async () => {
    const agent = "runtime-quoted";
    writeAgentConfig(agent, '"native"');
    const probe = join(home, "gateway-probed");
    deadGateway(probe);
    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 20000);

  test("tagged, anchored, aliased, duplicate and nested native forms are probed", async () => {
    for (const source of [
      "runtime: !!str native\n",
      "runtime: &R native\n",
      "value: &R native\nruntime: *R\n",
      "runtime: native\nruntime: native\n",
      "settings:\n  runtime: native\n",
      'defaults: &D {runtime: native}\n<<: *D\ntext: "\nruntime: native\n"\n',
    ]) {
      const agent = "runtime-forms";
      const configPath = writeAgentConfig(agent);
      writeFileSync(configPath, `${readFileSync(configPath, "utf-8")}${source}`);
      const probe = join(home, "gateway-probed");
      deadGateway(probe);
      const result = await runTps(["heartbeat", agent]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("gateway probed");
      expect(readFileSync(probe, "utf-8")).toBe("probed\n");
      rmSync(probe);
    }
  }, 30000);

  test("a plain top-level native line with a trailing comment skips a dead gateway", async () => {
    const agent = "runtime-plain";
    writeAgentConfig(agent, "native  # trailing comment");
    deadGateway();
    const result = await runTps(["heartbeat", agent]);
    expect(result.status).toBe(0);
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

describe("cli#757 — generated configs through the agent loader", () => {
  for (const runtime of ["native", "openclaw"]) {
    test(`the agent loader reads a fresh ${runtime} create config and a set-runtime update`, async () => {
      const agent = `loader-create-${runtime}`;
      const args = ["agent", "create", "--id", agent, "--name", "Loader seam", "--model", "anthropic/seam-model"];
      if (runtime === "openclaw") args.push("--runtime", runtime);
      expect((await runTps(args)).status).toBe(0);
      const configPath = join(home, ".tps", "agents", agent, "agent.yaml");
      expect(readFileSync(configPath, "utf-8").split("\n")).toContain(`runtime: ${runtime}`);
      const loaded = loadAgentConfig(configPath);
      expect(loaded).toMatchObject({
        agentId: agent,
        name: "Loader seam",
        workspace: join(home, "ops"),
        mailDir: join(home, ".tps", "mail"),
        memoryPath: join(home, ".tps", "agents", agent, "memory.jsonl"),
        contextWindowTokens: 200000,
        llm: { provider: "anthropic", model: "seam-model", auth: "api-key" },
        tools: ["read", "write", "edit", "exec", "mail"],
      });
      expect(loaded).not.toHaveProperty("runtime");

      expect((await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"])).status).toBe(0);
      expect(readFileSync(configPath, "utf-8").split("\n")).toContain("runtime: native");
      expect(loadAgentConfig(configPath)).toEqual(loaded);
    }, 30000);
  }

  test("the agent loader reads a fresh init config", async () => {
    const agent = "loader-init";
    expect((await runTps(["init", "--id", agent, "--model", "seam-model"])).status).toBe(0);
    const configPath = join(home, ".tps", "agents", agent, "agent.yaml");
    expect(readFileSync(configPath, "utf-8").split("\n")).toContain("runtime: native");
    const loaded = loadAgentConfig(configPath);
    expect(loaded).toMatchObject({
      agentId: agent,
      name: agent,
      workspace: join(home, "ops", agent),
      mailDir: join(home, ".tps", "mail"),
      memoryPath: join(home, ".tps", "agents", agent, "memory.jsonl"),
      contextWindowTokens: 200000,
      llm: { provider: "openai", model: "seam-model", auth: "api-key" },
      flair: { url: DEAD_FLAIR, keyPath: join(home, ".tps", "identity", `${agent}.key`) },
    });
    expect(loaded).not.toHaveProperty("runtime");
  }, 30000);
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

  test("an unflagged create retry preserves openclaw and heartbeat probes", async () => {
    const agent = "retry-openclaw";
    expect((await runTps(["agent", "create", "--id", agent, "--runtime", "openclaw"])).status).toBe(0);
    const configPath = join(home, ".tps", "agents", agent, "agent.yaml");
    const before = readFileSync(configPath);
    expect((await runTps(["agent", "create", "--id", agent])).status).toBe(0);
    expect(readFileSync(configPath)).toEqual(before);
    expect((yaml.load(readFileSync(configPath, "utf-8")) as { runtime: string }).runtime).toBe("openclaw");
    const probe = join(home, "gateway-probed");
    deadGateway(probe);
    const heartbeat = await runTps(["heartbeat", agent]);
    expect(heartbeat.status).toBe(1);
    expect(heartbeat.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 30000);

  test("an unflagged create retry preserves an absent runtime and heartbeat probes", async () => {
    const agent = "retry-absent";
    const configPath = writeAgentConfig(agent);
    const before = readFileSync(configPath);
    expect((await runTps(["agent", "create", "--id", agent])).status).toBe(0);
    expect(readFileSync(configPath)).toEqual(before);
    expect(Object.hasOwn(yaml.load(readFileSync(configPath, "utf-8")) as object, "runtime")).toBe(false);
    const probe = join(home, "gateway-probed");
    deadGateway(probe);
    const heartbeat = await runTps(["heartbeat", agent]);
    expect(heartbeat.status).toBe(1);
    expect(heartbeat.stdout).toContain("gateway probed");
    expect(readFileSync(probe, "utf-8")).toBe("probed\n");
  }, 30000);

  test("create with an explicit runtime refuses an existing custom config", async () => {
    const agent = "create-custom";
    const configPath = writeAgentConfig(agent, "native");
    writeFileSync(configPath, `${readFileSync(configPath, "utf-8")}llm:\n  provider: custom\n  model: custom-model\ntools: [read]\n`);
    const before = readFileSync(configPath);
    const result = await runTps(["agent", "create", "--id", agent, "--runtime", "openclaw"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`tps agent set-runtime --id ${agent} --runtime openclaw`);
    expect(readFileSync(configPath)).toEqual(before);
  }, 20000);

  test("a fresh unflagged create records native", async () => {
    const agent = "create-default";
    expect((await runTps(["agent", "create", "--id", agent])).status).toBe(0);
    const configPath = join(home, ".tps", "agents", agent, "agent.yaml");
    expect((yaml.load(readFileSync(configPath, "utf-8")) as { runtime: string }).runtime).toBe("native");
  }, 30000);

  test("create refuses a bare --runtime and writes nothing", async () => {
    const agent = "runtime-bare";
    const result = await runTps(["agent", "create", "--id", agent, "--runtime"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires a value");
    expect(result.stderr).toContain("only 'openclaw' and 'native' are accepted");
    expect(existsSync(join(home, ".tps"))).toBe(false);
  }, 20000);

  test("create refuses a --runtime followed by another flag and writes nothing", async () => {
    const agent = "runtime-followed";
    const result = await runTps(["agent", "create", "--id", agent, "--runtime", "--name", "Agent A"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires a value");
    expect(result.stderr).toContain("only 'openclaw' and 'native' are accepted");
    expect(existsSync(join(home, ".tps"))).toBe(false);
  }, 20000);

  for (const action of ["create", "set-runtime"]) {
    for (const args of [
      ["--runtime"],
      ["--runtime", "--name", "Ignored"],
      ["--runtime", "-x"],
      ["--runtime="],
      ["--runtime", "native", "--runtime"],
      ["--runtime", "native", "--runtime", "--name", "Ignored"],
      ["--runtime", "native", "--runtime", "openclaw"],
      ["--runtime=native", "--runtime=openclaw"],
      ["--runtime=native", "--runtime", "openclaw"],
      ["--runtime", "native", "--runtime="],
      ["--runtime=", "--runtime", "native"],
    ]) {
      test(`${action} refuses ${args.join(" ")} before writing`, async () => {
        const agent = "runtime-argv";
        const occurrences = args.filter((arg) => arg === "--runtime" || arg.startsWith("--runtime="));
        const missingValue = args.some((arg, index) => arg === "--runtime=" ||
          (arg === "--runtime" && (!args[index + 1] || args[index + 1].startsWith("-"))));
        const refuse = async () => {
          const result = await runTps(["agent", action, "--id", agent, ...args]);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("only 'openclaw' and 'native' are accepted");
          expect(result.stderr).toContain(`Run: tps agent ${action} --id <agent-id> --runtime <openclaw|native>`);
          if (missingValue) expect(result.stderr).toContain("requires a value");
          if (occurrences.length > 1) expect(result.stderr).toContain("give --runtime once");
        };
        if (action === "create") {
          await refuse();
          expect(existsSync(join(home, ".tps"))).toBe(false);
        }
        const configPath = writeAgentConfig(agent, "openclaw");
        const before = readFileSync(configPath);
        const inode = statSync(configPath).ino;
        await refuse();
        expect(readFileSync(configPath)).toEqual(before);
        expect(statSync(configPath).ino).toBe(inode);
        expect(readdirSync(join(configPath, ".."))).toEqual(["agent.yaml"]);
      }, 20000);
    }

    for (const args of [["--runtime=native"], ["--runtime", "native"]]) {
      test(`${action} accepts ${args.join(" ")}`, async () => {
        const agent = "runtime-valid";
        if (action === "set-runtime") writeAgentConfig(agent, "openclaw");
        const result = await runTps(["agent", action, "--id", agent, ...args]);
        expect(result.status).toBe(0);
        const configPath = join(home, ".tps", "agents", agent, "agent.yaml");
        expect((yaml.load(readFileSync(configPath, "utf-8")) as { runtime: string }).runtime).toBe("native");
      }, 20000);
    }
  }

  test("tps init records the native runtime", async () => {
    const agent = "agent-init";
    const result = await runTps(["init", "--id", agent]);
    expect(result.status).toBe(0);
    const config = readFileSync(join(home, ".tps", "agents", agent, "agent.yaml"), "utf-8");
    expect(config).toContain("runtime: native");
  }, 30000);

  test("set-runtime replaces a plain runtime line in LF, CRLF and CR files", async () => {
    const agent = "agent-e";
    const configPath = writeAgentConfig(agent, "openclaw");
    const original = readFileSync(configPath, "utf-8");
    for (const newline of ["\n", "\r\n", "\r"]) {
      writeFileSync(configPath, original.replaceAll("\n", newline));
      for (const kind of ["native", "openclaw"]) {
        const before = readFileSync(configPath, "utf-8");
        const inode = statSync(configPath).ino;
        const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", kind]);
        expect(result.status).toBe(0);
        const after = readFileSync(configPath, "utf-8");
        expect((yaml.load(after) as { runtime: string }).runtime).toBe(kind);
        expect(after).toBe(before.replace(/^runtime:[^\r\n]*/m, `runtime: ${kind}`));
        expect(statSync(configPath).ino).not.toBe(inode);
      }
    }
  }, 20000);

  test("set-runtime preserves a 0644 config under a 0077 umask", async () => {
    const agent = "runtime-mode";
    const configPath = writeAgentConfig(agent, "openclaw");
    chmodSync(configPath, 0o644);
    const preload = join(home, "umask.mjs");
    writeFileSync(preload, "process.umask(0o077);\n");
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(0);
    expect(statSync(configPath).mode & 0o7777).toBe(0o644);
  }, 20000);

  test("set-runtime refuses a failed temp chmod before replacing the config", async () => {
    const agent = "runtime-chmod";
    const configPath = writeAgentConfig(agent, "openclaw");
    const before = readFileSync(configPath);
    const preload = join(home, "fail-chmod.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.chmodSync = () => { throw new Error("injected chmod failure"); };
syncBuiltinESMExports();
`);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected chmod failure");
    expect(readFileSync(configPath)).toEqual(before);
    expect(readdirSync(join(configPath, ".."))).toEqual(["agent.yaml"]);
  }, 20000);

  test("set-runtime drops setuid, setgid and sticky bits and keeps the permission bits", async () => {
    const agent = "runtime-special-bits";
    const configPath = writeAgentConfig(agent, "openclaw");
    for (const special of [0o4755, 0o2755, 0o1755]) {
      chmodSync(configPath, special);
      const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
      expect(result.status).toBe(0);
      const after = readFileSync(configPath, "utf-8");
      expect(after).toContain("runtime: native");
      const mode = statSync(configPath).mode & 0o7777;
      expect(mode & 0o7000).toBe(0);
      expect(mode & 0o777).toBe(0o755);
    }
  }, 30000);

  function probeAlternateGroup(
    groups = process.getgroups(),
    primary = process.getgid(),
    chown = chownSync,
  ): { group: number; skipReason?: never } | { group?: never; skipReason: string } {
    const candidates = groups.filter((group) => group !== primary);
    if (candidates.length === 0) return { skipReason: "this process has no second group" };
    const probeRoot = mkdtempSync(join(tmpdir(), "tps-runtime-757-"));
    try {
      const probePath = join(probeRoot, "chown-probe");
      writeFileSync(probePath, "");
      for (const group of candidates) {
        try {
          chown(probePath, -1, group);
          return { group };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EPERM" && code !== "EACCES") throw error;
        }
      }
      return { skipReason: "chown to a second group is not permitted for this process here" };
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

  test("group probe fails on EIO", () => {
    const error = Object.assign(new Error("EIO: injected chown failure"), { code: "EIO" });
    expect(() => probeAlternateGroup([10, 20], 10, () => { throw error; })).toThrow(error);
  });

  test("group probe skips when every candidate chown returns EPERM or EACCES", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const error = Object.assign(new Error(`${code}: injected chown refusal`), { code });
      expect(probeAlternateGroup([10, 20], 10, () => { throw error; })).toEqual({
        skipReason: "chown to a second group is not permitted for this process here",
      });
    }
  });

  test("group probe skips when this process has no second group", () => {
    expect(probeAlternateGroup([10], 10, () => { throw new Error("unexpected chown"); })).toEqual({
      skipReason: "this process has no second group",
    });
  });

  const groupProbe = probeAlternateGroup();
  if (groupProbe.skipReason !== undefined) {
    test.skip(`set-runtime keeps the config's group (skipped: ${groupProbe.skipReason})`, () => {});
  } else {
    const alternateGroup = groupProbe.group;
    test("set-runtime keeps the config's group", async () => {
      const agent = "runtime-group";
      const configPath = writeAgentConfig(agent, "openclaw");
      chownSync(configPath, -1, alternateGroup);
      const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
      expect(result.status).toBe(0);
      const after = readFileSync(configPath, "utf-8");
      expect(after).toContain("runtime: native");
      expect(statSync(configPath).gid).toBe(alternateGroup);
    }, 20000);
  }

  test("set-runtime refuses EIO without a group-only retry", async () => {
    const agent = "runtime-chown-eio";
    const configPath = writeAgentConfig(agent, "openclaw");
    const before = readFileSync(configPath);
    const callsPath = join(home, "chown-calls.json");
    const preload = join(home, "chown-eio.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const chown = fs.chownSync;
const calls = [];
fs.chownSync = (...args) => {
  calls.push(args);
  fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
  if (calls.length === 1) throw Object.assign(new Error("injected ownership failure"), { code: "EIO" });
  return chown(...args);
};
syncBuiltinESMExports();
`);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EIO");
    const calls = JSON.parse(readFileSync(callsPath, "utf-8")) as [string, number, number][];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(statSync(configPath).uid);
    expect(calls[0][2]).toBe(statSync(configPath).gid);
    expect(result.stderr).toContain(calls[0][0]);
    expect(existsSync(calls[0][0])).toBe(false);
    expect(readFileSync(configPath)).toEqual(before);
    expect(readdirSync(join(configPath, ".."))).toEqual(["agent.yaml"]);
  }, 20000);

  for (const code of ["EPERM", "EACCES"]) {
    test(`set-runtime retries group-only after ${code}`, async () => {
      const agent = `runtime-chown-${code.toLowerCase()}`;
      const configPath = writeAgentConfig(agent, "openclaw");
      const original = statSync(configPath);
      const callsPath = join(home, "chown-calls.json");
      const preload = join(home, "chown-permission.mjs");
      writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const chown = fs.chownSync;
const calls = [];
fs.chownSync = (...args) => {
  calls.push(args);
  fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
  if (calls.length === 1) throw Object.assign(new Error("injected permission refusal"), { code: ${JSON.stringify(code)} });
  return chown(...args);
};
syncBuiltinESMExports();
`);
      const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
      expect(result.status).toBe(0);
      const calls = JSON.parse(readFileSync(callsPath, "utf-8")) as [string, number, number][];
      expect(calls).toEqual([
        [calls[0][0], original.uid, original.gid],
        [calls[0][0], -1, original.gid],
      ]);
      expect(readFileSync(configPath, "utf-8")).toContain("runtime: native");
      expect(statSync(configPath).gid).toBe(original.gid);
      expect(readdirSync(join(configPath, ".."))).toEqual(["agent.yaml"]);
    }, 20000);
  }

  test("set-runtime refuses the write when both ownership attempts fail", async () => {
    const agent = "runtime-chown";
    const configPath = writeAgentConfig(agent, "openclaw");
    const before = readFileSync(configPath);
    const preload = join(home, "fail-chown.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
let attempts = 0;
fs.chownSync = () => {
  attempts++;
  fs.writeFileSync(${JSON.stringify(join(home, "chown-attempts"))}, String(attempts));
  throw Object.assign(new Error("injected chown failure"), { code: "EPERM" });
};
syncBuiltinESMExports();
`);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected chown failure");
    expect(readFileSync(join(home, "chown-attempts"), "utf-8")).toBe("2");
    expect(readFileSync(configPath)).toEqual(before);
    expect(readdirSync(join(configPath, ".."))).toEqual(["agent.yaml"]);
  }, 20000);

  test("set-runtime refuses bytes changed before its pre-rename read", async () => {
    const agent = "runtime-concurrent";
    const configPath = writeAgentConfig(agent, "openclaw");
    const newer = `${readFileSync(configPath, "utf-8")}# newer edit\n`;
    const preload = join(home, "edit-before-rename.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const chmod = fs.chmodSync;
fs.chmodSync = (...args) => {
  chmod(...args);
  fs.writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(newer)});
};
syncBuiltinESMExports();
`);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Config changed since it was read");
    expect(readFileSync(configPath, "utf-8")).toBe(newer);
    expect(readdirSync(join(configPath, ".."))).toEqual(["agent.yaml"]);
  }, 20000);

  test("set-runtime inserts an absent field in a plain mapping", async () => {
    const agent = "agent-f";
    const configPath = writeAgentConfig(agent);

    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(after.match(/^runtime:/gm)).toHaveLength(1);
    expect(after).toContain("runtime: native");
    expect(after).toContain(`agentId: ${agent}`);
  }, 20000);

  test("set-runtime inserts after a leading document marker", async () => {
    const agent = "runtime-marker";
    const configPath = writeAgentConfig(agent);
    writeFileSync(configPath, `---\n${readFileSync(configPath, "utf-8")}`);
    const before = readFileSync(configPath, "utf-8");
    yaml.load(before);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toBe(before.replace("---\n", "---\nruntime: native\n"));
    expect((yaml.load(after) as { runtime: string }).runtime).toBe("native");
  }, 20000);

  test("set-runtime inserts after a YAML directive and document marker", async () => {
    const agent = "runtime-directive";
    const configPath = writeAgentConfig(agent);
    writeFileSync(configPath, `%YAML 1.2\n---\n${readFileSync(configPath, "utf-8")}`);
    const before = readFileSync(configPath, "utf-8");
    yaml.load(before);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(0);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toBe(before.replace("---\n", "---\nruntime: native\n"));
    expect((yaml.load(after) as { runtime: string }).runtime).toBe("native");
  }, 20000);

  test("set-runtime refuses multiple documents and end markers before writing", async () => {
    for (const suffix of ["---\nother: document\n", "...\n"]) {
      const agent = "runtime-documents";
      const configPath = writeAgentConfig(agent);
      writeFileSync(configPath, `---\n${readFileSync(configPath, "utf-8")}${suffix}`);
      const before = readFileSync(configPath);
      const inode = statSync(configPath).ino;
      yaml.loadAll(before.toString());
      const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("edit the file by hand");
      expect(readFileSync(configPath)).toEqual(before);
      expect(statSync(configPath).ino).toBe(inode);
    }
  }, 20000);

  test("set-runtime refuses an invalid insertion candidate before rename", async () => {
    const agent = "runtime-candidate";
    const configPath = writeAgentConfig(agent);
    writeFileSync(configPath, `--- agentId: ${agent}\n`);
    const before = readFileSync(configPath);
    const inode = statSync(configPath).ino;
    yaml.load(before.toString());
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Edit the file by hand");
    expect(readFileSync(configPath)).toEqual(before);
    expect(statSync(configPath).ino).toBe(inode);
  }, 20000);

  test("set-runtime refuses a block scalar before writing", async () => {
    const agent = "runtime-block";
    const configPath = writeAgentConfig(agent, "|-\n  openclaw");
    const before = readFileSync(configPath);
    const inode = statSync(configPath).ino;
    expect((yaml.load(before.toString()) as { runtime: string }).runtime).toBe("openclaw");
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("edit the file by hand");
    expect(readFileSync(configPath)).toEqual(before);
    expect(statSync(configPath).ino).toBe(inode);
  }, 20000);

  test("set-runtime refuses duplicate runtime keys before writing", async () => {
    const agent = "runtime-duplicate";
    const configPath = writeAgentConfig(agent, "openclaw\nruntime: native");
    const before = readFileSync(configPath);
    expect(() => yaml.load(before.toString())).toThrow();
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Edit the file by hand");
    expect(readFileSync(configPath)).toEqual(before);
  }, 20000);

  test("set-runtime refuses flow, nested, quoted and multiline values", async () => {
    for (const value of ["[openclaw]", "{name: openclaw}", "\n  name: openclaw", "openclaw\n  continued", "\n  openclaw", "'openclaw'"]) {
      const agent = "runtime-unsupported";
      const configPath = writeAgentConfig(agent, value);
      const before = readFileSync(configPath);
      yaml.load(before.toString());
      const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("edit the file by hand");
      expect(readFileSync(configPath)).toEqual(before);
    }
  }, 30000);

  test("set-runtime refuses a nested runtime key", async () => {
    const agent = "runtime-nested";
    const configPath = writeAgentConfig(agent);
    writeFileSync(configPath, `${readFileSync(configPath, "utf-8")}settings:\n  runtime: openclaw\n`);
    const before = readFileSync(configPath);
    yaml.load(before.toString());
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("edit the file by hand");
    expect(readFileSync(configPath)).toEqual(before);
  }, 20000);

  test("set-runtime keeps a newer edit after a post-write runtime mismatch", async () => {
    const agent = "runtime-verification";
    const configPath = writeAgentConfig(agent, "openclaw");
    const preload = join(home, "corrupt-after-rename.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
let corrupt = true;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (corrupt && to === ${JSON.stringify(configPath)}) {
    corrupt = false;
    fs.writeFileSync(to, "runtime: mismatched\\n");
  }
};
syncBuiltinESMExports();
`);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Runtime verification failed");
    expect(result.stdout).not.toContain("runtime recorded as");
    expect(readFileSync(configPath, "utf-8")).toBe("runtime: mismatched\n");
    expect(result.stderr).toContain("Config changed after writing");
  }, 20000);

  test("set-runtime restores original bytes when verification fails and its write remains", async () => {
    const agent = "runtime-restore";
    const configPath = writeAgentConfig(agent, "openclaw");
    const before = readFileSync(configPath);
    const preload = join(home, "fail-verification.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
const read = fs.readFileSync;
let failRead = false;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (to === ${JSON.stringify(configPath)}) failRead = true;
};
fs.readFileSync = (...args) => {
  if (failRead && args[0] === ${JSON.stringify(configPath)}) {
    failRead = false;
    throw new Error("injected verification read failure");
  }
  return read(...args);
};
syncBuiltinESMExports();
`);
    const result = await runTps(["agent", "set-runtime", "--id", agent, "--runtime", "native"], {}, preload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected verification read failure");
    expect(readFileSync(configPath)).toEqual(before);
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
