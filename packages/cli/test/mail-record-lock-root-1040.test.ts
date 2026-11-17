import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MailRecordLockRootError,
  getInbox,
  updateExistingRecord,
} from "../src/utils/mail.js";
import { acquireMailLockSync } from "../src/utils/mail-lock.js";

let root: string;
let priorMailDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "record-lock-root-1040-"));
  priorMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
});

afterEach(() => {
  if (priorMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = priorMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function plantRecord(path: string, id: string): void {
  fs.writeFileSync(path, JSON.stringify({ id, body: "hello", read: false }));
}

function symlinkedLayout(): { inboxA: ReturnType<typeof getInbox>; mailboxB: string; targetA: string; targetB: string } {
  const inboxA = getInbox("mailbox-a");
  const mailboxB = join(root, "mailbox-b");
  fs.mkdirSync(mailboxB, { recursive: true });
  fs.symlinkSync(inboxA.cur, join(mailboxB, "cur"), "dir");
  return {
    inboxA,
    mailboxB,
    targetA: join(inboxA.cur, "record.json"),
    targetB: join(mailboxB, "cur", "record.json"),
  };
}

function refusal(update: () => unknown): MailRecordLockRootError {
  try {
    update();
  } catch (err) {
    expect(err).toBeInstanceOf(MailRecordLockRootError);
    return err as MailRecordLockRootError;
  }
  throw new Error("expected the update to be refused");
}

test("an update through a symlinked cur/ is refused and leaves the record unchanged", () => {
  const { inboxA, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true })));

  expect(fs.readFileSync(targetA, "utf8")).toBe(before);
  expect(err.message).toContain(targetB);
  expect(err.recordDir).toBe(inboxA.cur);
  expect(err.lockRoot).toBe(join(root, "mailbox-b"));
  expect(fs.readdirSync(inboxA.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("two mailbox lock holders cannot update one physical record", () => {
  const { inboxA, mailboxB, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const lockA = acquireMailLockSync(inboxA.root);
  expect(lockA).not.toBeNull();
  const lockB = acquireMailLockSync(mailboxB);
  expect(lockB).not.toBeNull();
  lockB!.release();

  let mutated = false;
  try {
    refusal(() =>
      updateExistingRecord(targetB, (record: { read: boolean }) => {
        mutated = true;
        return { ...record, read: true };
      }),
    );
  } finally {
    lockA!.release();
  }

  expect(mutated).toBe(false);
  expect(fs.readFileSync(targetA, "utf8")).toBe(before);

  // The mailbox that physically owns the record can still update it.
  const outcome = updateExistingRecord(targetA, (record: { read: boolean }) => ({ ...record, read: true }));
  expect(outcome.status).toBe("updated");
});

test("a normal non-symlinked update still succeeds", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");

  const outcome = updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }));

  expect(outcome.status).toBe("updated");
  expect(JSON.parse(fs.readFileSync(target, "utf8")).read).toBe(true);
});
