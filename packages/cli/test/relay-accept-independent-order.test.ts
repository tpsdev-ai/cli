/**
 * relay-accept-independent-order.test.ts — cli#601.
 *
 * Two acceptances of different message ids to different recipients are
 * independent: they share no per-delivery lock, so neither may wait for the
 * other to release a mailbox lock. The relay accept path used to hold its
 * recipient's mailbox lock across a scan that also locked every other mailbox,
 * so two such acceptances could each hold one mailbox and wait for the other's
 * — a lock-order cycle that ended only at the acceptance lock timeout.
 *
 * The interleaving is made deterministic with the injected acceptance pause
 * point (a real cross-process hook), not with timing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInbox } from "../src/utils/mail.js";

const BRANCH = "remote";
const FROM = "remote";
const TIMESTAMP = "2000-01-01T00:00:00.000Z";
/** A budget well above what a correct acceptance needs, so a wait is visible. */
const LOCK_TIMEOUT_MS = 5000;
const PAUSE_TIMEOUT_MS = 10000;

const RELAY_URL = new URL("../src/utils/relay.js", import.meta.url).href;

/** A real child process that accepts one relayed delivery, optionally pausing before its scan. */
const CHILD_SOURCE = `
const { deliverRelayedToLocal, setRelayAcceptTestHook } = await import(${JSON.stringify(RELAY_URL)});
const pause = process.env.RELAY_CHILD_PAUSE;
if (pause) {
  const { existsSync, writeFileSync } = await import("node:fs");
  setRelayAcceptTestHook((root) => {
    writeFileSync(pause + ".ready", root);
    const deadline = Date.now() + ${PAUSE_TIMEOUT_MS};
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(pause + ".release")) {
      if (Date.now() >= deadline) throw new Error("test pause timed out");
      Atomics.wait(wait, 0, 0, 5);
    }
  });
}
const started = Date.now();
try {
  const ok = deliverRelayedToLocal(process.env.RELAY_CHILD_BRANCH, {
    id: process.env.RELAY_CHILD_ID,
    from: process.env.RELAY_CHILD_FROM,
    to: process.env.RELAY_CHILD_TO,
    content: "c-" + process.env.RELAY_CHILD_ID,
    timestamp: ${JSON.stringify(TIMESTAMP)},
  });
  process.stdout.write(JSON.stringify({ delivered: ok ? 1 : 0, refused: 0, ms: Date.now() - started }));
} catch {
  process.stdout.write(JSON.stringify({ delivered: 0, refused: 1, ms: Date.now() - started }));
}
`;

interface Result { delivered: number; refused: number; ms: number; }

let root: string;
let mail: string;
let childScript: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-relay-independent-"));
  mail = join(root, "mail");
  savedEnv = {};
  for (const key of ["HOME", "TPS_MAIL_DIR", "TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS", "NODE_ENV"]) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = mail;
  process.env.NODE_ENV = "test";
  process.env.TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS = String(LOCK_TIMEOUT_MS);
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

/** Start a delivering child and resolve with its result when it exits. */
function acceptChild(id: string, to: string, pause?: string): Promise<Result> {
  const child = spawn("bun", [childScript], {
    env: {
      ...process.env,
      RELAY_CHILD_BRANCH: BRANCH,
      RELAY_CHILD_FROM: FROM,
      RELAY_CHILD_ID: id,
      RELAY_CHILD_TO: to,
      ...(pause ? { RELAY_CHILD_PAUSE: pause } : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise<Result>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`acceptance child exited ${code}`));
      try { resolve(JSON.parse(out) as Result); }
      catch (error) { reject(new Error(`acceptance child printed ${JSON.stringify(out)}: ${String(error)}`)); }
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + PAUSE_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`test child did not create ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("independent relay acceptances share no lock (cli#601)", () => {
  test("two acceptances of different ids to different recipients both succeed without a lock-timeout wait", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const pauseA = join(root, "pause-a");
    const pauseB = join(root, "pause-b");
    // Each child holds its own delivery stripe and recipient mailbox lock, paused
    // just before it scans the mail root — the interleaving that used to wait.
    const a = acceptChild(idA, "agent-a", pauseA);
    await waitForFile(`${pauseA}.ready`);
    const b = acceptChild(idB, "agent-b", pauseB);
    await waitForFile(`${pauseB}.ready`);
    writeFileSync(`${pauseA}.release`, "");
    writeFileSync(`${pauseB}.release`, "");
    const [ra, rb] = await Promise.all([a, b]);

    expect({ delivered: ra.delivered, refused: ra.refused }).toEqual({ delivered: 1, refused: 0 });
    expect({ delivered: rb.delivered, refused: rb.refused }).toEqual({ delivered: 1, refused: 0 });
    // Neither waited for the lock timeout: a correct acceptance completes at once.
    expect(ra.ms).toBeLessThan(LOCK_TIMEOUT_MS / 2);
    expect(rb.ms).toBeLessThan(LOCK_TIMEOUT_MS / 2);

    for (const [agent, id] of [["agent-a", idA], ["agent-b", idB]] as const) {
      const files = jsonFiles(getInbox(agent).fresh);
      expect(files).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(getInbox(agent).fresh, files[0]!), "utf8")) as { relayDelivery?: { id?: string } };
      expect(record.relayDelivery?.id).toBe(id);
    }
  }, 60_000);
});
