import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { TpsMessage, TransportChannel } from "../src/utils/transport.js";
import { startFlairProxy } from "../src/utils/flair-proxy.js";
import { MSG_HTTP_REQUEST, MSG_HTTP_RESPONSE } from "../src/utils/wire-mail.js";

class MockChannel implements TransportChannel {
  handlers: Array<(msg: TpsMessage) => void> = [];
  sent: TpsMessage[] = [];
  autoRespond = true;

  async send(msg: TpsMessage): Promise<void> {
    this.sent.push(msg);
    if (this.autoRespond && msg.type === MSG_HTTP_REQUEST) {
      const body = msg.body as any;
      queueMicrotask(() => {
        this.emit({
          type: MSG_HTTP_RESPONSE,
          seq: 0,
          ts: new Date().toISOString(),
          body: {
            reqId: body.reqId,
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: true, path: body.path }),
          },
        });
      });
    }
  }

  onMessage(handler: (msg: TpsMessage) => void): void { this.handlers.push(handler); }
  offMessage(handler: (msg: TpsMessage) => void): void { this.handlers = this.handlers.filter((h) => h !== handler); }
  emit(msg: TpsMessage): void { for (const h of [...this.handlers]) h(msg); }
  async close(): Promise<void> {}
  isAlive(): boolean { return true; }
  peerFingerprint(): string { return "mock"; }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("failed to resolve free port"));
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

describe("flair proxy", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  test("forwards HTTP requests over the transport channel", async () => {
    const ch = new MockChannel();
    const port = await getFreePort();
    const proxy = startFlairProxy(port, ch);
    cleanups.push(() => proxy.close());

    const res = await fetch(`http://127.0.0.1:${port}/Memory?q=test`, {
      method: "POST",
      headers: { authorization: "TPS-Ed25519 test" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, path: "/Memory?q=test" });
    expect(ch.sent[0]?.type).toBe(MSG_HTTP_REQUEST);
    expect((ch.sent[0]?.body as any).method).toBe("POST");
  });

  test("returns 502 when the tunnel does not respond", async () => {
    const ch = new MockChannel();
    ch.autoRespond = false;
    const port = await getFreePort();
    const proxy = startFlairProxy(port, ch);
    cleanups.push(() => proxy.close());

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
      return originalSetTimeout(fn, 5, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = originalClearTimeout;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/Memory`);
      expect(res.status).toBe(502);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
