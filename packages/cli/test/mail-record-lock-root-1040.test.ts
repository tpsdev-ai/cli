import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  MailRecordFileTypeError,
  MailRecordLayoutError,
  MailRecordLockRootError,
  getInbox,
  mailRecordFileTestHooks,
  sameDirectory,
  updateExistingRecord,
} from "../src/utils/mail.js";
import { acquireMailLockSync, mailLockPath } from "../src/utils/mail-lock.js";
import { freshDistMail, requireFreshDist } from "./helpers/fresh-dist.js";
import { createPatchShared } from "./helpers/patch-shared.js";

const patchShared = createPatchShared();

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
  const stats = new Map<string, fs.BigIntStats>([
    ["/mail/a/cur", { dev: 7n, ino: 42n } as fs.BigIntStats],
    ["/mail/a/CUR", { dev: 7n, ino: 42n } as fs.BigIntStats],
    ["/mail/a/other", { dev: 7n, ino: 43n } as fs.BigIntStats],
    ["/mail/b/cur", { dev: 8n, ino: 42n } as fs.BigIntStats],
  ]);
  const stat = (path: string) => stats.get(path)!;
  expect(sameDirectory("/mail/a/cur", "/mail/a/CUR", stat)).toBe(true);
  expect(sameDirectory("/mail/a/cur", "/mail/a/other", stat)).toBe(false);
  expect(sameDirectory("/mail/a/cur", "/mail/b/cur", stat)).toBe(false);
});

test("sameDirectory distinguishes inodes above the safe-integer limit", () => {
  const stats = new Map<string, fs.BigIntStats>([
    ["/mail/a/cur", { dev: 7n, ino: 9007199254740992n } as fs.BigIntStats],
    ["/mail/b/cur", { dev: 7n, ino: 9007199254740993n } as fs.BigIntStats],
  ]);
  const stat = (path: string) => stats.get(path)!;
  expect(sameDirectory("/mail/a/cur", "/mail/b/cur", stat)).toBe(false);
});

test("sameDirectory's default reader requests bigint stats for high inodes", () => {
  const inodes = new Map([
    ["/mail/a/cur", 9007199254740992n],
    ["/mail/b/cur", 9007199254740993n],
  ]);
  const optionsSeen: unknown[] = [];
  spyOn(fs, "statSync").mockImplementation(((path: unknown, options?: { bigint?: boolean }) => {
    optionsSeen.push(options);
    const ino = inodes.get(String(path))!;
    return options?.bigint ? { dev: 7n, ino } : { dev: 7, ino: Number(ino) };
  }) as typeof fs.statSync);

  const result = sameDirectory("/mail/a/cur", "/mail/b/cur");

  expect(result).toBe(false);
  expect(optionsSeen).toEqual([{ bigint: true }, { bigint: true }]);
});

test("an update through a symlinked cur/ is refused and leaves the record unchanged", () => {
  const { inboxA, mailboxB, source, targetA, targetB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: mailboxB }));

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
  const { mailboxB, targetB } = symlinkedLayout();
  fs.writeFileSync(targetB, "{ this is not json");

  const err = refusal(() => updateExistingRecord(targetB, () => ({ read: true }), { mailboxRoot: mailboxB }));

  expect(err.name).toBe("MailRecordLockRootError");
});

test("a refused alias whose record path is a directory still throws the lock-root error", () => {
  const { mailboxB, targetB } = symlinkedLayout();
  // Reading a directory throws EISDIR, so a raw read placed above the check
  // surfaces as EISDIR instead of the refusal.
  fs.mkdirSync(targetB, { recursive: true });

  const err = refusal(() => updateExistingRecord(targetB, () => ({ read: true }), { mailboxRoot: mailboxB }));

  expect(err.name).toBe("MailRecordLockRootError");
});

