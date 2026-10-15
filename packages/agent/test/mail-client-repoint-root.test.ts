/** cli#636: canonical operation path strings across symlink changes. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as ed from "@noble/ed25519";
import { MailClient, type MailMessage } from "../src/io/mail.js";
import { bridgePrincipalIds } from "../src/lib/bridge-identity.js";
import { acceptanceLockRoot, mailboxLockRoot } from "../src/lib/mail-lock-namespace.js";
import { hasCommittedMessageId, mailboxReplayStore } from "../src/lib/mailbox-policy.js";
import type { FlairClient } from "../src/lib/signEnvelope.js";
import { senderKeyResolver, signedRelayRecord } from "./helpers/signed-relay-record.js";

const AGENT = "mailbox";
const BRANCH = "remote";
// A wire-valid relayed delivery id (a UUID).
const ID = "6f1c2a3e-8d4b-4c5a-9e7f-1a2b3c4d5e6f";

let root: string;
let storeOld: string;
let storeNew: string;
let alias: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-client-repoint-root-"));
  storeOld = join(root, "store-old");
  storeNew = join(root, "store-new");
  mkdirSync(storeOld, { recursive: true });
  mkdirSync(storeNew, { recursive: true });
  alias = join(root, "mail");
  symlinkSync(storeOld, alias, "dir");
  // The two roots name different bridge principals: in the old root the sender
  // is a bridge principal (trust tier "external"); in the new root it is not.
  writeBridgePrincipal(storeOld, "sender");
  writeBridgePrincipal(storeNew, "other-bridge");
  savedEnv = {};
  for (const key of ["HOME", "TPS_BRIDGE_AGENT_ID"]) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  delete process.env.TPS_BRIDGE_AGENT_ID;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function writeBridgePrincipal(store: string, id: string): void {
  mkdirSync(join(store, ".bridge-principals"), { recursive: true });
  writeFileSync(join(store, ".bridge-principals", `${id}.json`), JSON.stringify({ id }));
}

/** Point the symlink `link` at `target`. */
function repoint(link: string, target: string): void {
  unlinkSync(link);
  symlinkSync(target, link, "dir");
}

/** Write `raw` as `file` in `<store>/<AGENT>/new` and return its path. */
function seed(store: string, file: string, raw: string): string {
  mkdirSync(join(store, AGENT, "new"), { recursive: true });
  const source = join(store, AGENT, "new", file);
  writeFileSync(source, raw);
  return source;
}

/**
 * A verifier whose first key lookup pauses until `resume()`; later lookups do
 * not pause. With `wrongKey` every lookup returns a key the record was not
 * signed with, so verification rejects the record.
 */
function pausedVerifier(opts: { wrongKey?: boolean } = {}) {
  const resolver = senderKeyResolver();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  const client: FlairClient = {
    async getAgent() {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      if (opts.wrongKey) return { publicKey: Buffer.from(ed.getPublicKey(Buffer.alloc(32, 2))) };
      return resolver.getAgent();
    },
  };
  return { client, paused, resume };
}

/** Run checkNewMail(), apply `change` while it is paused in verification, and return its result. */
async function checkWithChangeDuringVerification(
  mail: MailClient,
  verifier: ReturnType<typeof pausedVerifier>,
  change: () => void,
): Promise<MailMessage[]> {
  const pending = mail.checkNewMail();
  await Promise.race([
    verifier.paused,
    pending.then(() => { throw new Error("the operation finished without reaching verification"); }),
  ]);
  change();
  verifier.resume();
  return pending;
}

