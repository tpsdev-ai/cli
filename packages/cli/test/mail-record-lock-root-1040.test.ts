import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  MailRecordLockRootError,
  getInbox,
  updateExistingRecord,
} from "../src/utils/mail.js";
import { acquireMailLockSync, mailLockPath } from "../src/utils/mail-lock.js";

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

function swapCase(segment: string): string {
  return segment.replace(/[a-zA-Z]/g, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
}

/** True when a different-case spelling of one directory names that same directory. */
function caseSensitiveFs(): boolean {
  const probe = fs.mkdtempSync(join(tmpdir(), "record-lock-probe-"));
  try {
    try {
      return fs.statSync(join(dirname(probe), swapCase(basename(probe)))).ino !== fs.statSync(probe).ino;
    } catch {
      return true;
    }
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const caseSensitive = caseSensitiveFs();
if (caseSensitive) {
  console.warn("[mail] different-letter-case alias test skipped: this filesystem is case-sensitive, so the alternate spelling does not resolve");
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
  const { inboxA, mailboxB, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true })));

  expect(fs.readFileSync(targetA, "utf8")).toBe(before);
  expect(err.message).toContain(targetB);
  expect(err.recordDir).toBe(fs.realpathSync(inboxA.cur));
  expect(err.lockRoot).toBe(fs.realpathSync(mailboxB));
  expect(fs.readdirSync(inboxA.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("an alias update is refused while the owning mailbox's lock is held", () => {
  const { inboxA, mailboxB, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");
  const scratchesBefore = fs.readdirSync(inboxA.cur).filter((name) => name.startsWith(".ack-"));

  const lockA = acquireMailLockSync(inboxA.root);
  expect(lockA).not.toBeNull();
  try {
    // The alias's lock root is free now, so the update takes that lock itself
    // (this process cannot hold the same root twice) and releases it on the
    // refusal: both mailbox locks are held while the record directory is checked.
    expect(fs.existsSync(mailLockPath(mailboxB))).toBe(false);
    let mutated = false;
    const err = refusal(() =>
      updateExistingRecord(targetB, (record: { read: boolean }) => {
        mutated = true;
        return { ...record, read: true };
      }),
    );
    expect(err.recordDir).toBe(fs.realpathSync(inboxA.cur));
    expect(err.lockRoot).toBe(fs.realpathSync(mailboxB));
    expect(fs.existsSync(mailLockPath(mailboxB))).toBe(false);
    expect(mutated).toBe(false);
    expect(fs.readFileSync(targetA, "utf8")).toBe(before);
    expect(fs.readdirSync(inboxA.cur).filter((name) => name.startsWith(".ack-"))).toEqual(scratchesBefore);
  } finally {
    lockA!.release();
  }

  // The mailbox that physically owns the record can still update it.
  const outcome = updateExistingRecord(targetA, (record: { read: boolean }) => ({ ...record, read: true }));
  expect(outcome.status).toBe("updated");
});

test.skipIf(caseSensitive)("an alias spelled with different letter case is not refused", () => {
  // Same mailbox, same physical record: the alias resolves to the same cur/
  // through a spelling whose letters are all flipped.
  const mailbox = getInbox("mailbox-case").root;
  const altRoot = join(dirname(mailbox), swapCase(basename(mailbox)));
  fs.symlinkSync(join(altRoot, swapCase("cur")), join(mailbox, "cur-alias"), "dir");
  const recordPath = join(mailbox, "cur", "record.json");
  const aliasedPath = join(mailbox, "cur-alias", "record.json");
  plantRecord(recordPath, "record-id");
  const before = fs.readFileSync(recordPath, "utf8");

  const outcome = updateExistingRecord(aliasedPath, (record: { read: boolean }) => ({ ...record, read: true }));

  expect(outcome.status).toBe("updated");
  expect(fs.readFileSync(recordPath, "utf8")).not.toBe(before);
  expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).read).toBe(true);
  expect(fs.readdirSync(join(mailbox, "cur")).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("a normal non-symlinked update still succeeds", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");

  const outcome = updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }));

  expect(outcome.status).toBe("updated");
  expect(JSON.parse(fs.readFileSync(target, "utf8")).read).toBe(true);
});