test("a refused alias update never attempts to create an ack scratch path", () => {
  const { source, mailboxB, targetB } = symlinkedLayout();
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

  refusal(() => updateExistingRecord(targetB, () => ({ read: true }), { mailboxRoot: mailboxB }));

  expect(scratchAttempts).toEqual([]);
  expect(fs.readdirSync(source).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("an update through a symlinked new/ is refused", () => {
  const { mailboxB, source, targetA, targetB } = symlinkedLayout("new");
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: mailboxB }));

  expect(fs.readFileSync(targetA, "utf8")).toBe(before);
  expect(err.recordDir).toBe(fs.realpathSync(source));
  expect(err.lockRoot).toBe(fs.realpathSync(mailboxB));
});

test("an update through a symlinked dlq/ is refused", () => {
  const { mailboxB, source, targetA, targetB } = symlinkedLayout("dlq");
  plantRecord(targetB, "record-id");
  const before = fs.readFileSync(targetA, "utf8");

  const err = refusal(() => updateExistingRecord(targetB, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: mailboxB }));

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
      }, { mailboxRoot: mailboxB }),
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
  const outcome = updateExistingRecord(targetA, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: inboxA.root });
  expect(outcome.status).toBe("updated");
});

test("the record-directory check runs while the alias mailbox's lock is held", () => {
  const { source, targetB, mailboxB } = symlinkedLayout();
  plantRecord(targetB, "record-id");
  const aliasRecordDir = join(mailboxB, "cur");
  const lockDir = mailLockPath(mailboxB);
  const observed: { ownerPid: unknown }[] = [];
  const realpath = fs.realpathSync;
  spyOn(fs, "realpathSync").mockImplementation(((...args: Parameters<typeof realpath>) => {
    if (String(args[0]) === aliasRecordDir) {
      // The lock's own owner record is read at the instant the check resolves
      // the record directory: it is absent while the root lock is not held.
      let ownerPid: unknown = null;
      try {
        ownerPid = (JSON.parse(fs.readFileSync(join(lockDir, "owner.json"), "utf-8")) as { pid?: unknown }).pid;
      } catch {
        ownerPid = null;
      }
      observed.push({ ownerPid });
    }
    return realpath(...args);
  }) as typeof realpath);

  const err = refusal(() => updateExistingRecord(targetB, () => ({ read: true }), { mailboxRoot: mailboxB }));

  expect(err.recordDir).toBe(fs.realpathSync(source));
  expect(observed).toHaveLength(1);
  expect(observed[0].ownerPid).toBe(process.pid);
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

  const outcome = updateExistingRecord(aliasedPath, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: mailbox });

  expect(outcome.status).toBe("updated");
  expect(fs.readFileSync(recordPath, "utf8")).not.toBe(before);
  expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).read).toBe(true);
  expect(fs.readdirSync(join(mailbox, "cur")).filter((name) => name.startsWith(".ack-"))).toEqual([]);

  // A second update runs through the BUILT module under node, the plugin's
  // production runtime, whose realpathSync keeps the given letter case.
  const distMail = freshDistMail(import.meta.url);
  const script = [
    `const { updateExistingRecord } = await import(process.argv[1]);`,
    `const outcome = updateExistingRecord(process.argv[2], (record) => ({ ...record, read: true }), { mailboxRoot: process.argv[3] });`,
    `if (outcome.status !== "updated") { console.error("status " + outcome.status); process.exit(2); }`,
  ].join("\n");
  const run = spawnSync("node", ["--input-type=module", "--eval", script, pathToFileURL(distMail).href, aliasedPath, mailbox], { encoding: "utf8", timeout: 30_000 });
  expect(run.status, `node refused the alias update: ${run.stderr}${run.stdout}`).toBe(0);
});

test("a normal non-symlinked update still succeeds", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");

  const outcome = updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: inbox.root });

  expect(outcome.status).toBe("updated");
  expect(JSON.parse(fs.readFileSync(target, "utf8")).read).toBe(true);
});

test("an update through a symlink to the whole mailbox succeeds", () => {
  const inbox = getInbox("mailbox-a");
  const mailboxLink = join(root, "mailbox-link");
  fs.symlinkSync(inbox.root, mailboxLink, "dir");
  const target = join(mailboxLink, "cur", "record.json");
  plantRecord(target, "record-id");

  const outcome = updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: mailboxLink });

  expect(outcome.status).toBe("updated");
  expect(JSON.parse(fs.readFileSync(join(inbox.cur, "record.json"), "utf8")).read).toBe(true);
});

