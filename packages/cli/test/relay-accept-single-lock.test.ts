/**
 * relay-accept-single-lock.test.ts — cli#561.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackMessageAtPath, getInbox } from "../src/utils/mail.js";
import { RELAY_ACCEPT_LOCK_STRIPES, RelayAcceptLockTimeoutError, deliverRelayedToLocal, relayAcceptanceLockRoot, relayAcceptanceReceiptPath } from "../src/utils/relay.js";

const BRANCH = "remote";
const RECIPIENT = "local";
const FROM = "remote";
const TIMESTAMP = "2000-01-01T00:00:00.000Z";
const IDS = 16;

const RELAY_URL = new URL("../src/utils/relay.js", import.meta.url).href;
const LOCK_URL = new URL("../../agent/dist/lib/mail-lock.js", import.meta.url).href;

/** The child process: either delivers a list of ids, or holds the mailbox lock. */
const CHILD_SOURCE = `
const url = ${JSON.stringify(RELAY_URL)};
const mode = process.env.RELAY_CHILD_MODE;
if (mode === "hold") {
  const { acquireMailLock } = await import(${JSON.stringify(LOCK_URL)});
  const lock = await acquireMailLock(process.env.RELAY_CHILD_ROOT, { timeoutMs: 10000 });
  if (!lock) { process.stderr.write("holder could not acquire\\n"); process.exit(2); }
  process.stdout.write("ready");
  process.stdin.once("data", () => { lock.release(); process.exit(0); });
} else {
  const { deliverRelayedToLocal, setRelayAcceptTestHook } = await import(url);
  const pause = process.env.RELAY_CHILD_PAUSE;
  if (pause) {
    const { existsSync, writeFileSync } = await import("node:fs");
    setRelayAcceptTestHook((root) => {
      writeFileSync(pause + ".ready", root);
      const deadline = Date.now() + 10000;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(pause + ".release")) {
        if (Date.now() >= deadline) throw new Error("test pause timed out");
        Atomics.wait(wait, 0, 0, 5);
      }
    });
  }
  if (process.env.RELAY_CHILD_STARTED) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.RELAY_CHILD_STARTED, "");
  }
  const ids = JSON.parse(process.env.RELAY_CHILD_IDS);
  const counts = { delivered: 0, duplicate: 0, refused: 0 };
  for (const id of ids) {
    try {
      const ok = deliverRelayedToLocal(process.env.RELAY_CHILD_BRANCH, {
        id,
        from: process.env.RELAY_CHILD_FROM,
        to: process.env.RELAY_CHILD_TO,
        content: JSON.parse(process.env.RELAY_CHILD_PREFIX) + id,
        timestamp: ${JSON.stringify(TIMESTAMP)},
      });
      if (ok) counts.delivered += 1; else counts.duplicate += 1;
    } catch {
      counts.refused += 1;
    }
  }
  process.stdout.write(JSON.stringify(counts));
}
`;

interface Counts { delivered: number; duplicate: number; refused: number; }

let root: string;
let mail: string;
let childScript: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-relay-accept-"));
  mail = join(root, "mail");
  savedEnv = {};
  for (const key of ["HOME", "TPS_MAIL_DIR", "TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS"]) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = mail;
  delete process.env.TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS;
  childScript = join(root, "relay-accept-child.ts");
  writeFileSync(childScript, CHILD_SOURCE);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function jsonFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
}

/** Run one delivering child and resolve with its counts when it exits. */
function deliverChild(prefix: string, ids: string[], env: Record<string, string> = {}): Promise<Counts> {
  const child = spawn("bun", [childScript], {
    env: {
      ...process.env,
      RELAY_CHILD_MODE: "deliver",
      RELAY_CHILD_BRANCH: BRANCH,
      RELAY_CHILD_TO: RECIPIENT,
      RELAY_CHILD_FROM: FROM,
      RELAY_CHILD_PREFIX: JSON.stringify(prefix),
      RELAY_CHILD_IDS: JSON.stringify(ids),
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise<Counts>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`delivery child exited ${code}`));
      try { resolve(JSON.parse(out) as Counts); }
      catch (error) { reject(new Error(`delivery child printed ${JSON.stringify(out)}: ${String(error)}`)); }
    });
  });
}

