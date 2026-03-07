import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

  beforeEach(() => {
    mailDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(mailDir, { recursive: true, force: true });
  });

  test("prepends conversational header for discord metadata channel", async () => {
    const adapter: BridgeAdapter = {
      name: "test",
      async start() {},
      async send() {},
      async stop() {},
    };

    const core = new BridgeCore(adapter, {
      bridgeAgentId: "test-bridge",
      defaultAgentId: "ember",
      mailDir,
    }, () => {});

    (core as any).handleInbound({
      channel: "openclaw",
      channelId: "123",
      senderId: "456",
      senderName: "Anvil",
      content: "hey",
      timestamp: new Date().toISOString(),
      metadata: { channel: "discord" },
    });

    const inbox = join(mailDir, "ember", "new");
    const files = readdirSync(inbox).filter((file) => file.endsWith(".json"));
    const msg = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(msg.body).toBe(`[Discord message from Anvil]
Respond conversationally. If this is a greeting or casual question, reply briefly. Only switch to implementation mode if explicitly asked to write or fix code.

Message: hey`);
  });

  test("does not prepend conversational header for non-discord messages", async () => {
    const adapter: BridgeAdapter = {
      name: "test",
      async start() {},
      async send() {},
      async stop() {},
    };

    const core = new BridgeCore(adapter, {
      bridgeAgentId: "test-bridge",
      defaultAgentId: "ember",
      mailDir,
    }, () => {});

    (core as any).handleInbound({
      channel: "discord",
      channelId: "123",
      senderId: "456",
      senderName: "Anvil",
      content: "hey",
      timestamp: new Date().toISOString(),
    });

    const inbox = join(mailDir, "ember", "new");
    const files = readdirSync(inbox).filter((file) => file.endsWith(".json"));
    const msg = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    const deliveredEnvelope = JSON.parse(msg.body);

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
