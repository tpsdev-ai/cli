import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queueOutboxMessage, drainOutbox } from "../src/utils/outbox.js";

describe("outbox", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-outbox-"));
    process.env.HOME = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
  });

  test("queueOutboxMessage writes to ~/.tps/outbox/new", () => {
    queueOutboxMessage("host", "hello", "austin");
    const files = readdirSync(join(root, ".tps", "outbox", "new"));
    expect(files.length).toBe(1);
  });

  test("queueOutboxMessage leaves no dot-prefixed tmp files after a successful write", () => {
    queueOutboxMessage("host", "hello", "austin");
    const all = readdirSync(join(root, ".tps", "outbox", "new"));
    expect(all.every((f) => !f.startsWith("."))).toBe(true);
  });

  test("drainOutbox returns messages and moves files to sent", () => {
    queueOutboxMessage("host", "hello", "austin");
    const rows = drainOutbox();
    expect(rows.length).toBe(1);
    expect(rows[0]?.to).toBe("host");

    const newFiles = readdirSync(join(root, ".tps", "outbox", "new"));
    const sentFiles = readdirSync(join(root, ".tps", "outbox", "sent"));
    expect(newFiles.length).toBe(0);
    expect(sentFiles.length).toBe(1);
  });

  test("drainOutbox ignores dot-prefixed in-flight tmp files (atomic-write race guard)", () => {
    // Simulate a writer that's mid-write: a dot-tmp file exists but the
    // final rename hasn't happened yet. drainOutbox must not try to parse it.
    const newDir = join(root, ".tps", "outbox", "new");
    queueOutboxMessage("host", "hello", "austin");
    writeFileSync(join(newDir, ".pending.json.tmp"), "{ partial", "utf-8");
    const rows = drainOutbox();
    expect(rows.length).toBe(1);
    expect(rows[0]?.body).toBe("hello");
    // The in-flight tmp file is untouched
    expect(existsSync(join(newDir, ".pending.json.tmp"))).toBe(true);
  });

  test("drainOutbox quarantines malformed JSON without throwing (defense in depth)", () => {
    // Inject a fully-published-but-corrupt file (not dot-prefixed) and prove
    // the daemon-equivalent loop doesn't crash. Pre-fix, this threw SyntaxError
    // and killed the branch daemon on tps-reed 2026-05-16T17:17Z.
    const newDir = join(root, ".tps", "outbox", "new");
    const sentDir = join(root, ".tps", "outbox", "sent");
    queueOutboxMessage("host", "good", "austin");
    writeFileSync(join(newDir, "2026-05-16-corrupt.json"), "", "utf-8");
    const rows = drainOutbox();
    expect(rows.length).toBe(1);
    expect(rows[0]?.body).toBe("good");
    expect(readdirSync(newDir).length).toBe(0);
    // Bad file lands in sent/ with a .malformed- prefix for forensics
    expect(readdirSync(sentDir).some((f) => f.startsWith(".malformed-"))).toBe(true);
  });
});
