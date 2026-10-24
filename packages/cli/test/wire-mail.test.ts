import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { HttpRequestBodySchema, HttpResponseBodySchema, JoinCompleteBodySchema, MailDeliverBodySchema, MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";
import { decodeWireMessage, encodeWireMessage } from "../src/utils/wire-frame.js";
import { deliverRelayedToLocal, relayAcceptanceReceiptPath, RelayAcceptReceiptSchema } from "../src/utils/relay.js";

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

  test("accepts a non-RFC 8-4-4-4-12 delivery id", () => {
    const parsed = MailDeliverBodySchema.parse({
      id: "12345678-1234-1234-1234-123456789abc",
      from: "brancha",
      to: "kern",
      content: "x",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.id).toBe("12345678-1234-1234-1234-123456789abc");
  });

  test("accepts a non-RFC 8-4-4-4-12 reqId", () => {
    const parsed = HttpRequestBodySchema.parse({
      reqId: "12345678-1234-1234-1234-123456789abc",
      method: "GET",
      path: "/",
      headers: {},
    });
    expect(parsed.reqId).toBe("12345678-1234-1234-1234-123456789abc");
  });

  test("accepts the zod 3 relay timestamp forms", () => {
    for (const timestamp of [
      "2026-01-01T00:00Z",
      "2026-01-01T00:00:00+0100",
      "2026-01-01T00:00:00.123+05:30",
      "2024-02-29T00:00:00Z",
    ]) {
      expect(
        MailDeliverBodySchema.safeParse({
          id: "550e8400-e29b-41d4-a716-446655440010",
          from: "brancha",
          to: "kern",
          content: "x",
          timestamp,
        }).success
      ).toBe(true);
    }
  });

  test("rejects impossible calendar dates and malformed timestamps", () => {
    for (const timestamp of ["2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "not-a-date"]) {
      expect(
        MailDeliverBodySchema.safeParse({
          id: "550e8400-e29b-41d4-a716-446655440011",
          from: "brancha",
          to: "kern",
          content: "x",
          timestamp,
        }).success
      ).toBe(false);
    }
  });

  test("refuses int wire fields beyond the safe integer range", () => {
    const joinBody = (localPort: number) => ({
      hostPubkey: "pubkey",
      hostFingerprint: "fingerprint",
      hostId: "host-a",
      services: [{ name: "svc", localPort }],
    });
    const responseBody = (status: number) => ({
      reqId: "550e8400-e29b-41d4-a716-446655440012",
      status,
      headers: {},
    });

    for (const value of [2 ** 53, Infinity]) {
      expect(JoinCompleteBodySchema.safeParse(joinBody(value)).success).toBe(false);
      expect(HttpResponseBodySchema.safeParse(responseBody(value)).success).toBe(false);
    }
    for (const value of [Number.MAX_SAFE_INTEGER, 8080]) {
      expect(JoinCompleteBodySchema.safeParse(joinBody(value)).success).toBe(true);
      expect(HttpResponseBodySchema.safeParse(responseBody(value)).success).toBe(true);
    }
  });

  test("the wire frame refuses a seq beyond the safe integer range and accepts Number.MAX_SAFE_INTEGER", () => {
    const frame = (seq: number) => ({ type: 1, seq, ts: "t1", body: {} });
    expect(() => encodeWireMessage(frame(2 ** 53))).toThrow();
    expect(decodeWireMessage(encodeWireMessage(frame(Number.MAX_SAFE_INTEGER))).seq).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("a wire frame with no body key is accepted, as zod 3 accepted it", () => {
    const frame = encodeWireMessage({ type: 1, seq: 1, ts: "t1" } as unknown as Parameters<typeof encodeWireMessage>[0]);
    const decoded = decodeWireMessage(frame);
    expect(decoded.seq).toBe(1);
    expect(decoded.body).toBeUndefined();
  });

  test("the receipt validator refuses a bodyLength beyond the safe integer range and accepts Number.MAX_SAFE_INTEGER", () => {
    const receipt = (bodyLength: number) => ({
      from: "remote",
      to: "local",
      timestamp: new Date().toISOString(),
      bodySha256: createHash("sha256").update("x", "utf8").digest("hex"),
      bodyLength,
    });
    expect(RelayAcceptReceiptSchema.safeParse(receipt(2 ** 53)).success).toBe(false);
    expect(RelayAcceptReceiptSchema.safeParse(receipt(Number.MAX_SAFE_INTEGER)).success).toBe(true);
  });

  test("a digest receipt refuses a bodyLength beyond the safe integer range and compares Number.MAX_SAFE_INTEGER", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const bodySha256 = createHash("sha256").update(item.content, "utf8").digest("hex");
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    const receipt = (bodyLength: number) => JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, bodySha256, bodyLength, body: item.content });

    // 2^53 fails the digest receipt shape, so the marker is refused, not matched by its body.
    writeFileSync(marker, receipt(2 ** 53));
    expect(() => deliverRelayedToLocal("remote", item)).toThrow(/conflict/);

    // Number.MAX_SAFE_INTEGER passes the digest receipt schema, whose bodyLength is then compared.
    writeFileSync(marker, receipt(Number.MAX_SAFE_INTEGER));
    expect(() => deliverRelayedToLocal("remote", item)).toThrow(/conflict/);
  });

  test("a receipt carrying a valid digest is read as a digest receipt, not by its body", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const bodySha256 = createHash("sha256").update(item.content, "utf8").digest("hex");
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, bodySha256, bodyLength: 1, body: "y" }));

    expect(deliverRelayedToLocal("remote", item)).toBe(false);
  });

  test("a legacy-only receipt is still matched by its body digest", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, body: item.content }));

    expect(deliverRelayedToLocal("remote", item)).toBe(false);
  });

  test("a legacy-only receipt is matched when Object.prototype carries a bodyLength and the receipt has no own digest field", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, body: item.content }));

    Object.defineProperty(Object.prototype, "bodyLength", { value: 1, configurable: true, writable: true });
    try {
      expect(deliverRelayedToLocal("remote", item)).toBe(false);
    } finally {
      delete (Object.prototype as { bodyLength?: number }).bodyLength;
    }
    expect("bodyLength" in {}).toBe(false);
  });

  test("a receipt with an own bodySha256 and an inherited bodyLength raises the conflict", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const bodySha256 = createHash("sha256").update(item.content, "utf8").digest("hex");
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, bodySha256 }));

    Object.defineProperty(Object.prototype, "bodyLength", { value: Buffer.byteLength(item.content, "utf8"), configurable: true, writable: true });
    try {
      expect(() => deliverRelayedToLocal("remote", item)).toThrow(/conflict/);
    } finally {
      delete (Object.prototype as { bodyLength?: number }).bodyLength;
    }
    expect("bodyLength" in {}).toBe(false);
  });

  test("a legacy-only receipt with both digest fields inherited is compared by its body and raises the conflict", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const bodySha256 = createHash("sha256").update(item.content, "utf8").digest("hex");
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, body: "y" }));

    Object.defineProperty(Object.prototype, "bodySha256", { value: bodySha256, configurable: true, writable: true });
    Object.defineProperty(Object.prototype, "bodyLength", { value: Buffer.byteLength(item.content, "utf8"), configurable: true, writable: true });
    try {
      expect(() => deliverRelayedToLocal("remote", item)).toThrow(/conflict/);
    } finally {
      delete (Object.prototype as { bodySha256?: string }).bodySha256;
      delete (Object.prototype as { bodyLength?: number }).bodyLength;
    }
    expect("bodySha256" in {}).toBe(false);
    expect("bodyLength" in {}).toBe(false);
  });

  test("a digest-only receipt with a bodyLength beyond the safe integer range is refused", () => {
    const item = { id: randomUUID(), from: "remote", to: "local", content: "x", timestamp: new Date().toISOString() };
    const bodySha256 = createHash("sha256").update(item.content, "utf8").digest("hex");
    const marker = relayAcceptanceReceiptPath("remote", item.id);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ from: item.from, to: item.to, timestamp: item.timestamp, bodySha256, bodyLength: 2 ** 53 }));

    expect(() => deliverRelayedToLocal("remote", item)).toThrow(/conflict/);
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