test("a record directly in a mailbox root is refused and leaves the record unchanged", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.root, "record.json");
  plantRecord(target, "record-id");
  const before = fs.readFileSync(target, "utf8");

  expect(() => updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: inbox.root })).toThrow(MailRecordLayoutError);

  expect(fs.readFileSync(target, "utf8")).toBe(before);
});

test("a record in the root of a mailbox named cur is refused under that mailbox's lock", () => {
  const inbox = getInbox("cur");
  const target = join(inbox.root, "record.json");
  plantRecord(target, "record-id");
  const before = fs.readFileSync(target);

  // Holding the store lock makes an update that derives its lock root from the
  // record path report `busy` instead of the layout refusal; a `nonBlocking`
  // caller is enough to tell those apart without waiting on a timeout.
  const storeLock = acquireMailLockSync(root);
  expect(storeLock).not.toBeNull();
  try {
    expect(() =>
      updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }), {
        mailboxRoot: inbox.root,
        nonBlocking: true,
      }),
    ).toThrow(MailRecordLayoutError);
  } finally {
    storeLock!.release();
  }

  expect(fs.readFileSync(target)).toEqual(before);
});

test("a normal record in a mailbox named cur still updates", () => {
  const inbox = getInbox("cur");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");

  const outcome = updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: inbox.root });

  expect(outcome.status).toBe("updated");
  expect(JSON.parse(fs.readFileSync(target, "utf8")).read).toBe(true);
});

