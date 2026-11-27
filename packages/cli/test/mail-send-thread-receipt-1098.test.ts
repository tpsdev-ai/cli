/**
 * mail-send-thread-receipt-1098.test.ts — cli#1098: a local `tps mail send
 * --reply-to` also writes a receipt into the sender's own obligation store.
 * Every spawn runs with HOME inside the test's temp root (cli#430).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { threadReceiptPath } from "../src/utils/mail.js";
import { writeKeyFile } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const THREAD = "env-thread-1098";

describe("mail send --reply-to: the sender-owned thread receipt (cli#1098)", () => {
  let root: string;
  let mailDir: string;
  let home: string;
  let keysDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-1098-"));
    mailDir = join(root, "mail");
    home = join(root, "home");
    keysDir = join(root, "keys");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(mailDir, "agent-b"), { recursive: true }); // the recipient is local
    writeKeyFile(keysDir, "agent-a", Buffer.alloc(32, 0x02));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function send(flags: string[]): { status: number | null; stderr: string } {
    const r = spawnSync("bun", [TPS_BIN, "mail", "send", "agent-b", ...flags, "a reply"], {
      encoding: "utf-8",
      cwd: root,
      timeout: 30000,
      env: { ...process.env, HOME: home, TPS_MAIL_DIR: mailDir, TPS_TEST_KEYS_DIR: keysDir, TPS_AGENT_ID: "agent-a" },
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  function deliveredRecord(): any {
    const dir = join(mailDir, "agent-b", "new");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    return JSON.parse(readFileSync(join(dir, files[0]!), "utf-8"));
  }

  test("a threaded local send writes a 0600 receipt holding the delivered signed reply", () => {
    mkdirSync(join(mailDir, "agent-a"), { recursive: true });
    const r = send([`--reply-to=${THREAD}`]);
    expect(r.status, r.stderr).toBe(0);
    const record = deliveredRecord();
    const path = threadReceiptPath(mailDir, "agent-a", "agent-b", THREAD);
    const receipt = JSON.parse(readFileSync(path, "utf-8"));
    expect(receipt).toEqual({ replyId: record.id, replyToId: THREAD, to: "agent-b", signedReply: record.body });
    expect(JSON.parse(receipt.signedReply).replyToId).toBe(THREAD);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 40000);

  test("a send without --reply-to writes no receipt", () => {
    mkdirSync(join(mailDir, "agent-a"), { recursive: true });
    const r = send([]);
    expect(r.status, r.stderr).toBe(0);
    expect(deliveredRecord().from).toBe("agent-a");
    expect(existsSync(join(mailDir, "agent-a", ".obligations"))).toBe(false);
  }, 40000);

  test("a sender with no mailbox under the mail root gets no receipt, and no mailbox is created", () => {
    const r = send([`--reply-to=${THREAD}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(deliveredRecord().from).toBe("agent-a");
    expect(existsSync(join(mailDir, "agent-a"))).toBe(false);
  }, 40000);

  test("a receipt that cannot be written is reported, and the send still succeeds", () => {
    mkdirSync(join(mailDir, "agent-a"), { recursive: true });
    // A file where the store's directory belongs: the write fails for every uid.
    writeFileSync(join(mailDir, "agent-a", ".obligations"), "not a directory");
    const r = send([`--reply-to=${THREAD}`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("warning: message sent, but its thread receipt was not written");
    expect(deliveredRecord().from).toBe("agent-a");
  }, 40000);

  test("a receipt older than seven days is removed when the next is written; a newer one stays", () => {
    const dir = join(mailDir, "agent-a", ".obligations", "thread-receipts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.json"), "{}");
    writeFileSync(join(dir, "recent.json"), "{}");
    const day = 24 * 60 * 60;
    const now = Date.now() / 1000;
    utimesSync(join(dir, "old.json"), now - 8 * day, now - 8 * day);
    utimesSync(join(dir, "recent.json"), now - 6 * day, now - 6 * day);
    const r = send([`--reply-to=${THREAD}`]);
    expect(r.status, r.stderr).toBe(0);
    const written = basename(threadReceiptPath(mailDir, "agent-a", "agent-b", THREAD));
    expect(readdirSync(dir).sort()).toEqual([written, "recent.json"].sort());
  }, 40000);
});
