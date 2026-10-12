/**
 * relay-accept-independent-order.test.ts — cli#601.
 *
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInbox } from "../src/utils/mail.js";
import { relayAcceptanceLockRoot } from "../src/utils/relay.js";

const BRANCH = "remote";
const FROM = "remote";
const TIMESTAMP = "2000-01-01T00:00:00.000Z";
const LOCK_TIMEOUT_MS = 5000;
const PAUSE_TIMEOUT_MS = 10000;

const RELAY_URL = new URL("../src/utils/relay.js", import.meta.url).href;

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

describe("relay acceptance lock order (cli#601)", () => {
  test("distinct-stripe acceptances to different recipients complete before the timeout", async () => {
    const idA = randomUUID();
    let idB = randomUUID();
    while (relayAcceptanceLockRoot(BRANCH, idA) === relayAcceptanceLockRoot(BRANCH, idB)) idB = randomUUID();
    expect(relayAcceptanceLockRoot(BRANCH, idA)).not.toBe(relayAcceptanceLockRoot(BRANCH, idB));
    const pauseA = join(root, "pause-a");
    const pauseB = join(root, "pause-b");
    const children: Promise<Result>[] = [];
    let results: Result[];
    try {
      children.push(acceptChild(idA, "agent-a", pauseA));
      await waitForFile(`${pauseA}.ready`);
      children.push(acceptChild(idB, "agent-b", pauseB));
      await waitForFile(`${pauseB}.ready`);
      writeFileSync(`${pauseA}.release`, "");
      writeFileSync(`${pauseB}.release`, "");
      results = await Promise.all(children);
    } finally {
      writeFileSync(`${pauseA}.release`, "");
      writeFileSync(`${pauseB}.release`, "");
      await Promise.allSettled(children);
    }
    const [ra, rb] = results as [Result, Result];

    expect({ delivered: ra.delivered, refused: ra.refused }).toEqual({ delivered: 1, refused: 0 });
    expect({ delivered: rb.delivered, refused: rb.refused }).toEqual({ delivered: 1, refused: 0 });
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
