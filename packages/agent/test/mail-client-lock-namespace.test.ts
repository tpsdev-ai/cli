/**
 * mail-client-lock-namespace.test.ts — cli#616.
 *
 * MailClient must take its acceptance stripe from its configured `mailDir`, not
 * from the process environment, which is set here to a different root. The
 * stripe holder reaches the store through a symlink and MailClient through the
 * store itself; that pair reaches one filesystem lock either way. The namespace
 * case checks that the derived lock root strings are equal as well.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailClient } from "../src/io/mail.js";
import { relayAcceptanceLockRoot } from "../src/lib/relay-lock.js";
import { canonicalMailRoot, mailboxLockRoot } from "../src/lib/mail-lock-namespace.js";
import { senderKeyResolver, signedRelayRecord } from "./helpers/signed-relay-record.js";

const AGENT = "mailbox";
const BRANCH = "remote";
const ID = "reserved";

let root: string;
let store: string;
let alias: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-client-lock-namespace-"));
  store = join(root, "store");
  mkdirSync(store, { recursive: true });
  alias = join(root, "alias");
  symlinkSync(store, alias, "dir");
  savedEnv = {};
  for (const key of ["HOME", "TPS_MAIL_DIR"]) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  // The MailClient environment names a path that is NOT the store: only the
  // configured mailDir does.
  process.env.TPS_MAIL_DIR = join(root, "elsewhere");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function client(): MailClient {
  return new MailClient(store, undefined, AGENT, senderKeyResolver());
}

/** Write `raw` as a source record in the mailbox's new/ directory. */
function seedSource(file: string, raw: string): string {
  const dir = join(store, AGENT, "new");
  mkdirSync(dir, { recursive: true });
  const source = join(dir, file);
  writeFileSync(source, raw);
  return source;
}

/** A relayed, unverifiable source record in the mailbox's new/ directory. */
function seedRelayedSource(): string {
  return seedSource("dl.json", JSON.stringify({ from: "sender", body: "invalid", relayDelivery: { branchId: BRANCH, id: ID } }));
}

/** Hold the acceptance stripe through `mailRoot`, as CLI relay acceptance does. */
function holdStripe(mailRoot: string): Promise<{ release: () => Promise<void> }> {
  const script = join(root, "holder.ts");
  writeFileSync(
    script,
    `
const { acquireMailLockSync } = await import(${JSON.stringify(new URL("../src/lib/mail-lock.js", import.meta.url).href)});
const { relayAcceptanceLockRoot } = await import(${JSON.stringify(new URL("../src/lib/relay-lock.js", import.meta.url).href)});
const lock = acquireMailLockSync(relayAcceptanceLockRoot(process.env.BRANCH, process.env.ID));
if (!lock) throw new Error("holder could not acquire");
process.stdout.write("ready");
process.stdin.once("data", () => { lock.release(); process.exit(0); });
`,
  );
  const child = spawn("bun", [script], {
    env: { ...process.env, TPS_MAIL_DIR: mailRoot, BRANCH, ID },
    stdio: ["pipe", "pipe", "inherit"],
  });
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

test("MailClient leaves a relayed dead-letter source until acceptance releases the stripe", async () => {
  const source = seedRelayedSource();
  const mail = client();
  const holder = await holdStripe(alias);
  try {
    expect(await mail.checkNewMail()).toEqual([]);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(store, AGENT, "dlq", "dl.json"))).toBe(false);
  } finally {
    await holder.release();
  }
  expect(await mail.checkNewMail()).toHaveLength(0);
  expect(existsSync(join(store, AGENT, "dlq", "dl.json"))).toBe(true);
});

test("MailClient leaves a valid relayed record in new/ until acceptance releases the stripe, then promotes it", async () => {
  const raw = signedRelayRecord(AGENT, "promoted", { branchId: BRANCH, id: ID });
  const source = seedSource("pr.json", raw);
  const promoted = join(store, AGENT, "cur", "pr.json");
  const mail = client();
  const holder = await holdStripe(alias);
  try {
    expect(await mail.checkNewMail()).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe(raw);
    expect(existsSync(promoted)).toBe(false);
  } finally {
    await holder.release();
  }
  expect((await mail.checkNewMail()).map((message) => message.filename)).toEqual(["pr.json"]);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(promoted, "utf8")).toBe(raw);
});

test("the same path in the environment and the configured mailDir still shares the stripe", async () => {
  const source = seedRelayedSource();
  const mail = client();
  const holder = await holdStripe(store);
  try {
    expect(await mail.checkNewMail()).toEqual([]);
    expect(existsSync(source)).toBe(true);
  } finally {
    await holder.release();
  }
});

test("the stripe and mailbox lock root strings are equal for the store, whatever path reaches it", () => {
  expect(relayAcceptanceLockRoot(BRANCH, ID, alias)).toBe(relayAcceptanceLockRoot(BRANCH, ID, store));
  expect(mailboxLockRoot(alias, AGENT)).toBe(mailboxLockRoot(store, AGENT));
});

test("a mail root that does not exist yet is created, then resolved", () => {
  const pending = join(alias, "pending", "store");
  expect(existsSync(pending)).toBe(false);
  // The temp directory may itself sit behind a symlink (macOS /var -> /private/var).
  expect(canonicalMailRoot(pending)).toBe(join(realpathSync(store), "pending", "store"));
  expect(existsSync(pending)).toBe(true);
});
