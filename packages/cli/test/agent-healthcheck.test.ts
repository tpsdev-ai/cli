import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthcheckAgent } from "../src/commands/agent.js";

let agentId: string;
let tempHome: string;
let output: string[];
let originalLog: typeof console.log;
let originalFetch: typeof globalThis.fetch;
let originalExit: typeof process.exit;
let originalTpsHome: string | undefined;

beforeEach(() => {
  agentId = `ember-healthcheck-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  tempHome = join(tmpdir(), agentId);
  originalLog = console.log;
  originalFetch = globalThis.fetch;
  originalExit = process.exit.bind(process);
  originalTpsHome = process.env.TPS_HOME;
  output = [];

  process.env.TPS_HOME = tempHome;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  (process as typeof process & { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;

  mkdirSync(join(tempHome, ".tps", "agents", agentId), { recursive: true });
  writeFileSync(join(tempHome, ".tps", "agents", agentId, "agent.yaml"), `agentId: ${agentId}\n`);
  mkdirSync(join(tempHome, ".tps", "identity"), { recursive: true });
  writeFileSync(join(tempHome, ".tps", "identity", `${agentId}.key`), Buffer.alloc(32, 7));
  mkdirSync(join(tempHome, ".tps", "mail", agentId, "new"), { recursive: true });
  mkdirSync(join(tempHome, "ops", `tps-${agentId}`), { recursive: true });
  writeFileSync(join(tempHome, "ops", `tps-${agentId}`, ".tps-agent.pid"), `${process.pid}\n`);
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.env.TPS_HOME = originalTpsHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function mockFlairAuth(status = 200): typeof globalThis.fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/SemanticSearch")) {
      expect(init?.method).toBe("POST");
      expect(String((init?.headers as Record<string, string>)?.Authorization ?? "")).toContain(`TPS-Ed25519 ${agentId}:`);
      return new Response(JSON.stringify({ results: [] }), { status });
    }
    throw new Error(`unexpected url: ${url}`);
  }) as typeof globalThis.fetch;
}

describe("tps agent healthcheck", () => {
  test("prints PASS lines and exits 0 when all checks pass", async () => {
    globalThis.fetch = mockFlairAuth(200);

    await expect(
      healthcheckAgent({ action: "healthcheck", id: agentId }),
    ).resolves.toBeUndefined();

    expect(output).toEqual([
      `PASS  Identity: ~/.tps/agents/${agentId}/agent.yaml`,
      `PASS  Flair auth: authenticated as ${agentId}`,
      `PASS  Process: PID ${process.pid} running`,
      `PASS  Mail dir: ~/.tps/mail/${agentId}/new (writable)`,
    ]);
  });

  test("exits 1 and prints FAIL lines when checks fail", async () => {
    globalThis.fetch = mockFlairAuth(503);
    rmSync(join(tempHome, ".tps", "agents", agentId, "agent.yaml"), { force: true });
    rmSync(join(tempHome, "ops", `tps-${agentId}`, ".tps-agent.pid"), { force: true });
    rmSync(join(tempHome, ".tps", "mail", agentId), { recursive: true, force: true });

    await expect(
      healthcheckAgent({ action: "healthcheck", id: agentId }),
    ).rejects.toThrow("exit:1");

    expect(output).toEqual([
      `FAIL  Identity: ~/.tps/agents/${agentId}/agent.yaml unreadable or missing`,
      'FAIL  Flair auth: Flair POST /SemanticSearch → 503: {"results":[]}',
      "FAIL  Process: no PID file found",
      `FAIL  Mail dir: ~/.tps/mail/${agentId}/new missing`,
    ]);
  });

  test("json output reports failing checks", async () => {
    globalThis.fetch = mockFlairAuth(200);
    rmSync(join(tempHome, "ops", `tps-${agentId}`, ".tps-agent.pid"), { force: true });

    await expect(
      healthcheckAgent({ action: "healthcheck", id: agentId, json: true }),
    ).rejects.toThrow("exit:1");

    const parsed = JSON.parse(output.join(""));
    expect(parsed.agentId).toBe(agentId);
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.map((check: { label: string }) => check.label)).toEqual([
      "Identity",
      "Flair auth",
      "Process",
      "Mail dir",
    ]);
  });
});
