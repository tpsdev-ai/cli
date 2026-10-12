import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInbox } from "../src/utils/mail.js";
import { deliverRelayedToLocal, RelayAcceptLockTimeoutError } from "../src/utils/relay.js";

let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "relay-root-refresh-"));
  saved = {};
  for (const key of ["HOME", "TPS_MAIL_DIR", "TPS_RELAY_ACCEPT_LOCK_TIMEOUT_MS"]) saved[key] = process.env[key];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
});
afterEach(() => { mock.restore(); });
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a same-id mailbox created while acceptance waits for its snapshot lock refuses a conflicting recipient", async () => {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const recipient = getInbox("agent-z");
  const signal = join(root, "snapshot");
  const release = join(root, "release");
  const childScript = join(root, "holder.ts");
  fs.writeFileSync(childScript, `
const { acquireMailLockSync } = await import(${JSON.stringify(new URL("../src/utils/mail-lock.js", import.meta.url).href)});
const { sendMessage } = await import(${JSON.stringify(new URL("../src/utils/mail.js", import.meta.url).href)});
const { existsSync } = await import("node:fs");
const lock = acquireMailLockSync(${JSON.stringify(recipient.root)});
if (!lock) throw new Error("holder could not acquire");
process.stdout.write("ready");
try {
  const deadline = Date.now() + 10000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(signal)}) && !existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("snapshot signal missing");
    Atomics.wait(wait, 0, 0, 5);
  }
  if (existsSync(${JSON.stringify(signal)})) sendMessage("agent-a", "existing", "remote", ${JSON.stringify({ branchId: "remote", id })}, ${JSON.stringify(timestamp)});
} finally { lock.release(); }
`);
  const child = spawn("bun", [childScript], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve());
    child.once("exit", () => reject(new Error(`holder exited before ready: ${stderr}`)));
  });
  const mkdir = fs.mkdirSync;
  let inserted = false;
  spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof mkdir>) => {
    if (args[0] === join(recipient.root, ".mail-lock.claim") && !inserted) {
      inserted = true;
      fs.writeFileSync(signal, "");
    }
    return mkdir(...args);
  }) as typeof mkdir);
  try {
    expect(() => deliverRelayedToLocal("remote", { id, from: "remote", to: "agent-z", content: "existing", timestamp }))
      .toThrow("relayed delivery conflict");
  } finally {
    fs.writeFileSync(release, "");
    expect(await exited, stderr).toBe(0);
  }
  expect(inserted).toBe(true);
  expect(fs.readdirSync(recipient.fresh)).toEqual([]);
  expect(fs.readdirSync(getInbox("agent-a").fresh)).toHaveLength(1);
});

test("root churn exhausts the retry bound without a record, receipt, or held locks", () => {
  const id = randomUUID();
  const recipient = getInbox("agent-z");
  const mkdir = fs.mkdirSync;
  let attempts = 0;
  spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof mkdir>) => {
    if (args[0] === join(recipient.root, ".mail-lock.claim")) getInbox(`churn-${attempts++}`);
    return mkdir(...args);
  }) as typeof mkdir);
  expect(() => deliverRelayedToLocal("remote", { id, from: "remote", to: "agent-z", content: "payload", timestamp: new Date().toISOString() }))
    .toThrow(RelayAcceptLockTimeoutError);
  expect(attempts).toBe(8);
  expect(fs.readdirSync(recipient.fresh)).toEqual([]);
  expect(fs.existsSync(join(process.env.TPS_MAIL_DIR!, ".relay-accepted"))).toBe(false);
  expect(fs.existsSync(join(recipient.root, ".mail-lock"))).toBe(false);
});
