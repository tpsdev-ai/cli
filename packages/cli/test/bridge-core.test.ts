import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeCore } from "../src/bridge/core.js";
import type { BridgeAdapter } from "../src/bridge/adapter.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tps-bridge-core-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("BridgeCore inbound formatting", () => {
  let mailDir: string;
  let keysDir: string;
  let savedKeysDir: string | undefined;

  beforeEach(() => {
    mailDir = makeTmpDir();
    keysDir = makeTmpDir();
    // The bridge signs as its own principal; give it a key.
    writeFileSync(join(keysDir, "test-bridge.key"), Buffer.alloc(32, 0x42));
    savedKeysDir = process.env.TPS_TEST_KEYS_DIR;
    process.env.TPS_TEST_KEYS_DIR = keysDir;
  });

  afterEach(() => {
    if (savedKeysDir === undefined) delete process.env.TPS_TEST_KEYS_DIR;
    else process.env.TPS_TEST_KEYS_DIR = savedKeysDir;
    rmSync(mailDir, { recursive: true, force: true });
    rmSync(keysDir, { recursive: true, force: true });
  });

  function makeCore(): BridgeCore {
    const adapter: BridgeAdapter = {
      name: "test",
      async start() {},
      async send() {},
      async stop() {},
    };
    return new BridgeCore(adapter, {
      bridgeAgentId: "test-bridge",
      defaultAgentId: "ember",
      mailDir,
    }, () => {});
  }

  /** The single signed record the bridge wrote into `agent`'s new/. */
  function readRecord(agent: string): { from: string; envelope: any } {
    const inbox = join(mailDir, agent, "new");
    const files = readdirSync(inbox).filter((file) => file.endsWith(".json"));
    expect(files.length).toBe(1);
    const record = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    return { from: record.from, envelope: JSON.parse(record.body) };
  }

  test("prepends conversational header for discord metadata channel", async () => {
    makeCore().handleInbound({
      channel: "openclaw",
      channelId: "123",
      senderId: "456",
      senderName: "Anvil",
      content: "hey",
      timestamp: new Date().toISOString(),
      metadata: { channel: "discord" },
    });

    const { from, envelope } = readRecord("ember");
    expect(from).toBe("test-bridge");
    expect(envelope.from).toBe("test-bridge");
    expect(envelope.trust).toBe("external");
    expect(envelope.body).toBe(`[Discord message from Anvil (sender 456, channel 123)]
Respond conversationally. If this is a greeting or casual question, reply briefly. Only switch to implementation mode if explicitly asked to write or fix code.

Message: hey`);
    expect(envelope.body).toContain("456");
    expect(envelope.body).toContain("123");
  });

  test("does not prepend conversational header for non-discord messages", async () => {
    makeCore().handleInbound({
      channel: "discord",
      channelId: "123",
      senderId: "456",
      senderName: "Anvil",
      content: "hey",
      timestamp: new Date().toISOString(),
    });

    const { envelope } = readRecord("ember");
    const deliveredEnvelope = JSON.parse(envelope.body);

    expect(deliveredEnvelope).toMatchObject({
      channel: "discord",
      channelId: "123",
      senderId: "456",
      senderName: "Anvil",
      content: "hey",
    });
    expect(typeof deliveredEnvelope.timestamp).toBe("string");
  });
});
