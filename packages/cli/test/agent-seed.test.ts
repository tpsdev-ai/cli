/**
 * ops-31.3 — tps agent create onboarding seed tests
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let _savedFetch: typeof globalThis.fetch;
const TEST_AGENT_ID = `test-seed-agent-${process.pid}`;
const TEST_IDENTITY_DIR = join(tmpdir(), `tps-test-identity-${process.pid}`);

const SEED_RESPONSE = {
  agent: { id: TEST_AGENT_ID, name: TEST_AGENT_ID, role: "agent", publicKey: "pending", createdAt: "2026-03-02T00:00:00Z", updatedAt: "2026-03-02T00:00:00Z" },
  soulEntries: [
    { id: `${TEST_AGENT_ID}:name`, agentId: TEST_AGENT_ID, key: "name", value: TEST_AGENT_ID },
    { id: `${TEST_AGENT_ID}:role`, agentId: TEST_AGENT_ID, key: "role", value: "agent" },
  ],
  memories: [
    { id: `seed-${TEST_AGENT_ID}-0`, agentId: TEST_AGENT_ID, content: `Agent ${TEST_AGENT_ID} initialized.`, durability: "persistent", tags: ["onboarding", "system"] },
  ],
};

beforeAll(() => {
  _savedFetch = globalThis.fetch;
  mkdirSync(TEST_IDENTITY_DIR, { recursive: true });
  // Pre-generate test Ed25519 key so createAgent doesn't try to write to real identity dir
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(join(TEST_IDENTITY_DIR, `${TEST_AGENT_ID}.key`), privateKey, { mode: 0o600 });
  writeFileSync(join(TEST_IDENTITY_DIR, `${TEST_AGENT_ID}.pub`), publicKey);
});

afterAll(() => {
  globalThis.fetch = _savedFetch;
});

describe("ops-31.3: FlairClient.seedAgent()", () => {
  test("sends correct payload to /AgentSeed", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/AgentSeed")) {
        capturedBody = JSON.parse(opts?.body as string);
        return new Response(JSON.stringify(SEED_RESPONSE), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { createFlairClient } = await import("../src/utils/flair-client.js");
    const { generateKeyPairSync: gkp } = await import("node:crypto");
    const { writeFileSync: wf } = await import("node:fs");
    const adminKey = join(tmpdir(), `admin-${process.pid}.pem`);
    wf(adminKey, gkp("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey, { mode: 0o600 });
    const flair = createFlairClient("admin", "http://127.0.0.1:19926", adminKey);
    const result = await flair.seedAgent({
      agentId: TEST_AGENT_ID,
      displayName: "Test Agent",
      role: "agent",
      soulTemplate: { name: "Test Agent", team: "test" },
    });

    expect(capturedBody.agentId).toBe(TEST_AGENT_ID);
    expect(capturedBody.displayName).toBe("Test Agent");
    expect(capturedBody.soulTemplate.team).toBe("test");
    expect(result.soulEntries.length).toBe(2);
    expect(result.memories.length).toBe(1);
  });

  test("passes starterMemories to /AgentSeed", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/AgentSeed")) {
        capturedBody = JSON.parse(opts?.body as string);
        return new Response(JSON.stringify(SEED_RESPONSE), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as any;

    const { createFlairClient } = await import("../src/utils/flair-client.js");
    const { generateKeyPairSync: gkp2 } = await import("node:crypto");
    const { writeFileSync: wf2 } = await import("node:fs");
    const adminKey2 = join(tmpdir(), `admin2-${process.pid}.pem`);
    wf2(adminKey2, gkp2("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey, { mode: 0o600 });
    const flair = createFlairClient("admin", "http://127.0.0.1:19926", adminKey2);
    await flair.seedAgent({
      agentId: TEST_AGENT_ID,
      starterMemories: [{ content: "Custom memory", tags: ["test"], durability: "persistent" }],
    });

    expect(capturedBody.starterMemories).toHaveLength(1);
    expect(capturedBody.starterMemories[0].content).toBe("Custom memory");
  });
});

describe("ops-31.3: updateAgent()", () => {
  test("read-modify-write: fetches existing record then PUTs merged", async () => {
    const existing = { id: TEST_AGENT_ID, name: "old", role: "agent", publicKey: "pending", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    let putBody: any;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("/Agent/")) {
        if (opts?.method === "PUT") { putBody = JSON.parse(opts.body as string); return new Response("{}", { status: 200 }); }
        return new Response(JSON.stringify(existing), { status: 200 });
      }
      if (opts?.method === "POST") return new Response(JSON.stringify([existing]), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as any;

    const { createFlairClient } = await import("../src/utils/flair-client.js");
    const { generateKeyPairSync: gkp3 } = await import("node:crypto");
    const { writeFileSync: wf3 } = await import("node:fs");
    const adminKey3 = join(tmpdir(), `admin3-${process.pid}.pem`);
    wf3(adminKey3, gkp3("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey, { mode: 0o600 });
    const flair = createFlairClient(TEST_AGENT_ID, "http://127.0.0.1:19926", adminKey3);
    await flair.updateAgent(TEST_AGENT_ID, { publicKey: "newhex" });

    expect(putBody.publicKey).toBe("newhex");
    expect(putBody.name).toBe("old"); // preserved
    expect(putBody.role).toBe("agent"); // preserved
  });
});
