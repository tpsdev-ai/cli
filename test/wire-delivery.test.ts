import { describe, test, expect } from "bun:test";
import type { TpsMessage, TransportChannel } from "../src/utils/transport.js";
import { WireDeliveryTransport } from "../src/utils/wire-delivery.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";

class MockChannel implements TransportChannel {
  handlers: Array<(msg: TpsMessage) => void> = [];
  sent: TpsMessage[] = [];

  async send(msg: TpsMessage): Promise<void> {
    this.sent.push(msg);
  }

  onMessage(handler: (msg: TpsMessage) => void): void {
    this.handlers.push(handler);
  }

  offMessage(handler: (msg: TpsMessage) => void): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  emit(msg: TpsMessage): void {
    for (const h of [...this.handlers]) h(msg);
  }

  async close(): Promise<void> {}
  isAlive(): boolean { return true; }
  peerFingerprint(): string { return "mock"; }
}

describe("wire delivery", () => {
  test("removes handler after ack", async () => {
    const ch = new MockChannel();
    const transport = new WireDeliveryTransport(ch as unknown as TransportChannel, 1000);

    const promise = transport.deliver({
      from: "brancha",
      to: "kern",
      body: Buffer.from("hello", "utf-8"),
      headers: { "x-tps-id": "550e8400-e29b-41d4-a716-446655440011" },
    });

    await Promise.resolve();
    expect(ch.sent[0]?.type).toBe(MSG_MAIL_DELIVER);
    expect(ch.handlers.length).toBe(1);

    ch.emit({
      type: MSG_MAIL_ACK,
      seq: 1,
      ts: new Date().toISOString(),
      body: { id: "550e8400-e29b-41d4-a716-446655440011", accepted: true },
    });

    const res = await promise;
    expect(res.delivered).toBe(true);
    expect(ch.handlers.length).toBe(0);
  });

  test("removes handler on timeout", async () => {
    const ch = new MockChannel();
    const transport = new WireDeliveryTransport(ch as unknown as TransportChannel, 50);

    const res = await transport.deliver({
      from: "brancha",
      to: "kern",
      body: Buffer.from("hello", "utf-8"),
      headers: { "x-tps-id": "550e8400-e29b-41d4-a716-446655440012" },
    });

    expect(res.delivered).toBe(false);
    expect(res.error).toBe("timeout");
    expect(ch.handlers.length).toBe(0);
  });
});
