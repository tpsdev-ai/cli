/**
 * mail-client-repoint-root.test.ts — cli#636.
 *
 * The promotion lock, the mailbox file paths and the replay-state path derive
 * from one root resolved per operation, never pinned at construction. This test
 * re-points the configured `mailDir` (a symlink) under a live MailClient, while
 * a second process holds the NEW root's mailbox lock. The client must not
 * promote under the OLD root's lock, and once the lock is released the one
 * envelope is delivered exactly once.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailClient } from "../src/io/mail.js";
import { mailboxLockRoot } from "../src/lib/mail-lock-namespace.js";
import { senderKeyResolver, signedRelayRecord } from "./helpers/signed-relay-record.js";

const AGENT = "mailbox";
const BRANCH = "remote";
const ID = "reserved";

let root: string;
let storeOld: string;
let storeNew: string;
let alias: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-client-repoint-root-"));
  storeOld = join(root, "store-old");
  storeNew = join(root, "store-new");
  mkdirSync(storeOld, { recursive: true });
  mkdirSync(storeNew, { recursive: true });
  alias = join(root, "mail");
  symlinkSync(storeOld, alias, "dir");
  savedHome = process.env.HOME;
  process.env.HOME = root;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** Hold a mailbox lock in a real second process and release it on stdin. */
function holdMailboxLock(lockRoot: string): Promise<{ release: () => Promise<void> }> {
  const script = join(root, "holder.ts");
  writeFileSync(
    script,
    `
const { acquireMailLockSync } = await import(${JSON.stringify(new URL("../src/lib/mail-lock.js", import.meta.url).href)});
const lock = acquireMailLockSync(process.env.HOLD_ROOT);
if (!lock) throw new Error("holder could not acquire");
process.stdout.write("ready");
process.stdin.once("data", () => { lock.release(); process.exit(0); });
`,
  );
  const child = spawn("bun", [script], { env: { ...process.env, HOLD_ROOT: lockRoot }, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`holder exited ${code} before ready`)));
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString() === "ready") {
        resolve({ release: async () => { child.stdin.end("release"); await exited; } });
      } else reject(new Error(`holder printed ${JSON.stringify(chunk.toString())}`));
    });
  });
}

test("a live client does not promote under the old root's lock, and delivers the envelope once", async () => {
  // The client is constructed while the alias points at the old store.
  const mail = new MailClient(alias, undefined, AGENT, senderKeyResolver());

  // Re-point the mail root under the live client. The new root is a real
  // mailbox: its maildir exists, and one record is seeded in new/. A client that
  // resolves the root per operation reads and promotes here.
  unlinkSync(alias);
  symlinkSync(storeNew, alias, "dir");
  const raw = signedRelayRecord(AGENT, "repointed", { branchId: BRANCH, id: ID });
  const source = join(storeNew, AGENT, "new", "r.json");
  mkdirSync(join(storeNew, AGENT, "new"), { recursive: true });
  for (const dir of ["cur", "dlq", "outbox"]) mkdirSync(join(storeNew, AGENT, dir), { recursive: true });
  writeFileSync(source, raw);

  // A real second process holds the new root's mailbox lock.
  const holder = await holdMailboxLock(mailboxLockRoot(storeNew, AGENT));
  try {
    // It must not promote under the old root's lock.
    expect(await mail.checkNewMail()).toEqual([]);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(storeNew, AGENT, "cur", "r.json"))).toBe(false);
  } finally {
    await holder.release();
  }

  // After release the one envelope is delivered exactly once.
  expect((await mail.checkNewMail()).map((message) => message.filename)).toEqual(["r.json"]);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(join(storeNew, AGENT, "cur", "r.json"), "utf8")).toBe(raw);

  // The replay gate refuses the same envelope again.
  expect(await mail.checkNewMail()).toEqual([]);
});
