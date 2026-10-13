/**
 * relay-accept-lock-namespace.test.ts — cli#616.
 *
 * CLI relay acceptance takes its acceptance stripe from TPS_MAIL_DIR; its
 * recipient mailbox locks come from the selected mailbox and scan roots, which
 * can be branch-office mailboxes outside it. The agent MailClient must take its
 * acceptance stripe from its configured mailDir, not from its process
 * environment. The MailClient runs in a child process from the
 * real agent config, with a TPS_MAIL_DIR naming a different root: before cli#616
 * that root selected MailClient's stripe, and acceptance's stripe did not cover
 * MailClient's dead-letter move. Acceptance reaches the store through a symlink.
 * That alone never separated the locks between processes, because a symlink
 * and its target are one directory to the filesystem lock. Unresolved, it would
 * make the lock root strings differ, which matters within one process, where
 * the lock's re-entrancy check compares lock path strings; the agent package's
 * namespace test checks that the strings are equal.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = "mailbox";
const BRANCH = "remote";
const TIMESTAMP = "2000-01-01T00:00:00.000Z";

const AGENT_DIST = new URL("../../agent/dist/index.js", import.meta.url).href;
const RELAY_URL = new URL("../src/utils/relay.js", import.meta.url).href;

const ACCEPT_CHILD = `
const { deliverRelayedToLocal, setRelayAcceptTestHook } = await import(${JSON.stringify(RELAY_URL)});
const pause = process.env.ACCEPT_PAUSE;
if (pause) {
  const { existsSync, writeFileSync } = await import("node:fs");
  setRelayAcceptTestHook(() => {
    writeFileSync(pause + ".ready", "");
    const deadline = Date.now() + 20000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(pause + ".release")) {
      if (Date.now() >= deadline) throw new Error("acceptance pause timed out");
      Atomics.wait(wait, 0, 0, 5);
    }
  });
}
try {
  const delivered = deliverRelayedToLocal(process.env.ACCEPT_BRANCH, {
    id: process.env.ACCEPT_ID, from: "sender", to: process.env.ACCEPT_TO,
    content: "hello", timestamp: ${JSON.stringify(TIMESTAMP)},
  });
  process.stdout.write(JSON.stringify({ delivered }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error) }));
}
`;

const MAIL_CLIENT_CHILD = `
const { loadAgentConfig, MailClient } = await import(${JSON.stringify(AGENT_DIST)});
const config = loadAgentConfig(process.env.AGENT_CONFIG);
const ed = await import("@noble/ed25519");
const client = new MailClient(config.mailDir, undefined, config.agentId, {
  async getAgent() { return { publicKey: Buffer.from(ed.getPublicKey(Buffer.alloc(32, 1))) }; },
});
await client.checkNewMail();
const { readdirSync } = await import("node:fs");
process.stdout.write(JSON.stringify(readdirSync(process.env.AGENT_INBOX).filter((f) => f.endsWith(".json"))));
`;

let root: string;
let store: string;
let alias: string;
let configPath: string;
let acceptChild: string;
let mailClientChild: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-accept-lock-namespace-"));
  store = join(root, "store");
  mkdirSync(store, { recursive: true });
  alias = join(root, "alias");
  symlinkSync(store, alias, "dir");
  configPath = join(root, "agent.yaml");
  writeFileSync(configPath, `agentId: ${AGENT}\nmailDir: ${store}\n`);
  acceptChild = join(root, "accept-child.ts");
  writeFileSync(acceptChild, ACCEPT_CHILD);
  mailClientChild = join(root, "mail-client-child.ts");
  writeFileSync(mailClientChild, MAIL_CLIENT_CHILD);
  savedEnv = {};
  for (const key of ["HOME", "TPS_MAIL_DIR"]) savedEnv[key] = process.env[key];
  process.env.HOME = root;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function spawnAccept(id: string, pause: string, mailDir: string): Promise<{ child: ReturnType<typeof spawn>; done: Promise<{ delivered?: boolean; error?: string }> }> {
  const child = spawn("bun", [acceptChild], {
    env: {
      ...process.env,
      TPS_MAIL_DIR: mailDir,
      ACCEPT_BRANCH: BRANCH,
      ACCEPT_ID: id,
      ACCEPT_TO: "candidate",
      ACCEPT_PAUSE: pause,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const done = new Promise<{ delivered?: boolean; error?: string }>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`acceptance child exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(new Error(`acceptance child printed ${JSON.stringify(out)}: ${String(error)}`)); }
    });
  });
  return Promise.resolve({ child, done });
}

function runMailClient(mailDirEnv: string): Promise<string[]> {
  const child = spawn("bun", [mailClientChild], {
    env: { ...process.env, TPS_MAIL_DIR: mailDirEnv, AGENT_CONFIG: configPath, AGENT_INBOX: join(store, AGENT, "new") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`MailClient child exited ${code}`));
      try { resolve(JSON.parse(out) as string[]); } catch (error) { reject(new Error(`MailClient child printed ${JSON.stringify(out)}: ${String(error)}`)); }
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`test child did not create ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A relayed, unverifiable source record in the mailbox's new/ directory. */
function seedRelayedSource(id: string): string {
  const dir = join(store, AGENT, "new");
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "dl.json");
  writeFileSync(source, JSON.stringify({ from: "sender", body: "invalid", relayDelivery: { branchId: BRANCH, id } }));
  return source;
}

test("acceptance holding its stripe and candidate lock defers MailClient's dead-letter move until release", async () => {
  const id = randomUUID();
  const source = seedRelayedSource(id);
  const pause = join(root, "pause");
  const { done } = await spawnAccept(id, pause, alias);
  try {
    await waitForFile(`${pause}.ready`);
    // Acceptance holds the candidate mailbox lock too, through the symlinked path.
    expect(existsSync(join(store, "candidate", ".mail-lock"))).toBe(true);
    // The MailClient child's TPS_MAIL_DIR names a different path; its configured
    // mailDir names the store. The source must stay put while the stripe is held.
    expect(await runMailClient(join(root, "elsewhere"))).toContain("dl.json");
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(store, AGENT, "dlq", "dl.json"))).toBe(false);
  } finally {
    writeFileSync(`${pause}.release`, "");
  }
  expect(await done).toEqual({ delivered: true });
  // After release the move proceeds.
  expect(await runMailClient(join(root, "elsewhere"))).not.toContain("dl.json");
  expect(readdirSync(join(store, AGENT, "dlq")).filter((f) => f.endsWith(".json"))).toEqual(["dl.json"]);
}, 60_000);

test("the same path in TPS_MAIL_DIR and the configured mailDir still shares the stripe", async () => {
  const id = randomUUID();
  const source = seedRelayedSource(id);
  const pause = join(root, "pause-same");
  const { done } = await spawnAccept(id, pause, store);
  try {
    await waitForFile(`${pause}.ready`);
    expect(await runMailClient(store)).toContain("dl.json");
    expect(existsSync(source)).toBe(true);
  } finally {
    writeFileSync(`${pause}.release`, "");
  }
  expect(await done).toEqual({ delivered: true });
}, 60_000);
