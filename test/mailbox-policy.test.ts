import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../packages/agent/src/lib/signEnvelope.js";
import { placeCurRecord } from "../packages/agent/src/lib/mailbox-policy.js";

describe("validated delivery content", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mailbox-policy-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const envelope = () => ({
    v: 1, from: "flint", to: "kern", body: "hello", messageId: "record-id",
    timestamp: new Date().toISOString(), signature: "parsed-only",
    delegationChain: [{ agent: "flint", kind: "agent", signature: null }],
  });
  const plant = (name: string, env: unknown) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify({ envelope: env }));
    return path;
  };

  test("two empty envelopes are malformed rather than duplicate", () => {
    const source = plant("new", {});
    const destination = plant("cur", {});
    expect(placeCurRecord(source, destination, JSON.parse(readFileSync(source, "utf8")).envelope as Envelope, "promoted-envelope")).toEqual({ status: "malformed" });
    expect(readFileSync(destination, "utf8")).toBe('{"envelope":{}}');
    expect(readFileSync(source, "utf8")).toBe('{"envelope":{}}');
  });

  for (const field of ["from", "to", "body", "messageId", "timestamp", "signature"]) {
    for (const value of [undefined, ""]) {
      test(`${field}=${String(value)} is not comparable`, () => {
        const source = plant("new", { ...envelope(), [field]: value });
        const destination = plant("cur", { ...envelope(), [field]: value });
        expect(placeCurRecord(source, destination, JSON.parse(readFileSync(source, "utf8")).envelope as Envelope, "promoted-envelope")).toEqual({ status: "malformed" });
      });
    }
  }

  test("same delivery content ignores a different messageId", () => {
    const source = plant("new", envelope());
    const destination = plant("cur", { ...envelope(), messageId: "other-id" });
    expect(placeCurRecord(source, destination, JSON.parse(readFileSync(source, "utf8")).envelope as Envelope, "promoted-envelope")).toEqual({ status: "duplicate", existingId: "other-id" });
  });

  test("a non-record destination is a storage failure", () => {
    const source = plant("new", envelope());
    const destination = plant("cur", {});
    expect(() => placeCurRecord(source, destination, JSON.parse(readFileSync(source, "utf8")).envelope as Envelope, "promoted-envelope")).toThrow("destination is not a valid delivery record");
  });

  test("a promoted record compares its envelope even when its display body is envelope-shaped JSON", () => {
    const incoming = envelope();
    const source = plant("new", incoming);
    const destination = plant("cur", { ...incoming, messageId: "other-id" });
    writeFileSync(destination, JSON.stringify({
      envelope: { ...incoming, messageId: "other-id" },
      body: JSON.stringify({ ...incoming, body: "display-only", messageId: "decoy-id" }),
    }));
    expect(placeCurRecord(source, destination, incoming as Envelope, "promoted-envelope"))
      .toEqual({ status: "duplicate", existingId: "other-id" });
  });

  for (const overrides of [{ subject: {} }, { replyToId: {} }, { replyToId: "" }, { delegationChain: [] }]) {
    test(`invalid comparison fields ${JSON.stringify(overrides)} never permit a duplicate`, () => {
      const incoming = { ...envelope(), ...overrides };
      const source = plant("new", incoming);
      const destination = plant("cur", incoming);
      expect(placeCurRecord(source, destination, incoming as Envelope, "promoted-envelope"))
        .toEqual({ status: "malformed" });
    });
  }

  test("a symlink destination is a storage failure", () => {
    const source = plant("new", envelope());
    const record = plant("record", envelope());
    const destination = join(root, "cur");
    symlinkSync(record, destination);
    expect(() => placeCurRecord(source, destination, JSON.parse(readFileSync(source, "utf8")).envelope as Envelope, "promoted-envelope")).toThrow("not a regular file");
  });
});
