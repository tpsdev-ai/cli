import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tps roster invite", () => {
  let tempHome: string;
  let configPath: string;
  let originalHome: string | undefined;
  let originalAgentId: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tps-roster-invite-"));
    configPath = join(tempHome, "openclaw.json");
    originalHome = process.env.HOME;
    originalAgentId = process.env.TPS_AGENT_ID;
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;

    process.env.HOME = tempHome;
    process.env.TPS_AGENT_ID = "anvil";

    writeFileSync(configPath, JSON.stringify({ agents: { list: [] } }, null, 2));
    mkdirSync(join(tempHome, ".tps", "identity"), { recursive: true });
    writeFileSync(join(tempHome, ".tps", "identity", "anvil.key"), Buffer.alloc(32, 7));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentId === undefined) {
      delete process.env.TPS_AGENT_ID;
    } else {
      process.env.TPS_AGENT_ID = originalAgentId;
    }
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("verifies identity, sends standard invite mail, and publishes org.invited with custom detail", async () => {
    const logs: string[] = [];
    console.log = mock((value?: unknown) => {
      logs.push(String(value ?? ""));
    }) as typeof console.log;

    const requests: Array<{ url: string; method: string; body?: any }> = [];
    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });

      if (url.endsWith("/Identity/flint") && method === "GET") {
        return new Response(JSON.stringify({ id: "flint" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/OrgEvent/") && method === "POST") {
        return new Response("", { status: 204 });
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const { runRoster } = await import("../src/commands/roster.js");
    await runRoster({
      action: "invite",
      agent: "flint",
      message: "Welcome to TPS",
      flairUrl: "http://127.0.0.1:9926",
      mailDir: join(tempHome, ".tps", "mail"),
      json: true,
      configPath,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("http://127.0.0.1:9926/Identity/flint");
    expect(requests[1]?.body.kind).toBe("org.invited");
    expect(requests[1]?.body.summary).toBe("Invited flint to TPS");
    expect(requests[1]?.body.detail).toBe("Welcome to TPS");
    expect(requests[1]?.body.targetIds).toEqual(["flint"]);

    const newDir = join(tempHome, ".tps", "mail", "flint", "new");
    expect(existsSync(newDir)).toBe(true);
    const files = readdirSync(newDir).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const mail = JSON.parse(readFileSync(join(newDir, files[0]!), "utf-8"));
    expect(mail.from).toBe("anvil");
    expect(mail.to).toBe("flint");
    expect(mail.body).toContain("You have been invited to join TPS.");
    expect(mail.body).toContain("Invited by: anvil");
    expect(mail.headers["X-TPS-Message-Type"]).toBe("org.invite");

    expect(JSON.parse(logs[0]!)).toEqual({
      status: "invited",
      agentId: "flint",
      invitedBy: "anvil",
    });
  });

  test("uses the standard invite text as org event detail when no custom message is provided", async () => {
    let eventBody: any;
    console.log = mock(() => {}) as typeof console.log;
    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/Identity/flint") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ id: "flint" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/OrgEvent/") && init?.method === "POST") {
        eventBody = JSON.parse(String(init.body));
        return new Response("", { status: 204 });
      }
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    }) as typeof globalThis.fetch;
    const { runRoster } = await import("../src/commands/roster.js");
    await runRoster({
      action: "invite",
      agent: "flint",
      flairUrl: "http://127.0.0.1:9926",
      mailDir: join(tempHome, ".tps", "mail"),
      configPath,
    });

    expect(eventBody.detail).toContain("You have been invited to join TPS.");
    expect(eventBody.detail).toContain("Invited by: anvil");
  });

  test("exits when the target identity is missing in Flair", async () => {
    const errors: string[] = [];
    console.log = mock(() => {}) as typeof console.log;
    console.error = mock((value?: unknown) => {
      errors.push(String(value ?? ""));
    }) as typeof console.error;
    process.exit = mock(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);

    globalThis.fetch = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/Identity/ghost")) {
        return new Response("missing", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
    const { runRoster } = await import("../src/commands/roster.js");
    await expect(
      runRoster({
        action: "invite",
        agent: "ghost",
        flairUrl: "http://127.0.0.1:9926",
        configPath,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain('Agent "ghost" not found in Flair identity registry');
  });
});
