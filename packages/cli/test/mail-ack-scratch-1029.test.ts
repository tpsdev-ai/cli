import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as mail from "../src/utils/mail.js";
import { acquireMailLockSync } from "../src/utils/mail-lock.js";

afterEach(() => {
  mock.restore();
});

let root: string;
let priorMailDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "ack-scratch-1029-"));
  priorMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
});

afterEach(() => {
  if (priorMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = priorMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function scratchName(): string {
  return `.ack-${randomUUID()}.tmp`;
}

function plantRecord(path: string, id: string): void {
  fs.writeFileSync(path, JSON.stringify({ id, body: "hello", read: false }));
}

function makeOld(path: string, ageMs = DAY_MS): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(path, when, when);
}

function collectWarnings(): { lines: string[]; warn: ReturnType<typeof spyOn> } {
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, warn };
}

test("the sweep leaves a live writer's scratch reached through a leaf cur symlink", () => {
  const inboxA = mail.getInbox("mailbox-a");
  const mailboxB = join(root, "mailbox-b");
  fs.mkdirSync(mailboxB, { recursive: true });
  fs.symlinkSync(inboxA.cur, join(mailboxB, "cur"), "dir");
  const targetB = join(mailboxB, "cur", "record.json");
  plantRecord(targetB, "record-id");

  const lockA = acquireMailLockSync(inboxA.root);
  expect(lockA).not.toBeNull();
  const live = join(inboxA.cur, scratchName());
  const fd = fs.openSync(live, "w");
  fs.writeFileSync(fd, "{ partial");
  // Held long enough to outlive the sweep's minimum age: only the lock a
  // writer holds, not the file's age, says whether the scratch is live.
  makeOld(live);
  const { lines } = collectWarnings();
  try {
    expect(mail.ackMessageAtPath(targetB).read).toBe(true);
  } finally {
    lockA!.release();
    fs.closeSync(fd);
  }

  expect(fs.readFileSync(live, "utf8")).toBe("{ partial");
  expect(lines.filter((line) => line.includes("left ack scratch"))).toHaveLength(1);
});

test("the sweep leaves a scratch younger than the minimum age and removes an older one", () => {
  const cur = mail.getInbox("mailbox-a").cur;
  const target = join(cur, "record.json");
  plantRecord(target, "record-id");
  const fresh = join(cur, scratchName());
  fs.writeFileSync(fresh, "{ fresh");
  const old = join(cur, scratchName());
  fs.writeFileSync(old, "{ old");
  makeOld(old);

  const { lines } = collectWarnings();
  expect(mail.ackMessageAtPath(target).read).toBe(true);

  expect(fs.readFileSync(fresh, "utf8")).toBe("{ fresh");
  expect(fs.existsSync(old)).toBe(false);
  expect(lines.filter((line) => line.includes(fresh))).toHaveLength(1);
});

test("a failed listing warns with the directory and code, and the next ack retries", () => {
  const cur = mail.getInbox("mailbox-a").cur;
  const first = join(cur, "record-1.json");
  const second = join(cur, "record-2.json");
  plantRecord(first, "record-1");
  plantRecord(second, "record-2");

  const readdir = fs.readdirSync;
  let listings = 0;
  spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof readdir>) => {
    if (resolve(String(args[0])) === resolve(cur)) {
      listings++;
      if (listings === 1) throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return readdir(...args);
  }) as typeof readdir);

  const { lines } = collectWarnings();
  expect(mail.ackMessageAtPath(first).read).toBe(true);

  const failures = lines.filter((line) => line.includes(cur) && line.includes("EACCES"));
  expect(failures).toHaveLength(1);

  const leftover = join(cur, scratchName());
  fs.writeFileSync(leftover, "{ partial");
  makeOld(leftover);
  expect(mail.ackMessageAtPath(second).read).toBe(true);

  expect(listings).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(leftover)).toBe(false);
  expect(lines.filter((line) => line.includes("removed leftover ack scratch"))).toHaveLength(1);
});
