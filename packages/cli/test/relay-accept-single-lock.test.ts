/**
 * relay-accept-single-lock.test.ts — cli#561.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`test child did not create ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("relay acceptance (cli#561)", () => {
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
      expect(existsSync(join(mail, ".relay-accepted", "by-branch", BRANCH, id))).toBe(false);
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
