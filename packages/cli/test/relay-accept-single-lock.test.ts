/**
 * relay-accept-single-lock.test.ts — cli#561.
 *
 * For the same branch, recipient and id, at most one receiver accepts; the
 * second sees a duplicate (identical payload), refuses (differing payload),
 * or gets the timeout refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInbox } from "../src/utils/mail.js";
import { RelayAcceptLockTimeoutError, deliverRelayedToLocal } from "../src/utils/relay.js";

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
  const { deliverRelayedToLocal } = await import(url);
  const ids = JSON.parse(process.env.RELAY_CHILD_IDS);
  const counts = { delivered: 0, duplicate: 0, refused: 0 };
  for (const id of ids) {
    try {
      const ok = deliverRelayedToLocal(process.env.RELAY_CHILD_BRANCH, {
        id,
        from: process.env.RELAY_CHILD_FROM,
        to: process.env.RELAY_CHILD_TO,
        content: process.env.RELAY_CHILD_PREFIX + id,
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
function deliverChild(prefix: string, ids: string[]): Promise<Counts> {
  const child = spawn("bun", [childScript], {
    env: {
      ...process.env,
      RELAY_CHILD_MODE: "deliver",
      RELAY_CHILD_BRANCH: BRANCH,
      RELAY_CHILD_TO: RECIPIENT,
      RELAY_CHILD_FROM: FROM,
      RELAY_CHILD_PREFIX: prefix,
      RELAY_CHILD_IDS: JSON.stringify(ids),
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
function holdLock(agent = RECIPIENT): Promise<{ release: () => Promise<void> }> {
  const child = spawn("bun", [childScript], {
    env: { ...process.env, RELAY_CHILD_MODE: "hold", RELAY_CHILD_ROOT: join(mail, agent) },
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

describe("relay acceptance holds the recipient's mailbox lock across check, publication and marker (cli#561)", () => {
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
    const holder = await holdLock("other");
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