/** Spawn a real process that holds a mailbox lock until released. */
function holdLock(lockRoot = join(mail, RECIPIENT)): Promise<{ release: () => Promise<void> }> {
  const child = spawn("bun", [childScript], {
    env: { ...process.env, RELAY_CHILD_MODE: "hold", RELAY_CHILD_ROOT: lockRoot },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`holder exited ${code} before ready`)));
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString() === "ready") resolve({ release: async () => { child.stdin.end("release"); await exited; } });
      else reject(new Error(`holder printed ${JSON.stringify(chunk.toString())}`));
    });
  });
}

/** Map each delivery id to the ids of the inbox records that carry it. */
function recordsByDeliveryId(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const file of jsonFiles(getInbox(RECIPIENT).fresh)) {
    const record = JSON.parse(readFileSync(join(getInbox(RECIPIENT).fresh, file), "utf8")) as { relayDelivery?: { id?: string } };
    const id = record.relayDelivery?.id ?? "unmarked";
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }
  return byId;
}

/** The stored receipt carries the digest of the delivered body, and a resend of that body dedups after ACK. */
function expectReceiptKeepsDigestOfBody(id: string, content: string): void {
  const receipt = JSON.parse(readFileSync(relayAcceptanceReceiptPath(BRANCH, id), "utf8")) as { bodySha256: string; bodyLength: number };
  expect(receipt.bodySha256).toBe(createHash("sha256").update(content, "utf8").digest("hex"));
  expect(receipt.bodyLength).toBe(Buffer.byteLength(content, "utf8"));
  expect(deliverRelayedToLocal(BRANCH, { id, from: FROM, to: RECIPIENT, content, timestamp: TIMESTAMP })).toBe(false);
  expect(recordsByDeliveryId().has(id)).toBe(false);
}

