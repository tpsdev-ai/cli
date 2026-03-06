import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

describe("tps agent decommission", () => {
  let agentId: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    agentId = `ember-test-${Date.now()}`;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    const home = homedir();
    rmSync(join(home, ".tps", "identity", `${agentId}.key`), { force: true });
    rmSync(join(home, ".tps", "identity", `${agentId}.pub`), { force: true });
    for (const root of [join(home, ".tps", "identity"), join(home, ".tps", "mail"), join(home, ".tps", "agents")]) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (name.startsWith(`${agentId}.`) || name.startsWith(`${agentId}.archived-`) || name.startsWith(`${agentId}.key.archived-`) || name.startsWith(`${agentId}.pub.archived-`) || name.startsWith(`${agentId}-`)) {
          rmSync(join(root, name), { recursive: true, force: true });
        }
      }
    }
  });

  test("archives local state and decommissions the Flair agent", async () => {
    const { runAgent } = await import("../src/commands/agent.js");

    const home = homedir();
    const identityDir = join(home, ".tps", "identity");
    const mailRoot = join(home, ".tps", "mail");
    const agentsRoot = join(home, ".tps", "agents");
    const mailDir = join(mailRoot, agentId);
    const agentDir = join(agentsRoot, agentId);

    mkdirSync(identityDir, { recursive: true });
    mkdirSync(mailDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(join(identityDir, `${agentId}.key`), Buffer.alloc(32, 7));
    writeFileSync(join(identityDir, `${agentId}.pub`), Buffer.alloc(32, 9));
    writeFileSync(join(mailDir, "message.txt"), "hello");
    writeFileSync(join(agentDir, "agent.yaml"), `agentId: ${agentId}\n`);

    const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/Agent/${agentId}`) && (!init || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: agentId,
            name: agentId,
            publicKey: "pub",
            status: "active",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/Agent/${agentId}`) && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        expect(body.status).toBe("decommissioned");
        return new Response("", { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await runAgent({
      action: "decommission",
      id: agentId,
      flairUrl: "http://127.0.0.1:9926",
      force: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(identityDir, `${agentId}.key`))).toBe(false);
    expect(existsSync(join(identityDir, `${agentId}.pub`))).toBe(false);
    expect(readdirSync(identityDir).some((name) => name.startsWith(`${agentId}.key.archived-`))).toBe(true);
    expect(readdirSync(identityDir).some((name) => name.startsWith(`${agentId}.pub.archived-`))).toBe(true);
    expect(readdirSync(mailRoot).some((name) => name.startsWith(`${agentId}.archived-`))).toBe(true);
    expect(readdirSync(agentsRoot).some((name) => name.startsWith(`${agentId}.archived-`))).toBe(true);
  });
});
