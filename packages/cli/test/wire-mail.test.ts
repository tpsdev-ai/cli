import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fingerprint,
  generateKeyPair,
  initHostIdentity,
  loadHostIdentity,
  registerBranch,
} from "../src/utils/identity.js";
import { PlainTcpTransport } from "../src/utils/plain-tcp-transport.js";
import { WireDeliveryTransport } from "../src/utils/wire-delivery.js";
import { MailDeliverBodySchema, MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";

describe("wire mail", () => {
  let root: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-wire-mail-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = root;
    process.env.TPS_VAULT_KEY = "test-passphrase";
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_VAULT_KEY;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  async function setupChannels() {
    const host = await initHostIdentity();
    const branch = generateKeyPair();
    registerBranch("brancha", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const serverTransport = new PlainTcpTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const serverChannelPromise = new Promise<any>((resolve) => {
      server.onConnection((ch) => resolve(ch));
    });

    const clientTransport = new PlainTcpTransport(branch);
    const client = await clientTransport.connect({
      host: "127.0.0.1",
      port,
      branchId: "brancha",
      hostPublicKey: host.signing.publicKey,
    });

    const serverChannel = await serverChannelPromise;
    expect(client.peerFingerprint()).toBe(fingerprint(host.signing.publicKey));

    return { server, client, serverChannel };
  }

  test("roundtrip delivery", async () => {
    const { server, client, serverChannel } = await setupChannels();
    const transport = new WireDeliveryTransport(client);

    serverChannel.onMessage(async (msg: any) => {
      if (msg.type !== MSG_MAIL_DELIVER) return;
      const body = MailDeliverBodySchema.parse(msg.body);
      await serverChannel.send({
        type: MSG_MAIL_ACK,
        seq: 1,
        ts: new Date().toISOString(),
        body: { id: body.id, accepted: true },
      });
    });

    const result = await transport.deliver({
      from: "brancha",
      to: "kern",
      body: Buffer.from("hello over wire", "utf-8"),
      headers: {
        "x-tps-id": "550e8400-e29b-41d4-a716-446655440000",
        "x-tps-timestamp": new Date().toISOString(),
      },
    });

    expect(result.delivered).toBe(true);
    expect(result.transport).toBe("wire");

    await client.close();
    await server.close();
  });

  test("timeout", async () => {
    const { server, client } = await setupChannels();
    const transport = new WireDeliveryTransport(client, 100);

    const result = await transport.deliver({
      from: "brancha",
      to: "kern",
      body: Buffer.from("hello", "utf-8"),
      headers: { "x-tps-id": "550e8400-e29b-41d4-a716-446655440001" },
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("timeout");

    await client.close();
    await server.close();
  });

  test("rejected delivery", async () => {
    const { server, client, serverChannel } = await setupChannels();
    const transport = new WireDeliveryTransport(client, 500);

    serverChannel.onMessage(async (msg: any) => {
      if (msg.type !== MSG_MAIL_DELIVER) return;
      const body = MailDeliverBodySchema.parse(msg.body);
      await serverChannel.send({
        type: MSG_MAIL_ACK,
        seq: 2,
        ts: new Date().toISOString(),
        body: { id: body.id, accepted: false, reason: "mailbox full" },
      });
    });

    const result = await transport.deliver({
      from: "brancha",
      to: "kern",
      body: Buffer.from("hello", "utf-8"),
      headers: { "x-tps-id": "550e8400-e29b-41d4-a716-446655440002" },
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("mailbox full");

    await client.close();
    await server.close();
  });

  test("zod validation on receive", async () => {
    const { server, client, serverChannel } = await setupChannels();

    const parsePromise = new Promise<boolean>((resolve) => {
      serverChannel.onMessage((msg: any) => {
        if (msg.type !== MSG_MAIL_DELIVER) return;
        try {
          MailDeliverBodySchema.parse(msg.body);
          resolve(false);
        } catch {
          resolve(true);
        }
      });
    });

    await client.send({
      type: MSG_MAIL_DELIVER,
      seq: 7,
      ts: new Date().toISOString(),
      body: { bad: "data" },
    });

    const threw = await parsePromise;
    expect(threw).toBe(true);

    await client.close();
    await server.close();
  });

  test("rejects malformed sender/recipient identifiers", () => {
    expect(() =>
      MailDeliverBodySchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440003",
        from: "../../etc/passwd",
        to: "kern",
        content: "x",
        timestamp: new Date().toISOString(),
      })
    ).toThrow();

    expect(() =>
      MailDeliverBodySchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440004",
        from: "brancha",
        to: "/bin/bash",
        content: "x",
        timestamp: new Date().toISOString(),
      })
    ).toThrow();
  });
});
