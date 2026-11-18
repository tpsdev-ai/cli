import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MailRecordLockRootError,
  getInbox,
  sameDirectory,
  updateExistingRecord,
} from "../src/utils/mail.js";
import { acquireMailLockSync, mailLockPath } from "../src/utils/mail-lock.js";

afterEach(() => {
  mock.restore();
});

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

/** True when the filesystem treats a different-case spelling as a different path. */
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

function symlinkedLayout(subdir: "cur" | "new" | "dlq" = "cur"): { inboxA: ReturnType<typeof getInbox>; mailboxB: string; source: string; targetA: string; targetB: string } {
  const inboxA = getInbox("mailbox-a");
  const mailboxB = join(root, "mailbox-b");
  fs.mkdirSync(mailboxB, { recursive: true });
  const source = subdir === "new" ? inboxA.fresh : subdir === "dlq" ? inboxA.dlq : inboxA.cur;
  fs.symlinkSync(source, join(mailboxB, subdir), "dir");
  return {
    inboxA,
    mailboxB,
    source,
    targetA: join(source, "record.json"),
    targetB: join(mailboxB, subdir, "record.json"),
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

test("sameDirectory compares device and inode, not path spelling", () => {
  const stats = new Map<string, fs.Stats>([
    ["/mail/a/cur", { dev: 7, ino: 42 } as fs.Stats],
    ["/mail/a/CUR", { dev: 7, ino: 42 } as fs.Stats],
    ["/mail/a/other", { dev: 7, ino: 43 } as fs.Stats],
    ["/mail/b/cur", { dev: 8, ino: 42 } as fs.Stats],
  ]);
  const stat = (path: string) => stats.get(path)!;
  expect(sameDirectory("/mail/a/cur", "/mail/a/CUR", stat)).toBe(true);
  expect(sameDirectory("/mail/a/cur", "/mail/a/other", stat)).toBe(false);
  expect(sameDirectory("/mail/a/cur", "/mail/b/cur", stat)).toBe(false);
});

test("an update through a symlinked cur/ is refused and leaves the record unchanged", () => {
  const { inboxA, mailboxB, source, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true })));

  const realRecordDir = fs.realpathSync(source);
  const realRoot = fs.realpathSync(mailboxB);
  expect(fs.readFileSync(targetA, "utf8")).toBe(before);
  expect(err.message).toContain(targetB);
  expect(err.message).toContain(realRecordDir);
  expect(err.message).toContain(realRoot);
  expect(err.message).toContain("mailbox that physically contains it");
  expect(err.recordDir).toBe(realRecordDir);
  expect(err.lockRoot).toBe(realRoot);
  expect(fs.readdirSync(source).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("a refused alias update does not parse the target record first", () => {
  const { targetB } = symlinkedLayout();
  fs.writeFileSync(targetB, "{ this is not json");

  const err = refusal(() => updateExistingRecord(targetB, () => ({ read: true })));

  expect(err.name).toBe("MailRecordLockRootError");
});

test("a refused alias whose record path is a directory still throws the lock-root error", () => {
  const { targetB } = symlinkedLayout();
  // Reading a directory throws EISDIR, so a raw read placed above the check
  // surfaces as EISDIR instead of the refusal.
  fs.mkdirSync(targetB, { recursive: true });

  const err = refusal(() => updateExistingRecord(targetB, () => ({ read: true })));

  expect(err.name).toBe("MailRecordLockRootError");
});

test("a refused alias update never attempts to create an ack scratch path", () => {
  const { source, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");

  const scratchAttempts: string[] = [];
  const record = (path: unknown) => {
    if (String(path).includes(".ack-")) scratchAttempts.push(String(path));
  };
  const realWriteFileSync = fs.writeFileSync;
  const realOpenSync = fs.openSync;
  spyOn(fs, "writeFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    record(path);
    return (realWriteFileSync as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof fs.writeFileSync);
  spyOn(fs, "openSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    record(path);
    return (realOpenSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync);

  refusal(() => updateExistingRecord(targetB, () => ({ read: true })));

  expect(scratchAttempts).toEqual([]);
  expect(fs.readdirSync(source).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("an update through a symlinked new/ is refused", () => {
  const { mailboxB, source, targetA, targetB } = symlinkedLayout("new");
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true })));

  expect(fs.readFileSync(targetA, "utf8")).toBe(before);
  expect(err.recordDir).toBe(fs.realpathSync(source));
  expect(err.lockRoot).toBe(fs.realpathSync(mailboxB));
});

test("an update through a symlinked dlq/ is refused", () => {
  const { mailboxB, source, targetA, targetB } = symlinkedLayout("dlq");
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true })));

  expect(fs.readFileSync(targetA, "utf8")).toBe(before);
  expect(err.recordDir).toBe(fs.realpathSync(source));
  expect(err.lockRoot).toBe(fs.realpathSync(mailboxB));
});

test("an alias update is refused while the owning mailbox's lock is held", () => {
  const { inboxA, mailboxB, source, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");
  const scratchesBefore = fs.readdirSync(source).filter((name) => name.startsWith(".ack-"));

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
    expect(err.recordDir).toBe(fs.realpathSync(source));
    expect(err.lockRoot).toBe(fs.realpathSync(mailboxB));
    expect(fs.existsSync(mailLockPath(mailboxB))).toBe(false);
    expect(mutated).toBe(false);
    expect(fs.readFileSync(targetA, "utf8")).toBe(before);
    expect(fs.readdirSync(source).filter((name) => name.startsWith(".ack-"))).toEqual(scratchesBefore);
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

  // A second update runs through the BUILT module under node, the plugin's
  // production runtime, whose realpathSync keeps the given letter case.
  const distMail = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "utils", "mail.js");
  const script = [
    `import { updateExistingRecord } from ${JSON.stringify(pathToFileURL(distMail).href)};`,
    `const outcome = updateExistingRecord(${JSON.stringify(aliasedPath)}, (record) => ({ ...record, read: true }));`,
    `if (outcome.status !== "updated") { console.error("status " + outcome.status); process.exit(2); }`,
  ].join("\n");
  const run = spawnSync("node", ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 30_000 });
  expect(run.status, `node refused the alias update: ${run.stderr}${run.stdout}`).toBe(0);
});

test("a normal non-symlinked update still succeeds", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");

  const outcome = updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }));

  expect(outcome.status).toBe("updated");
  expect(JSON.parse(fs.readFileSync(target, "utf8")).read).toBe(true);
});
