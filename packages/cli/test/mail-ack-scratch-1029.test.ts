import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as mail from "../src/utils/mail.js";
import { acquireMailLockSync } from "../src/utils/mail-lock.js";
import { freshDistMail } from "./helpers/fresh-dist.js";

afterEach(() => {
  mock.restore();
});

let root: string;
let priorMailDir: string | undefined;

beforeEach(() => {
  // Canonicalize the temp root: on a host whose tmpdir() goes through a
  // symlink (macOS: /var -> /private/var), updateExistingRecord resolves the
  // mailbox path and the spies below would compare against the other spelling.
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ack-scratch-1029-")));
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

function swapCase(segment: string): string {
  return segment.replace(/[a-zA-Z]/g, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
}

/** True when the filesystem treats a different-case spelling as a different path. */
function caseSensitiveFs(): boolean {
  const probe = fs.mkdtempSync(join(tmpdir(), "ack-scratch-probe-"));
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
  console.warn("[mail] different-letter-case alias sweep test skipped: this filesystem is case-sensitive, so the alternate spelling does not resolve");
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

test("an ack through a leaf cur symlink is refused and leaves the live scratch untouched", () => {
  const inboxA = mail.getInbox("mailbox-a");
  const mailboxB = join(root, "mailbox-b");
  fs.mkdirSync(mailboxB, { recursive: true });
  fs.symlinkSync(inboxA.cur, join(mailboxB, "cur"), "dir");
  const targetB = join(mailboxB, "cur", "record.json");
  plantRecord(targetB, "record-id");
  const recordBefore = fs.readFileSync(targetB, "utf8");

  const lockA = acquireMailLockSync(inboxA.root);
  expect(lockA).not.toBeNull();
  const live = join(inboxA.cur, scratchName());
  const fd = fs.openSync(live, "w");
  fs.writeFileSync(fd, "{ partial");
  // Age cannot prove a writer has stopped; this test protects a scratch
  // that belongs to the current lock holder.
  makeOld(live);
  const { lines } = collectWarnings();
  try {
    expect(() => mail.ackMessageAtPath(targetB, mailboxB)).toThrow(mail.MailRecordLockRootError);
  } finally {
    lockA!.release();
    fs.closeSync(fd);
  }

  expect(fs.readFileSync(live, "utf8")).toBe("{ partial");
  expect(fs.readFileSync(targetB, "utf8")).toBe(recordBefore);
  expect(lines.filter((line) => line.includes("left ack scratch"))).toHaveLength(0);
});

test("the sweep leaves a scratch younger than the minimum age and removes an older one", () => {
  const inbox = mail.getInbox("mailbox-a");
  const cur = inbox.cur;
  const target = join(cur, "record.json");
  plantRecord(target, "record-id");
  const fresh = join(cur, scratchName());
  fs.writeFileSync(fresh, "{ fresh");
  const old = join(cur, scratchName());
  fs.writeFileSync(old, "{ old");
  makeOld(old);

  const { lines } = collectWarnings();
  expect(mail.ackMessageAtPath(target, inbox.root).read).toBe(true);

  expect(fs.readFileSync(fresh, "utf8")).toBe("{ fresh");
  expect(fs.existsSync(old)).toBe(false);
  expect(lines.filter((line) => line.includes(fresh))).toHaveLength(1);
});

test("the sweep leaves a fresh symlink to an old file and removes an old regular scratch", () => {
  const inbox = mail.getInbox("mailbox-a");
  const cur = inbox.cur;
  const target = join(cur, "record.json");
  plantRecord(target, "record-id");
  const oldTarget = join(root, "old-target");
  fs.writeFileSync(oldTarget, "{ keep target");
  makeOld(oldTarget);
  const targetBefore = fs.lstatSync(oldTarget);
  const link = join(cur, scratchName());
  fs.symlinkSync(oldTarget, link);
  const old = join(cur, scratchName());
  fs.writeFileSync(old, "{ old");
  makeOld(old);

  const { lines } = collectWarnings();
  expect(mail.ackMessageAtPath(target, inbox.root).read).toBe(true);

  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(link)).toBe(oldTarget);
  expect(fs.readFileSync(oldTarget, "utf8")).toBe("{ keep target");
  const targetAfter = fs.lstatSync(oldTarget);
  expect(targetAfter.ino).toBe(targetBefore.ino);
  expect(targetAfter.mtimeMs).toBe(targetBefore.mtimeMs);
  expect(targetAfter.ctimeMs).toBe(targetBefore.ctimeMs);
  expect(fs.existsSync(old)).toBe(false);
  expect(lines.filter((line) => line.includes(link) && line.includes("left non-regular ack scratch"))).toHaveLength(1);
});

test("a failed listing warns with the directory and code, and the next ack retries", () => {
  const inbox = mail.getInbox("mailbox-a");
  const cur = inbox.cur;
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
  expect(mail.ackMessageAtPath(first, inbox.root).read).toBe(true);

  const failures = lines.filter((line) => line.includes(cur) && line.includes("EACCES"));
  expect(failures).toHaveLength(1);

  const leftover = join(cur, scratchName());
  fs.writeFileSync(leftover, "{ partial");
  makeOld(leftover);
  expect(mail.ackMessageAtPath(second, inbox.root).read).toBe(true);

  expect(listings).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(leftover)).toBe(false);
  expect(lines.filter((line) => line.includes("removed leftover ack scratch"))).toHaveLength(1);
});

test("the sweep refuses a directory that resolves to the locked root itself, including at the filesystem root", () => {
  const inbox = mail.getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");
  const leftover = join(inbox.cur, scratchName());
  fs.writeFileSync(leftover, "{ partial");
  makeOld(leftover);

  // dirname("/") === "/", so a directory and root that both resolve to "/" must not pass the direct-child guard.
  const realpath = fs.realpathSync;
  // Only the sweep's resolutions are redirected: the update guard and the
  // layout check see the real directories, and the sweep sees both the root
  // and the directory resolving to the filesystem root.
  let rootResolutions = 0;
  let curResolutions = 0;
  spyOn(fs, "realpathSync").mockImplementation(((...args: Parameters<typeof realpath>) => {
    const path = resolve(String(args[0]));
    if (path === resolve(inbox.root) && ++rootResolutions === 2) return "/";
    if (path === resolve(inbox.cur) && ++curResolutions === 3) return "/";
    return realpath(...args);
  }) as typeof realpath);

  const { lines } = collectWarnings();
  expect(mail.ackMessageAtPath(target, inbox.root).read).toBe(true);
  expect(fs.readFileSync(leftover, "utf8")).toBe("{ partial");
  expect(lines.filter((line) => line.includes("left ack scratch in") && line.includes(inbox.cur))).toHaveLength(1);
});

test("a bare relative record update contends for the root lock before sweeping", () => {
  const inbox = mail.getInbox("bare-path");
  const target = join(inbox.cur, "record.json");
  const old = join(inbox.cur, scratchName());
  const fresh = join(inbox.cur, scratchName());
  plantRecord(target, "record-id");
  const writer = acquireMailLockSync(inbox.root);
  expect(writer).not.toBeNull();
  const fd = fs.openSync(old, "w");
  fs.writeFileSync(fd, "{ partial");
  makeOld(old);
  fs.writeFileSync(fresh, "{ fresh");
  const source = new URL("../src/utils/mail.ts", import.meta.url).href;
  try {
    const child = spawnSync(process.execPath, ["--eval", `
      const mail = await import(${JSON.stringify(source)});
      const result = mail.updateExistingRecord("record.json", (record) => ({ ...record, read: true }), { mailboxRoot: ${JSON.stringify(inbox.root)}, nonBlocking: true });
      console.log(JSON.stringify(result));
    `], { cwd: inbox.cur, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(fs.readFileSync(old, "utf8")).toBe("{ partial");
    expect(JSON.parse(child.stdout)).toEqual({ status: "busy" });
    expect(JSON.parse(fs.readFileSync(target, "utf8")).read).toBe(false);
  } finally {
    fs.closeSync(fd);
    writer!.release();
  }

  const cwd = process.cwd();
  collectWarnings();
  try {
    process.chdir(inbox.cur);
    expect(mail.ackMessageAtPath("record.json", inbox.root).read).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(fresh, "utf8")).toBe("{ fresh");
  } finally {
    process.chdir(cwd);
  }
});

test("a refused sweep does not postpone the next sweep", () => {
  const inbox = mail.getInbox("mailbox-a");
  const cur = inbox.cur;
  const target = join(cur, "record.json");
  plantRecord(target, "record-id");
  const aged = join(cur, scratchName());
  fs.writeFileSync(aged, "{ partial");
  makeOld(aged);

  const now = Date.now();
  const restoreClock = patchShared(mail.mailAckScratchTestHooks, "now", () => now);

  const realpath = fs.realpathSync;
  let curResolutions = 0;
  let refused = false;
  spyOn(fs, "realpathSync").mockImplementation(((...args: Parameters<typeof realpath>) => {
    if (resolve(String(args[0])) === resolve(cur)) {
      curResolutions++;
      // The first resolution is the update guard's, the second the layout
      // check's, and the third the sweep's listing.
      if (curResolutions === 3) {
        refused = true;
        return "/";
      }
    }
    return realpath(...args);
  }) as typeof realpath);

  const { lines } = collectWarnings();
  try {
    expect(mail.updateExistingRecord(target, (record) => ({ ...record, read: true }), { mailboxRoot: inbox.root }).status).toBe("updated");
    expect(refused).toBe(true);
    expect(fs.existsSync(aged)).toBe(true);

    expect(mail.updateExistingRecord(target, (record) => ({ ...record, read: true }), { mailboxRoot: inbox.root }).status).toBe("updated");
  } finally {
    restoreClock();
  }

  expect(fs.existsSync(aged)).toBe(false);
  expect(lines.filter((line) => line.includes("left ack scratch in") && line.includes(cur))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("removed leftover ack scratch") && line.includes(aged))).toHaveLength(1);
});

test("the sweep compares directories by identity, not by their path strings", () => {
  const inbox = mail.getInbox("mailbox-a");
  const target = join(inbox.cur, "record.json");
  plantRecord(target, "record-id");
  const aged = join(inbox.cur, scratchName());
  fs.writeFileSync(aged, "{ partial");
  makeOld(aged);

  // The sweep's two resolutions name different strings, and neither is a
  // textual parent of the other. Only device and inode say the second is a
  // directory directly under the first.
  const realpath = fs.realpathSync;
  let rootResolutions = 0;
  let curResolutions = 0;
  spyOn(fs, "realpathSync").mockImplementation(((...args: Parameters<typeof realpath>) => {
    const path = resolve(String(args[0]));
    if (path === resolve(inbox.root) && ++rootResolutions === 2) return "/virtual/mailbox";
    if (path === resolve(inbox.cur) && ++curResolutions === 3) return "/virtual/alias";
    return realpath(...args);
  }) as typeof realpath);
  const identities = new Map<string, fs.BigIntStats>([
    ["/virtual/mailbox", { dev: 7n, ino: 1n } as fs.BigIntStats],
    ["/virtual/alias", { dev: 7n, ino: 2n } as fs.BigIntStats],
    ["/virtual", { dev: 7n, ino: 1n } as fs.BigIntStats],
  ]);
  const restoreStat = patchShared(mail.mailAckScratchTestHooks, "stat", (path: string) => {
    const entry = identities.get(path);
    if (!entry) throw Object.assign(new Error(path), { code: "ENOENT" });
    return entry;
  });

  const { lines } = collectWarnings();
  try {
    expect(mail.ackMessageAtPath(target, inbox.root).read).toBe(true);
  } finally {
    restoreStat();
  }

  expect(fs.existsSync(aged)).toBe(false);
  expect(lines.filter((line) => line.includes("removed leftover ack scratch") && line.includes(aged))).toHaveLength(1);
});

test.skipIf(caseSensitive)("the sweep recognises a different-case alias of the mailbox under node", () => {
  const inbox = mail.getInbox("mailbox-case");
  const altRoot = join(dirname(inbox.root), swapCase(basename(inbox.root)));
  fs.symlinkSync(join(altRoot, "cur"), join(inbox.root, "cur-alias"), "dir");
  const recordPath = join(inbox.cur, "record.json");
  const aliasedPath = join(inbox.root, "cur-alias", "record.json");
  plantRecord(recordPath, "record-id");
  const aged = join(inbox.cur, scratchName());
  fs.writeFileSync(aged, "{ partial");
  makeOld(aged);

  const distMail = freshDistMail(import.meta.url);
  const script = [
    `import * as fs from "node:fs";`,
    `const { updateExistingRecord } = await import(process.argv[1]);`,
    `const outcome = updateExistingRecord(process.argv[2], (record) => ({ ...record, read: true }), { mailboxRoot: process.argv[3] });`,
    `if (outcome.status !== "updated") { console.error("status " + outcome.status); process.exit(2); }`,
    `if (fs.existsSync(process.argv[4])) { console.error("aged scratch remains"); process.exit(3); }`,
  ].join("\n");
  const run = spawnSync("node", ["--input-type=module", "--eval", script, pathToFileURL(distMail).href, aliasedPath, inbox.root, aged], { encoding: "utf8", timeout: 30_000 });
  expect(run.status, `node did not clean the alias sweep: ${run.stderr}${run.stdout}`).toBe(0);
  expect(fs.existsSync(aged)).toBe(false);
  expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).read).toBe(true);
});