function expectReceiptMatchesDeliveredRecord(id: string, bodyPattern: RegExp): void {
  const [file] = recordsByDeliveryId().get(id)!;
  const path = join(getInbox(RECIPIENT).fresh, file!);
  const record = JSON.parse(readFileSync(path, "utf8")) as { body: string };
  expect(record.body).toMatch(bodyPattern);
  ackMessageAtPath(path);
  expectReceiptKeepsDigestOfBody(id, record.body);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`test child did not create ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("relay acceptance (cli#561)", () => {
  test("a second recipient waits for the same delivery id before any publication", async () => {
    const id = randomUUID();
    const pause = join(root, "cross-recipient-pause");
    const started = join(root, "cross-recipient-started");
    const first = deliverChild("same-", [id], { RELAY_CHILD_PAUSE: pause });
    let second: Promise<Counts> | undefined;
    try {
      await waitForFile(pause + ".ready");
      second = deliverChild("same-", [id], { RELAY_CHILD_TO: "other", RELAY_CHILD_STARTED: started });
      await waitForFile(started);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(jsonFiles(getInbox("other").fresh)).toEqual([]);
      expect(existsSync(relayAcceptanceReceiptPath(BRANCH, id))).toBe(false);
    } finally { writeFileSync(pause + ".release", ""); }
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ delivered: 1, duplicate: 0, refused: 0 });
    expect(b).toEqual({ delivered: 0, duplicate: 0, refused: 1 });
    expect(jsonFiles(getInbox(RECIPIENT).fresh)).toHaveLength(1);
    expect(jsonFiles(getInbox("other").fresh)).toEqual([]);
  }, 60_000);

  test.each(["new", "dlq"])("routing change before %s publication", async (destination) => {
    const id = randomUUID();
    const hostRoot = getInbox(RECIPIENT).root;
    const branchRoot = join(root, ".tps", "branch-office", RECIPIENT, "mail");
    const pause = join(root, "pause");
    const started = join(root, "started");
    const prefix = destination === "new" ? "same-" : "\u0000same-";
    const first = deliverChild(prefix, [id], { RELAY_CHILD_PAUSE: pause });
    let second: Promise<Counts> | undefined;
    let results: [Counts, Counts | undefined];
    try {
      await waitForFile(pause + ".ready");
      expect(readFileSync(pause + ".ready", "utf8")).toBe(hostRoot);
      expect(existsSync(join(hostRoot, ".mail-lock"))).toBe(true);
      mkdirSync(branchRoot, { recursive: true });
      second = deliverChild(prefix, [id], { RELAY_CHILD_STARTED: started });
      await waitForFile(started);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(jsonFiles(join(branchRoot, "new"))).toEqual([]);
      expect(existsSync(relayAcceptanceReceiptPath(BRANCH, id))).toBe(false);
    } finally {
      writeFileSync(pause + ".release", "");
      results = await Promise.all([first, second]);
    }
    const [a, b] = results;
    expect(a.delivered).toBe(destination === "new" ? 1 : 0);
    expect(b?.delivered).toBe(0);
    expect(b?.duplicate).toBe(1);
    expect(a.refused + (b?.refused ?? 0)).toBe(0);
    const files = jsonFiles(join(hostRoot, destination));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(hostRoot, destination, files[0]!), "utf8")).relayDelivery).toEqual({ branchId: BRANCH, id });
    for (const dir of ["new", "cur", "dlq"]) expect(jsonFiles(join(branchRoot, dir))).toEqual([]);
  }, 60_000);
  test("two processes delivering identical payloads store one record per id and one delivered", async () => {
    const ids = Array.from({ length: IDS }, () => randomUUID());
    const [a, b] = await Promise.all([deliverChild("same-", ids), deliverChild("same-", ids)]);

    expect(a.delivered + b.delivered).toBe(IDS);
    expect(a.refused + b.refused).toBe(0);

    const byId = recordsByDeliveryId();
    expect([...byId.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(byId.get(id)).toHaveLength(1);
  }, 60_000);

  test("two processes delivering differing payloads store one body per id and refuse the other", async () => {
    const ids = Array.from({ length: IDS }, () => randomUUID());
    const [a, b] = await Promise.all([deliverChild("A-", ids), deliverChild("B-", ids)]);

    expect(a.delivered + b.delivered).toBe(IDS);
    expect(a.refused + b.refused).toBe(IDS);

    const byId = recordsByDeliveryId();
    expect([...byId.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(byId.get(id)).toHaveLength(1);

    for (const id of ids) expectReceiptMatchesDeliveredRecord(id, /^[AB]-/);
  }, 60_000);

  test("a differing payload waiting on the stripe is refused and the receipt keeps the delivered body", async () => {
    const id = randomUUID();
    const pause = join(root, "differing-pause");
    const started = join(root, "differing-started");
    const first = deliverChild("A-", [id], { RELAY_CHILD_PAUSE: pause });
    let second: Promise<Counts> | undefined;
    try {
      await waitForFile(pause + ".ready");
      second = deliverChild("B-", [id], { RELAY_CHILD_STARTED: started });
      await waitForFile(started);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally { writeFileSync(pause + ".release", ""); }
    // ACK each record the moment it appears, so a waiter that took the lock late finds no record.
    const acked: string[] = [];
    let settled = false;
    const both = Promise.all([first, second]).finally(() => { settled = true; });
    while (!settled) {
      for (const file of jsonFiles(getInbox(RECIPIENT).fresh)) {
        const path = join(getInbox(RECIPIENT).fresh, file);
        try {
          acked.push((JSON.parse(readFileSync(path, "utf8")) as { body: string }).body);
          ackMessageAtPath(path);
        } catch {}
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const [a, b] = await both;
    expect(a).toEqual({ delivered: 1, duplicate: 0, refused: 0 });
    expect(b).toEqual({ delivered: 0, duplicate: 0, refused: 1 });
    expect(acked).toEqual([`A-${id}`]);
    expectReceiptKeepsDigestOfBody(id, `A-${id}`);
  }, 60_000);

  test("lock directories stay bounded across distinct deliveries", () => {
    for (let i = 0; i < RELAY_ACCEPT_LOCK_STRIPES * 2 + 1; i++) {
      const id = randomUUID();
      expect(deliverRelayedToLocal(BRANCH, { id, from: FROM, to: RECIPIENT, content: id, timestamp: TIMESTAMP })).toBe(true);
      const [file] = jsonFiles(getInbox(RECIPIENT).fresh);
      ackMessageAtPath(join(getInbox(RECIPIENT).fresh, file!));
    }
    const lockRoot = join(mail, ".relay-accept-locks");
    const countDirectories = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce(
      (total, entry) => total + (entry.isDirectory() ? 1 + countDirectories(join(dir, entry.name)) : 0), 0,
    );
    expect(countDirectories(lockRoot)).toBeLessThanOrEqual(RELAY_ACCEPT_LOCK_STRIPES);
  }, 60_000);

  test("different ids on one stripe each publish once across processes", async () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; i <= RELAY_ACCEPT_LOCK_STRIPES; i++) {
      const id = randomUUID();
      const stripe = relayAcceptanceLockRoot(BRANCH, id);
      const prior = seen.get(stripe);
      if (prior) { pair = [prior, id]; break; }
      seen.set(stripe, id);
    }
    expect(pair).toBeDefined();
    const [a, b] = await Promise.all([deliverChild("same-", pair!), deliverChild("same-", pair!)]);
    expect(a.delivered + b.delivered).toBe(2);
    expect(a.duplicate + b.duplicate).toBe(2);
    expect(a.refused + b.refused).toBe(0);
    const byId = recordsByDeliveryId();
    for (const id of pair!) expect(byId.get(id)).toHaveLength(1);
  }, 20_000);

  test("two recipients resending the same id around local ACK keep the original receipt", async () => {
    const id = randomUUID();
    const body = { id, from: FROM, to: RECIPIENT, content: `same-${id}`, timestamp: TIMESTAMP };
    expect(deliverRelayedToLocal(BRANCH, body)).toBe(true);
    const marker = relayAcceptanceReceiptPath(BRANCH, id);
    const original = readFileSync(marker, "utf8");
    const inode = statSync(marker).ino;
    const holder = await holdLock(relayAcceptanceLockRoot(BRANCH, id));
    const local = deliverChild("same-", [id]);
    const other = deliverChild("same-", [id], { RELAY_CHILD_TO: "other" });
    try {
      const [file] = jsonFiles(getInbox(RECIPIENT).fresh);
      ackMessageAtPath(join(getInbox(RECIPIENT).fresh, file!));
    } finally { await holder.release(); }
    const [a, b] = await Promise.all([local, other]);
    expect(a).toEqual({ delivered: 0, duplicate: 1, refused: 0 });
    expect(b).toEqual({ delivered: 0, duplicate: 0, refused: 1 });
    expect(readFileSync(marker, "utf8")).toBe(original);
    expect(statSync(marker).ino).toBe(inode);
    expect(jsonFiles(getInbox(RECIPIENT).fresh)).toEqual([]);
    expect(jsonFiles(getInbox("other").fresh)).toEqual([]);
  }, 60_000);

  test("the stripe lock blocks every recipient for that id", async () => {
    const id = randomUUID();
    const holder = await holdLock(relayAcceptanceLockRoot(BRANCH, id));
    try {
      process.env.TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS = "75";
      for (const to of [RECIPIENT, "other"]) {
        expect(() => deliverRelayedToLocal(BRANCH, { id, from: FROM, to, content: "held", timestamp: TIMESTAMP })).toThrow(RelayAcceptLockTimeoutError);
        expect(jsonFiles(getInbox(to).fresh)).toEqual([]);
      }
      expect(existsSync(relayAcceptanceReceiptPath(BRANCH, id))).toBe(false);
    } finally { await holder.release(); }
  }, 60_000);

  test("a recipient lock timeout refuses by name, publishing no mail record or acceptance marker", async () => {
    const holder = await holdLock();
    try {
      process.env.TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS = "75";
      const body = { id: randomUUID(), from: FROM, to: RECIPIENT, content: "timed out", timestamp: TIMESTAMP };
      expect(() => deliverRelayedToLocal(BRANCH, body)).toThrow(RelayAcceptLockTimeoutError);
      expect(jsonFiles(getInbox(RECIPIENT).fresh)).toEqual([]);
      expect(existsSync(join(mail, ".relay-accepted"))).toBe(false);
    } finally {
      await holder.release();
    }
  }, 60_000);

  test("a different mailbox's lock uses the acceptance deadline and refuses by name, publishing no mail record or acceptance marker", async () => {
    const holder = await holdLock(join(mail, "other"));
    try {
      process.env.TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS = "75";
      const body = { id: randomUUID(), from: FROM, to: RECIPIENT, content: "timed out", timestamp: TIMESTAMP };
      const started = Date.now();
      expect(() => deliverRelayedToLocal(BRANCH, body)).toThrow(RelayAcceptLockTimeoutError);
      expect(Date.now() - started).toBeLessThan(1000);
      for (const agent of [RECIPIENT, "other"]) {
        for (const dir of ["new", "cur", "dlq"]) expect(jsonFiles(join(mail, agent, dir))).toEqual([]);
      }
      expect(existsSync(join(mail, ".relay-accepted"))).toBe(false);
    } finally {
      await holder.release();
    }
  }, 60_000);
});
