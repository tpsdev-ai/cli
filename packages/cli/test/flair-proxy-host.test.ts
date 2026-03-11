import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TpsMessage, TransportChannel } from "../src/utils/transport.js";
import { registerFlairProxyHandler } from "../src/utils/flair-proxy-host.js";
import { MSG_HTTP_REQUEST, MSG_HTTP_RESPONSE } from "../src/utils/wire-mail.js";

class MockChannel implements TransportChannel {
  handlers: Array<(msg: TpsMessage) => void> = [];
  sent: TpsMessage[] = [];

  async send(msg: TpsMessage): Promise<void> {
    this.sent.push(msg);
  }

  onMessage(handler: (msg: TpsMessage) => void): void { this.handlers.push(handler); }
  offMessage(handler: (msg: TpsMessage) => void): void { this.handlers = this.handlers.filter((h) => h !== handler); }
  emit(msg: TpsMessage): void { for (const h of [...this.handlers]) h(msg); }
  async close(): Promise<void> {}
  isAlive(): boolean { return true; }
  peerFingerprint(): string { return "mock"; }
}

describe("flair proxy host", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forwards tunneled requests to local Flair and responds", async () => {
    const ch = new MockChannel();
    registerFlairProxyHandler(ch);

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:9926/Memory");
      expect(init?.method).toBe("PUT");
      expect((init?.headers as Record<string, string>).host).toBe("localhost:9926");
      expect((init?.headers as Record<string, string>)["content-length"]).toBeUndefined();
      expect((init?.headers as Record<string, string>).connection).toBeUndefined();
      expect(init?.signal).toBeDefined();
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    ch.emit({
      type: MSG_HTTP_REQUEST,
      seq: 0,
      ts: new Date().toISOString(),
      body: {
        reqId: "550e8400-e29b-41d4-a716-446655440000",
        method: "PUT",
        path: "/Memory",
        headers: { authorization: "TPS-Ed25519 test" },
        body: "{}",
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ch.sent[0]?.type).toBe(MSG_HTTP_RESPONSE);
    expect((ch.sent[0]?.body as any).status).toBe(201);
  });

  test("rejects invalid proxy paths", async () => {
    const ch = new MockChannel();
    registerFlairProxyHandler(ch);

    ch.emit({
      type: MSG_HTTP_REQUEST,
      seq: 0,
      ts: new Date().toISOString(),
      body: {
        reqId: "550e8400-e29b-41d4-a716-446655440001",
        method: "GET",
        path: "//evil.test",
        headers: {},
      },
    });

    await Promise.resolve();

    expect(ch.sent[0]?.type).toBe(MSG_HTTP_RESPONSE);
    expect((ch.sent[0]?.body as any).status).toBe(400);
  });

  test("rejects dot-dot traversal paths", async () => {
    const ch = new MockChannel();
    registerFlairProxyHandler(ch);

    ch.emit({
      type: MSG_HTTP_REQUEST,
      seq: 0,
      ts: new Date().toISOString(),
      body: {
        reqId: "550e8400-e29b-41d4-a716-446655440002",
        method: "GET",
        path: "/../../etc/passwd",
        headers: {},
      },
    });

    await Promise.resolve();

    expect((ch.sent[0]?.body as any).status).toBe(400);
  });
});