/** Hold the lock at `lockRoot` in a real second process and release it on stdin. */
function holdLock(lockRoot: string): Promise<{ release: () => Promise<void> }> {
  const script = join(root, "holder.ts");
  writeFileSync(
    script,
    `
const { mkdirSync } = await import("node:fs");
const { acquireMailLockSync } = await import(${JSON.stringify(new URL("../src/lib/mail-lock.js", import.meta.url).href)});
mkdirSync(process.env.HOLD_ROOT, { recursive: true });
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

test("a live client does not promote under the old root's lock, delivers the envelope once, and refuses its replay", async () => {
  // The client is constructed while the alias points at the old store.
  const mail = new MailClient(alias, undefined, AGENT, senderKeyResolver());

  // Re-point the mail root under the live client, between operations. The new
  // root is a real mailbox with one record seeded in new/. A client that
  // resolves the root per operation reads and promotes here.
  repoint(alias, storeNew);
  const raw = signedRelayRecord(AGENT, "repointed", { branchId: BRANCH, id: ID });
  const source = seed(storeNew, "r.json", raw);
  for (const dir of ["cur", "dlq", "outbox"]) mkdirSync(join(storeNew, AGENT, dir), { recursive: true });

  // A real second process holds the new root's mailbox lock.
  const holder = await holdLock(mailboxLockRoot(storeNew, AGENT));
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

  // The same signed envelope presented again under a new file name reaches the
  // replay gate in the new root, which refuses it: no delivery, and the record
  // is dead-lettered with a `replay` sidecar.
  const again = seed(storeNew, "r-again.json", raw);
  expect(await mail.checkNewMail()).toEqual([]);
  expect(existsSync(again)).toBe(false);
  expect(existsSync(join(storeNew, AGENT, "cur", "r-again.json"))).toBe(false);
  expect(readFileSync(join(storeNew, AGENT, "dlq", "r-again.json"), "utf8")).toBe(raw);
  expect(readFileSync(join(storeNew, AGENT, "dlq", "r-again.json.reason"), "utf8").split("\n")[0]).toBe("class: replay");
}, 20_000);

test("a configured mail-root repoint during verification derives the promotion stripe from the initial canonical string", async () => {
  const verifier = pausedVerifier();
  const mail = new MailClient(alias, undefined, AGENT, verifier.client);
  const source = seed(storeOld, "r.json", signedRelayRecord(AGENT, "stripe", { branchId: BRANCH, id: ID }));

  // A real second process holds the delivery's acceptance stripe on the OLD
  // root; the same stripe on the new root is free.
  const holder = await holdLock(acceptanceLockRoot(storeOld, BRANCH, ID));
  try {
    const delivered = await checkWithChangeDuringVerification(mail, verifier, () => repoint(alias, storeNew));
    expect(delivered).toEqual([]);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(storeOld, AGENT, "cur", "r.json"))).toBe(false);
    expect(existsSync(join(storeNew, AGENT, "cur", "r.json"))).toBe(false);
  } finally {
    await holder.release();
  }

  // Control: with the stripe free, the record is deliverable from the old root.
  repoint(alias, storeOld);
  expect((await mail.checkNewMail()).map((message) => message.filename)).toEqual(["r.json"]);
  expect(existsSync(join(storeOld, AGENT, "cur", "r.json"))).toBe(true);
}, 20_000);

for (const rejected of [false, true]) {
  test(`canonical-root replacement redirects the ${rejected ? "dead-letter" : "promotion"} lock claim to the replacement target`, async () => {
    const box = join(root, "box");
    mkdirSync(box);
    symlinkSync(box, join(storeOld, AGENT), "dir");
    const verifier = pausedVerifier({ wrongKey: rejected });
    const mail = new MailClient(alias, undefined, AGENT, verifier.client);
    const raw = signedRelayRecord(AGENT, "resolved-target", { branchId: BRANCH, id: ID });
    seed(storeOld, "r.json", raw);
    const stripe = acceptanceLockRoot(storeOld, BRANCH, ID);
    const movedStore = join(root, "moved-store");
    const mkdir = fs.mkdirSync;
    const realpath = fs.realpathSync;
    const mkdirPaths: string[] = [];
    const realpathInputs: string[] = [];
    const physicalClaims: string[] = [];
    let retargeted = false;
    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof mkdir>) => {
      if (retargeted) mkdirPaths.push(String(args[0]));
      const result = mkdir(...args);
      if (retargeted && String(args[0]) === join(stripe, ".mail-lock.claim")) {
        physicalClaims.push(realpath(String(args[0])));
      }
      return result;
    }) as typeof mkdir);
    const realpathSpy = spyOn(fs, "realpathSync").mockImplementation(((...args: Parameters<typeof realpath>) => {
      if (retargeted) realpathInputs.push(String(args[0]));
      return realpath(...args);
    }) as typeof realpath);
    let delivered: MailMessage[];
    try {
      delivered = await checkWithChangeDuringVerification(mail, verifier, () => {
        renameSync(storeOld, movedStore);
        symlinkSync(storeNew, storeOld, "dir");
        retargeted = true;
      });
    } finally {
      mkdirSpy.mockRestore();
      realpathSpy.mockRestore();
    }
    expect(realpathInputs).toEqual([]);
    expect(mkdirPaths).toContain(stripe);
    expect(mkdirPaths).toContain(join(stripe, ".mail-lock.claim"));
    expect(mkdirPaths.some((path) => path.startsWith(join(storeNew, ".relay-accept-locks")))).toBe(false);
    // Documents where the OS places the claim, not exclusion of root replacement.
    expect(physicalClaims).toEqual([join(storeNew, ".relay-accept-locks", basename(stripe), ".mail-lock.claim")]);
    expect(existsSync(join(movedStore, ".relay-accept-locks"))).toBe(false);
    expect(delivered.map((message) => message.filename)).toEqual(rejected ? [] : ["r.json"]);
    expect(existsSync(join(box, "new", "r.json"))).toBe(false);
    expect(readFileSync(join(box, rejected ? "dlq" : "cur", "r.json"), "utf8")).toBe(raw);
    expect(existsSync(join(storeNew, AGENT))).toBe(false);
    if (rejected) {
      expect(readFileSync(join(box, "dlq", "r.json.reason"), "utf8").split("\n")[0]).toBe("class: invalid");
    } else {
      expect(mkdirPaths).toContain(join(box, ".mail-lock.claim"));
      expect(hasCommittedMessageId(box, "resolved-target")).toBe(true);
    }
  });
}

test("a configured mail-root repoint during verification reads trust through the initial canonical string", async () => {
  expect(bridgePrincipalIds(storeOld).has("sender")).toBe(true);
  expect(bridgePrincipalIds(storeNew).has("sender")).toBe(false);
  const verifier = pausedVerifier();
  const mail = new MailClient(alias, undefined, AGENT, verifier.client);
  const raw = signedRelayRecord(AGENT, "trust", { branchId: BRANCH, id: ID });
  seed(storeOld, "r.json", raw);

  const delivered = await checkWithChangeDuringVerification(mail, verifier, () => repoint(alias, storeNew));
  expect(delivered.map((message) => [message.filename, message.trustTier])).toEqual([["r.json", "external"]]);
  expect(readFileSync(join(storeOld, AGENT, "cur", "r.json"), "utf8")).toBe(raw);
  expect(existsSync(join(storeNew, AGENT, "cur", "r.json"))).toBe(false);
});

test("a configured mail-root repoint during verification derives the rejection stripe from the initial canonical string", async () => {
  const verifier = pausedVerifier({ wrongKey: true });
  const mail = new MailClient(alias, undefined, AGENT, verifier.client);
  const raw = signedRelayRecord(AGENT, "rejected", { branchId: BRANCH, id: ID });
  const source = seed(storeOld, "r.json", raw);

  const holder = await holdLock(acceptanceLockRoot(storeOld, BRANCH, ID));
  try {
    expect(await checkWithChangeDuringVerification(mail, verifier, () => repoint(alias, storeNew))).toEqual([]);
    // The rejection did not move the record under the new root's free stripe.
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(storeOld, AGENT, "dlq", "r.json"))).toBe(false);
    expect(existsSync(join(storeOld, AGENT, "dlq", "r.json.reason"))).toBe(false);
  } finally {
    await holder.release();
  }

  // Control: with the stripe free, the same record is dead-lettered as invalid.
  repoint(alias, storeOld);
  expect(await mail.checkNewMail()).toEqual([]);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(join(storeOld, AGENT, "dlq", "r.json"), "utf8")).toBe(raw);
  expect(readFileSync(join(storeOld, AGENT, "dlq", "r.json.reason"), "utf8").split("\n")[0]).toBe("class: invalid");
}, 20_000);

test("interrupted-placement recovery reads trust through the initial canonical string after a configured mail-root repoint", async () => {
  const verifier = pausedVerifier();
  const mail = new MailClient(alias, undefined, AGENT, verifier.client);
  const mailbox = join(storeOld, AGENT);
  const source = seed(storeOld, "m1.json", signedRelayRecord(AGENT, "recovered", { branchId: BRANCH, id: ID }));
  // A placement interrupted after the move into cur/: recovery verifies the cur
  // copy, classifies its trust and completes it.
  mailboxReplayStore(mailbox).beginPlacement("recovered", "m1.json", source);
  renameSync(source, join(mailbox, "cur", "m1.json"));

  const delivered = await checkWithChangeDuringVerification(mail, verifier, () => repoint(alias, storeNew));
  expect(delivered.map((message) => [message.filename, message.trustTier])).toEqual([["m1.json", "external"]]);
  expect(hasCommittedMessageId(mailbox, "recovered")).toBe(true);
});

test("a mailbox-directory repoint during verification derives maildir and replay paths from the initial canonical string", async () => {
  const store = join(root, "store");
  const boxOld = join(root, "box-old");
  const boxNew = join(root, "box-new");
  for (const box of [boxOld, boxNew]) {
    for (const dir of ["new", "cur", "dlq", "outbox"]) mkdirSync(join(box, dir), { recursive: true });
  }
  mkdirSync(store, { recursive: true });
  const link = join(store, AGENT);
  symlinkSync(boxOld, link, "dir");
  const verifier = pausedVerifier();
  const mail = new MailClient(store, undefined, AGENT, verifier.client);
  const raw = signedRelayRecord(AGENT, "box", { branchId: BRANCH, id: ID });
  writeFileSync(join(boxOld, "new", "r.json"), raw);

  const delivered = await checkWithChangeDuringVerification(mail, verifier, () => repoint(link, boxNew));
  expect(delivered.map((message) => message.filename)).toEqual(["r.json"]);
  expect(existsSync(join(boxOld, "new", "r.json"))).toBe(false);
  expect(readFileSync(join(boxOld, "cur", "r.json"), "utf8")).toBe(raw);
  expect(hasCommittedMessageId(boxOld, "box")).toBe(true);
  expect(existsSync(join(boxNew, "cur", "r.json"))).toBe(false);
  expect(hasCommittedMessageId(boxNew, "box")).toBe(false);
});

test("deliverOutbox derives the recipient path from the initial canonical mail-root string after a configured symlink repoint", async () => {
  const mail = new MailClient(alias, undefined, AGENT, senderKeyResolver());
  const sentAt = "2026-10-13T00:00:00.000Z";
  writeFileSync(join(storeOld, AGENT, "outbox", "o.json"), JSON.stringify({ to: "peer", body: "x", sentAt }));
  const dest = "2026-10-13T00-00-00-000Z-o.json";

  // Repoint the mail root immediately before the underlying outbox read.
  const read = fs.readFileSync;
  let repointed = false;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    if (!repointed && String(args[0]).endsWith(join("outbox", "o.json"))) {
      repointed = true;
      repoint(alias, storeNew);
    }
    return read(...args);
  }) as typeof read);
  try {
    mail.deliverOutbox();
  } finally {
    spy.mockRestore();
  }

  expect(repointed).toBe(true);
  expect(existsSync(join(storeOld, "peer", "new", dest))).toBe(true);
  expect(existsSync(join(storeNew, "peer", "new", dest))).toBe(false);
});
