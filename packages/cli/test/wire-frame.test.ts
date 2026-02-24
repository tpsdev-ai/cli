import { describe, test, expect } from "bun:test";
import { decodeWireMessage, encodeWireMessage, extractWireFrames } from "../src/utils/wire-frame.js";

describe("wire frame", () => {
  test("encodes and decodes a messagepack frame", () => {
    const msg = {
      type: 0x01,
      seq: 42,
      ts: new Date().toISOString(),
      body: { text: "hello" },
      sig: "abc",
    };

    const frame = encodeWireMessage(msg);
    const decoded = decodeWireMessage(frame);
    expect(decoded.type).toBe(0x01);
    expect(decoded.seq).toBe(42);
    expect((decoded.body as any).text).toBe("hello");
  });

  test("extracts multiple frames from a single buffer", () => {
    const a = encodeWireMessage({ type: 1, seq: 1, ts: "t1", body: { a: 1 } });
    const b = encodeWireMessage({ type: 2, seq: 2, ts: "t2", body: { b: 2 } });
    const { messages, rest } = extractWireFrames(Buffer.concat([a, b]));
    expect(messages.length).toBe(2);
    expect(messages[0]!.type).toBe(1);
    expect(messages[1]!.type).toBe(2);
    expect(rest.length).toBe(0);
  });

  test("keeps partial trailing frame as rest", () => {
    const full = encodeWireMessage({ type: 1, seq: 1, ts: "t1", body: {} });
    const partial = full.subarray(0, full.length - 2);
    const { messages, rest } = extractWireFrames(partial);
    expect(messages.length).toBe(0);
    expect(rest.length).toBe(partial.length);
  });
});
