import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MailClient } from "../src/io/mail.js";
import { MemoryStore } from "../src/io/memory.js";
import { ContextManager } from "../src/io/context.js";

describe("MailClient", () => {
  let tmpDir: string;
  let keyPath: string;
  let client: MailClient;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-mail-test-"));
    // sendMail signs as the agent; give it a raw 32-byte Ed25519 seed.
    keyPath = join(tmpDir, "testagent.key");
    writeFileSync(keyPath, Buffer.alloc(32, 3));
    client = new MailClient(tmpDir, undefined, "testagent", undefined, keyPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates required maildir directories on construction", () => {
    const { existsSync } = require("node:fs");
    expect(existsSync(join(tmpDir, "testagent", "new"))).toBe(true);
    expect(existsSync(join(tmpDir, "testagent", "cur"))).toBe(true);
    expect(existsSync(join(tmpDir, "testagent", "outbox"))).toBe(true);
  });

  test("checkNewMail returns empty when inbox is empty", async () => {
    const msgs = await client.checkNewMail();
    expect(msgs).toEqual([]);
  });

  test("checkNewMail refuses to promote when no verifier is configured (cli#380 F1)", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    writeFileSync(join(tmpDir, "testagent", "new", "test-1.json"), "hello world", "utf-8");

    // No FlairClient → verification cannot run. An absent verifier must never
    // mean "promote without verifying": the record is NOT moved.
    const msgs = await client.checkNewMail();
    expect(msgs.length).toBe(0);
    expect(existsSync(join(tmpDir, "testagent", "new", "test-1.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "testagent", "cur", "test-1.json"))).toBe(false);
  });

  test("sendMail writes a signed envelope to outbox/new", async () => {
    await client.sendMail("host@tps", "hello from agent");

    const { readdirSync, readFileSync } = await import("node:fs");
    const files = readdirSync(join(tmpDir, "testagent", "outbox"));
    expect(files.length).toBe(1);
    const record = JSON.parse(readFileSync(join(tmpDir, "testagent", "outbox", files[0]!), "utf-8"));
    expect(record.from).toBe("testagent");
    const envelope = JSON.parse(record.body);
    expect(envelope.v).toBe(1);
    expect(envelope.from).toBe("testagent");
    expect(envelope.to).toBe("host@tps");
    expect(envelope.body).toBe("hello from agent");
    expect(envelope.signature).toMatch(/^ed25519:/);
  });

  test("sendMail refuses with a named error and writes nothing when no key exists", async () => {
    const keyless = new MailClient(tmpDir, undefined, "nokeyagent");
    await expect(keyless.sendMail("host@tps", "hi")).rejects.toThrow(/no Ed25519 private key/);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(tmpDir, "nokeyagent", "outbox")).filter((f) => f.endsWith(".json")).length).toBe(0);
  });
});

describe("MemoryStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-mem-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("append and readAll round-trip", () => {
    const store = new MemoryStore(join(tmpDir, "memory.jsonl"));
    store.append({ type: "test", ts: "2025-01-01T00:00:00Z", data: "hello" });
    const all = store.readAll();
    expect(all.length).toBe(1);
    expect(all[0]!.type).toBe("test");
    expect(all[0]!.data).toBe("hello");
  });

  test("redacts leaked secrets in stored JSON", () => {
    process.env.OPENAI_API_KEY = "secret-token";
    const store = new MemoryStore(join(tmpDir, "memory.jsonl"));
    store.append({ type: "provider", ts: "2025-01-01T00:00:00Z", data: { raw: "Authorization: secret-token" } });
    const all = store.readAll();
    expect(String(all[0]!.data)).not.toContain("secret-token");
    delete process.env.OPENAI_API_KEY;
  });

  test("readAll returns empty for missing file", () => {
    const store = new MemoryStore(join(tmpDir, "missing.jsonl"));
    expect(store.readAll()).toEqual([]);
  });
});

describe("ContextManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-ctx-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("getWindow returns empty for empty memory", async () => {
    const store = new MemoryStore(join(tmpDir, "mem.jsonl"));
    const ctx = new ContextManager(store, 1000);
    expect(await ctx.getWindow()).toEqual([]);
  });

  test("needsCompaction is false for empty memory", async () => {
    const store = new MemoryStore(join(tmpDir, "mem.jsonl"));
    const ctx = new ContextManager(store, 1000);
    expect(await ctx.needsCompaction()).toBe(false);
  });
});
