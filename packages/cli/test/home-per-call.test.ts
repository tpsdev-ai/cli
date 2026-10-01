/**
 * home-per-call.test.ts — cli#439.
 *
 * Every module below used to build its `~/.tps` paths once, when the module
 * loaded. Each case imports the module and then uses it under a *different*
 * HOME than the import saw: the path the module acts on must follow the HOME in
 * effect at the call, so no test and no long-lived process depends on the HOME
 * seen at import time.
 *
 * Both homes are temp dirs; nothing here reads or writes a real home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let homeA: string;
let homeB: string;
let startHome: string | undefined;

beforeAll(() => {
  startHome = process.env.HOME;
  homeA = mkdtempSync(join(tmpdir(), "tps-home-a-"));
  homeB = mkdtempSync(join(tmpdir(), "tps-home-b-"));
});

afterAll(() => {
  process.env.HOME = startHome;
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
});

/** Import `spec` with `home` in effect. */
async function importUnder<T>(home: string, spec: string): Promise<T> {
  process.env.HOME = home;
  return (await import(spec)) as T;
}

describe("cli#439: home-relative paths follow the HOME in effect at each call", () => {
  test("utils/auth-proxy.ts: getAuthHeaders reads the auth dir of the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/utils/auth-proxy.js?home-per-call");
    process.env.HOME = homeB;
    const dir = join(homeB, ".tps", "auth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "anthropic.json"),
      JSON.stringify({
        provider: "anthropic",
        refreshToken: "r",
        accessToken: "token-from-b",
        expiresAt: Date.now() + 3_600_000,
        clientId: "id",
        scopes: "s",
      }),
    );
    expect(existsSync(join(homeA, ".tps", "auth", "anthropic.json"))).toBe(false);

    const headers = await mod.getAuthHeaders("anthropic");
    expect(headers?.["x-api-key"]).toBe("token-from-b");
  });

  test("utils/llm-proxy.ts: proxyStatus reads the pid file of the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/utils/llm-proxy.js?home-per-call");
    process.env.HOME = homeB;
    const runDir = join(homeB, ".tps", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "llm-proxy.pid"), `${process.pid}\n`);
    expect(existsSync(join(homeA, ".tps", "run", "llm-proxy.pid"))).toBe(false);

    expect(mod.proxyStatus()).toEqual({ running: true, pid: process.pid, port: 6459 });
  });

  test("utils/mail-relay.ts: getRelayPid reads the pid file of the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/utils/mail-relay.js?home-per-call");
    process.env.HOME = homeB;
    mkdirSync(join(homeB, ".tps"), { recursive: true });
    writeFileSync(join(homeB, ".tps", "relay.pid"), `${process.pid}\n`);
    expect(existsSync(join(homeA, ".tps", "relay.pid"))).toBe(false);

    expect(mod.getRelayPid()).toBe(process.pid);
  });

  test("utils/flair-task-loop.ts: the task cursor is read and written under the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/utils/flair-task-loop.js?home-per-call");
    process.env.HOME = homeB;
    const cursorDir = join(homeB, ".tps", "cursors");
    const cursorFile = join(cursorDir, "anvil-task-loop.json");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ since: "2026-01-01T00:00:00.000Z" }));

    const requested: string[] = [];
    const flair = {
      request: async (_method: string, path: string) => {
        requested.push(path);
        return [
          {
            id: "e1",
            kind: "task.assigned",
            summary: "s",
            createdAt: "2026-01-02T00:00:00.000Z",
            targetIds: ["anvil"],
          },
        ];
      },
    };

    const loop = mod.startTaskLoop(flair, "anvil", async () => {}, { pollIntervalMs: 10_000 });
    const deadline = Date.now() + 5_000; // bounded: the poll runs on its own
    try {
      while (Date.now() < deadline) {
        if (JSON.parse(readFileSync(cursorFile, "utf-8")).since === "2026-01-02T00:00:00.000Z") break;
        await Bun.sleep(10);
      }
    } finally {
      loop.stop();
    }

    expect(requested[0]).toContain("since=2026-01-01T00:00:00.000Z"); // the read followed homeB
    expect(JSON.parse(readFileSync(cursorFile, "utf-8")).since).toBe("2026-01-02T00:00:00.000Z"); // so did the write
    expect(existsSync(join(homeA, ".tps", "cursors", "anvil-task-loop.json"))).toBe(false);
  }, 20_000);

  test("commands/pulse.ts: config is read, and state written, under the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/pulse.js?home-per-call");
    process.env.HOME = homeB;
    const dir = join(homeB, ".tps", "pulse");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ author: "beta-author" }));

    expect(mod.loadConfig().author).toBe("beta-author");
    mod.saveState({ version: 1, lastPollAt: "2026-01-01T00:00:00.000Z", instances: {} });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(homeA, ".tps", "pulse"))).toBe(false);
  });

  test("commands/status.ts: writeUsageEntry writes under the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/status.js?home-per-call");
    process.env.HOME = homeB;

    mod.writeUsageEntry("ember", {
      ts: "2026-01-01T00:00:00.000Z",
      provider: "anthropic",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      estimatedCostUsd: 0.01,
    });

    expect(existsSync(join(homeB, ".tps", "status", "nodes", "ember", "usage.jsonl"))).toBe(true);
    expect(existsSync(join(homeA, ".tps", "status"))).toBe(false);
  });

  test("commands/office-health.ts: the task cursor is read, and state written, under the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/office-health.js?home-per-call");
    process.env.HOME = homeB;
    const cursorDir = join(homeB, ".tps", "cursors");
    mkdirSync(cursorDir, { recursive: true });
    const cursor = join(cursorDir, "ember-task-loop.json");
    writeFileSync(cursor, JSON.stringify({ since: "x" }));
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(cursor, stale, stale);
    mkdirSync(join(homeB, ".tps", "identity"), { recursive: true });
    writeFileSync(join(homeB, ".tps", "identity", "anvil.key"), Buffer.alloc(32, 7));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/Agent/") && method === "GET") {
        return new Response(
          JSON.stringify([{ id: "ember", name: "Ember", publicKey: "pk", lastHeartbeat: new Date().toISOString() }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/OrgEvent/")) return new Response("", { status: 204 });
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const originalLog = console.log;
    console.log = () => {};
    try {
      const tick = await mod.runOfficeHealthTick({
        viewerId: "anvil",
        flairUrl: "http://127.0.0.1:9926",
        keyPath: join(homeB, ".tps", "identity", "anvil.key"),
        state: { unhealthyAgents: {} },
      });
      expect(tick.result.agents.map((a: any) => a.issues.map((i: any) => i.code)).flat()).toContain("task_cursor_stale");

      await mod.runOfficeHealth({
        once: true,
        json: true,
        flairUrl: "http://127.0.0.1:9926",
        viewerId: "anvil",
        keyPath: join(homeB, ".tps", "identity", "anvil.key"),
      });
      expect(existsSync(join(homeB, ".tps", "office-health", "state.json"))).toBe(true);
      expect(existsSync(join(homeA, ".tps", "office-health"))).toBe(false);
      expect(existsSync(join(homeA, ".tps", "cursors"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
  }, 20_000);

  test("commands/pat-rotate.ts: list-github-pats reads the secrets dir of the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/pat-rotate.js?home-per-call");
    process.env.HOME = homeB;
    // Both homes have a secret, under different names: which one is listed says
    // which dir was read, without leaving the JSON branch (which exits on a
    // failing probe in the text branch).
    mkdirSync(join(homeA, ".tps", "secrets"), { recursive: true });
    writeFileSync(join(homeA, ".tps", "secrets", "alpha-github-pat"), "ghp_alpha\n");
    mkdirSync(join(homeB, ".tps", "secrets"), { recursive: true });
    writeFileSync(join(homeB, ".tps", "secrets", "bob-github-pat"), "ghp_bob\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ login: "bob" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof globalThis.fetch;

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = ((...args: unknown[]) => logs.push(args.join(" "))) as typeof console.log;
    try {
      await mod.runListGithubPats({ json: true });
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }

    const out = logs.join("\n");
    expect(out).toContain("bob-github-pat");
    expect(out).not.toContain("alpha-github-pat");
  }, 20_000);

  test("commands/flair-sync.ts: the config is read from the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/flair-sync.js?home-per-call");
    process.env.HOME = homeB;
    mkdirSync(join(homeB, ".tps"), { recursive: true });
    writeFileSync(join(homeB, ".tps", "flair-sync.json"), JSON.stringify({ agentId: "beta-agent" }));

    // The first thing the sync does with the config is resolve that agent's key,
    // which is absent: the refusal names the agent from B's config.
    await expect(mod.runFlairSync({ once: true })).rejects.toThrow(/--id beta-agent/);
  });

  test("commands/flair.ts: the log path in `flair logs` follows the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/flair.js?home-per-call");
    process.env.HOME = homeB;

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = ((...args: unknown[]) => logs.push(args.join(" "))) as typeof console.log;
    try {
      await mod.flairCommand("logs", {});
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toBe(`No logs yet at ${join(homeB, ".tps", "logs", "flair.log")}`);
  });

  test("commands/bootstrap.ts: the completion marker is written under the current HOME", async () => {
    const mod = await importUnder<any>(homeA, "../src/commands/bootstrap.js?home-per-call");
    process.env.HOME = homeB;
    const agentId = "smoke";
    mkdirSync(join(homeB, ".tps", "branch-office", agentId), { recursive: true });
    // The health checks shell out: a fake `nono` (the lane's fake, as the other
    // bootstrap cases use) plus an `openclaw` that reports a healthy gateway.
    const fakeBin = mkdtempSync(join(tmpdir(), "tps-bootstrap-bin-"));
    copyFileSync(join(import.meta.dir, "fakes", "nono", "bin", "nono"), join(fakeBin, "nono"));
    chmodSync(join(fakeBin, "nono"), 0o755);
    writeFileSync(
      join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash
if [[ "$1" == "gateway" && "$2" == "status" ]]; then
  echo "gateway: ok"
  exit 0
fi
exit 0
`,
      "utf-8",
    );
    chmodSync(join(fakeBin, "openclaw"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    // The bundled profile set, where nono resolves `extends` by name: the fake
    // nono (like the other bootstrap cases use) needs the parent present.
    const profilesDir = join(homeB, ".config", "nono", "profiles");
    mkdirSync(profilesDir, { recursive: true });
    const bundled = join(import.meta.dir, "..", "nono-profiles");
    for (const file of readdirSync(bundled)) {
      if (file.endsWith(".json")) copyFileSync(join(bundled, file), join(profilesDir, file));
    }

    const originalLog = console.log;
    console.log = () => {};
    try {
      await mod.runBootstrap({ agentId });
    } finally {
      console.log = originalLog;
      process.env.PATH = originalPath;
      rmSync(fakeBin, { recursive: true, force: true });
    }

    expect(existsSync(join(homeB, ".tps", "bootstrap-state", agentId, ".bootstrap-complete"))).toBe(true);
    expect(existsSync(join(homeA, ".tps", "bootstrap-state"))).toBe(false);
  }, 60_000);
});