test("a record swapped for a symlink between the check and the read is refused without reading the target", () => {
  const inbox = getInbox("mailbox-a");
  const other = getInbox("mailbox-b");
  const target = join(inbox.cur, "record.json");
  const elsewhere = join(other.cur, "target.json");
  plantRecord(target, "record-id");
  plantRecord(elsewhere, "target-id");
  const targetBytes = fs.readFileSync(elsewhere, "utf8");

  const reads: string[] = [];
  const realRead = fs.readFileSync;
  spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (String(path) === elsewhere) reads.push(String(path));
    return (realRead as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  const mutations: string[] = [];
  const restoreHook = patchShared(mailRecordFileTestHooks, "beforeOpen", () => {
    fs.rmSync(target);
    fs.symlinkSync(elsewhere, target);
  });
  try {
    expect(() =>
      updateExistingRecord(target, (record: { read: boolean }) => {
        mutations.push("mutated");
        return { ...record, read: true };
      }, { mailboxRoot: inbox.root }),
    ).toThrow(MailRecordFileTypeError);
  } finally {
    restoreHook();
  }

  expect(reads).toEqual([]);
  expect(mutations).toEqual([]);
  expect(fs.readlinkSync(target)).toBe(elsewhere);
  expect(fs.readFileSync(elsewhere, "utf8")).toBe(targetBytes);
  expect(fs.readdirSync(inbox.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
  const lock = acquireMailLockSync(inbox.root, { timeoutMs: 0 });
  expect(lock).not.toBeNull();
  lock!.release();
});

test("a record swapped for a symlink after the scratch write is refused before the rename", () => {
  const inbox = getInbox("mailbox-a");
  const other = getInbox("mailbox-b");
  const target = join(inbox.cur, "record.json");
  const elsewhere = join(other.cur, "target.json");
  plantRecord(target, "record-id");
  plantRecord(elsewhere, "target-id");
  const targetBytes = fs.readFileSync(elsewhere, "utf8");

  const renames: string[] = [];
  const realRename = fs.renameSync;
  spyOn(fs, "renameSync").mockImplementation(((from: unknown, to: unknown) => {
    renames.push(`${String(from)} -> ${String(to)}`);
    return (realRename as (...args: unknown[]) => unknown)(from, to);
  }) as typeof fs.renameSync);
  const restoreHook = patchShared(mailRecordFileTestHooks, "beforeRename", () => {
    fs.rmSync(target);
    fs.symlinkSync(elsewhere, target);
  });
  try {
    expect(() =>
      updateExistingRecord(target, (record: { read: boolean }) => ({ ...record, read: true }), { mailboxRoot: inbox.root }),
    ).toThrow(MailRecordFileTypeError);
  } finally {
    restoreHook();
  }

  expect(renames.filter((entry) => entry.includes(".ack-") || entry.endsWith(target))).toEqual([]);
  expect(fs.readlinkSync(target)).toBe(elsewhere);
  expect(fs.readFileSync(elsewhere, "utf8")).toBe(targetBytes);
  expect(fs.readdirSync(inbox.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
  const lock = acquireMailLockSync(inbox.root, { timeoutMs: 0 });
  expect(lock).not.toBeNull();
  lock!.release();
});

test("a record replaced by a symlink during the mutation is refused before the rename", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  const elsewhere = join(root, "elsewhere.json");
  plantRecord(target, "record-id");
  fs.writeFileSync(elsewhere, "{ keep me");

  expect(() =>
    updateExistingRecord(target, (record: { read: boolean }) => {
      fs.rmSync(target);
      fs.symlinkSync(elsewhere, target);
      return { ...record, read: true };
    }, { mailboxRoot: inbox.root }),
  ).toThrow(MailRecordFileTypeError);

  expect(fs.readFileSync(target, "utf8")).toBe("{ keep me");
  expect(fs.readlinkSync(target)).toBe(elsewhere);
  expect(fs.readdirSync(inbox.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
  const lock = acquireMailLockSync(inbox.root);
  expect(lock).not.toBeNull();
  lock!.release();
});

test("a record replaced by a symlink during the mutation is refused before any scratch is opened", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  const liveTarget = join(root, "live.json");
  const danglingTarget = join(root, "absent.json");
  fs.writeFileSync(liveTarget, JSON.stringify({ id: "elsewhere", body: "keep me" }));
  const liveBytes = fs.readFileSync(liveTarget, "utf8");

  for (const linkTarget of [liveTarget, danglingTarget]) {
    fs.rmSync(target, { force: true });
    plantRecord(target, "record-id");

    const scratchOpens: string[] = [];
    const realOpen = fs.openSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(".ack-")) scratchOpens.push(String(path));
      return (realOpen as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync);
    let reachedScratchWrite = false;
    const restoreRenameHook = patchShared(mailRecordFileTestHooks, "beforeRename", () => {
      reachedScratchWrite = true;
    });

    try {
      expect(() =>
        updateExistingRecord(target, (record: { read: boolean }) => {
          fs.rmSync(target);
          fs.symlinkSync(linkTarget, target);
          return { ...record, read: true };
        }, { mailboxRoot: inbox.root }),
      ).toThrow(MailRecordFileTypeError);
    } finally {
      restoreRenameHook();
      openSpy.mockRestore();
    }

    // The pre-scratch check refused it: the scratch open was never reached.
    expect(scratchOpens).toEqual([]);
    expect(reachedScratchWrite).toBe(false);
    expect(fs.readlinkSync(target)).toBe(linkTarget);
    if (linkTarget === liveTarget) expect(fs.readFileSync(liveTarget, "utf8")).toBe(liveBytes);
    else expect(fs.existsSync(linkTarget)).toBe(false);
    expect(fs.readdirSync(inbox.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
    const lock = acquireMailLockSync(inbox.root, { timeoutMs: 0 });
    expect(lock).not.toBeNull();
    lock!.release();
  }
});

test("an update without an expected mailbox root is refused and leaves the record and lock free", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");
  const before = fs.readFileSync(target, "utf8");

  for (const options of [{ mailboxRoot: "" }, {} as { mailboxRoot: string }]) {
    expect(() => updateExistingRecord(target, () => ({ read: true }), options)).toThrow(/requires the expected mailbox root/);
  }

  expect(fs.readFileSync(target, "utf8")).toBe(before);
  expect(fs.readdirSync(inbox.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
  const lock = acquireMailLockSync(inbox.root, { timeoutMs: 0 });
  expect(lock).not.toBeNull();
  lock!.release();
});

test("a record path that is a symlink into another mailbox is refused without reading or replacing the target", () => {
  const inboxA = getInbox("mailbox-a");
  const inboxB = getInbox("mailbox-b");
  const realRecord = join(inboxA.cur, "record.json");
  plantRecord(realRecord, "record-id");
  const recordLink = join(inboxB.cur, "link.json");
  fs.symlinkSync(realRecord, recordLink);
  const beforeBytes = fs.readFileSync(realRecord, "utf8");
  const beforeStat = fs.lstatSync(realRecord);

  const reads: string[] = [];
  const renames: string[] = [];
  const watched = new Set([recordLink, realRecord]);
  const realRead = fs.readFileSync;
  const realRename = fs.renameSync;
  spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (watched.has(String(path))) reads.push(String(path));
    return (realRead as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  spyOn(fs, "renameSync").mockImplementation(((from: unknown, to: unknown) => {
    renames.push(`${String(from)} -> ${String(to)}`);
    return (realRename as (...args: unknown[]) => unknown)(from, to);
  }) as typeof fs.renameSync);

  expect(() => updateExistingRecord(recordLink, () => ({ read: true }), { mailboxRoot: inboxB.root })).toThrow(MailRecordFileTypeError);

  expect(reads).toEqual([]);
  expect(renames.filter((entry) => entry.includes(".ack-") || entry.endsWith(recordLink))).toEqual([]);
  expect(fs.readFileSync(realRecord, "utf8")).toBe(beforeBytes);
  const afterStat = fs.lstatSync(realRecord);
  expect(afterStat.ino).toBe(beforeStat.ino);
  expect(fs.readdirSync(inboxB.cur).filter((name) => name.startsWith(".ack-"))).toEqual([]);
});

test("a record path that is a dangling symlink is refused as a file type error", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  const absent = join(root, "absent.json");
  fs.symlinkSync(absent, target);

  const mutations: string[] = [];
  expect(() =>
    updateExistingRecord(target, (record: { read: boolean }) => {
      mutations.push("mutated");
      return { ...record, read: true };
    }, { mailboxRoot: inbox.root }),
  ).toThrow(MailRecordFileTypeError);

  expect(mutations).toEqual([]);
  expect(fs.readlinkSync(target)).toBe(absent);
});

test("a record symlink whose target cannot be resolved is refused as a file type error", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  const loopA = join(root, "loop-a.json");
  const loopB = join(root, "loop-b.json");
  fs.symlinkSync(loopB, loopA);
  fs.symlinkSync(loopA, loopB);
  fs.writeFileSync(join(root, "plain"), "not a directory");

  for (const linkTarget of [loopA, join(root, "plain", "child.json")]) {
    try {
      fs.unlinkSync(target);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    fs.symlinkSync(linkTarget, target);
    expect(() => updateExistingRecord(target, () => ({ read: true }), { mailboxRoot: inbox.root })).toThrow(MailRecordFileTypeError);
    expect(fs.readlinkSync(target)).toBe(linkTarget);
  }
});

test("an absent record still reports gone", () => {
  const inbox = getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");

  const outcome = updateExistingRecord(target, () => {
    throw new Error("an absent record must not be mutated");
  }, { mailboxRoot: inbox.root });

  expect(outcome).toEqual({ status: "gone" });
});

test("the node rerun refuses a build that is missing or older than the source", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "fresh-dist-"));
  try {
    const source = join(dir, "mail.ts");
    const dist = join(dir, "mail.js");
    fs.writeFileSync(source, "source");

    expect(() => requireFreshDist(source, dist)).toThrow(/is missing/);

    fs.writeFileSync(dist, "dist");
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(dist, older, older);
    expect(() => requireFreshDist(source, dist)).toThrow(/older than the source/);

    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(dist, newer, newer);
    expect(requireFreshDist(source, dist)).toBe(dist);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
