import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MailClient } from "../src/io/mail.js";
import { MemoryStore } from "../src/io/memory.js";
import { ContextManager } from "../src/io/context.js";

describe("MailClient", () => {
  let tmpDir: string;
  let client: MailClient;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-mail-test-"));
    client = new MailClient(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates required maildir directories on construction", () => {
    const { existsSync } = require("node:fs");
    expect(existsSync(join(tmpDir, "inbox", "new"))).toBe(true);
    expect(existsSync(join(tmpDir, "inbox", "cur"))).toBe(true);
    expect(existsSync(join(tmpDir, "outbox", "new"))).toBe(true);
  });

  test("checkNewMail returns empty when inbox is empty", async () => {
    const msgs = await client.checkNewMail();
    expect(msgs).toEqual([]);
  });

  test("checkNewMail returns and moves messages from new to cur", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmpDir, "inbox", "new", "test-1.json"), "hello world", "utf-8");

    const msgs = await client.checkNewMail();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.body).toBe("hello world");

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmpDir, "inbox", "new", "test-1.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "inbox", "cur", "test-1.json"))).toBe(true);
  });

  test("sendMail writes a file to outbox/new", async () => {
    await client.sendMail("host@tps", "hello from agent");

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(tmpDir, "outbox", "new"));
    expect(files.length).toBe(1);
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
