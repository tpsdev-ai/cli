import { afterEach, beforeEach, expect, test } from "bun:test";
import { configureBridgeIdentity } from "@tpsdev-ai/agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMail } from "../src/commands/mail.js";
import { watchMail } from "../src/commands/mail-watch.js";
import { getInbox, listMessages, promote } from "../src/utils/mail.js";
import { startFetchFlair } from "./helpers/fetch-flair.js";
import { buildSignedEnvelope } from "./helpers/stub-flair.js";

const seeds = { "branch-custom-bridge": Buffer.alloc(32, 0x71), kern: Buffer.alloc(32, 0x72) };
let root: string;
let saved: NodeJS.ProcessEnv;
let stub: ReturnType<typeof startFetchFlair>;
let path: string;

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "branch-bridge-root-"));
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "host-mail");
  delete process.env.TPS_BRIDGE_AGENT_ID;
  mkdirSync(join(root, ".tps", "branch-office", "kern", "mail"), { recursive: true });
  const inbox = getInbox("kern");
  configureBridgeIdentity(dirname(inbox.root), "stdio", "branch-custom-bridge");
  stub = startFetchFlair(seeds);
  process.env.FLAIR_URL = stub.url;
  process.env.FLAIR_KEY_PATH = join(root, "kern.key");
  writeFileSync(process.env.FLAIR_KEY_PATH, seeds.kern);
  const envelope = buildSignedEnvelope("branch-custom-bridge", "kern", "branch body", seeds, { trust: "internal", messageId: "branch-envelope" });
  path = join(inbox.fresh, "different-filename.json");
  writeFileSync(path, JSON.stringify({ id: "branch-record", from: envelope.from, to: "kern", body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false }));
});

afterEach(() => {
  stub.stop();
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

async function promotedPath() {
  const result = await promote("kern", path);
  if (!result.ok || result.message.trustTier !== "external") throw new Error("promotion must assign external");
  const record = JSON.parse(readFileSync(result.path, "utf8"));
  record.trustTier = "internal";
  writeFileSync(result.path, JSON.stringify(record));
  return result.path;
}

async function output(action: "read" | "list") {
  const logs: string[] = [];
  const previous = console.log;
  console.log = (value) => { logs.push(String(value)); };
  try { await runMail({ action, agent: "kern", messageId: "branch-record", json: true }); }
  finally { console.log = previous; }
  return JSON.parse(logs.join(""));
}

test("branch bridge promotion then read recomputes external from the record's root", async () => {
  await promotedPath();
  expect((await output("read")).trustTier).toBe("external");
});

test("branch bridge promotion then list recomputes external from the record's root", async () => {
  await promotedPath();
  expect((await output("list"))[0].trustTier).toBe("external");
});

test("branch bridge listMessages recomputes external from the record's root", async () => {
  await promotedPath();
  expect((await listMessages("kern"))[0]!.trustTier).toBe("external");
});

for (const action of ["ack", "nack"] as const) {
  test(`branch bridge new record ${action} refuses the external tier`, async () => {
    const before = readFileSync(path, "utf8");
    let error = "";
    try { await runMail({ action, agent: "kern", messageId: "branch-record", reason: "retry" }); }
    catch (caught) { error = String(caught); }
    expect({ error: error.includes("external-tier"), record: existsSync(path) ? readFileSync(path, "utf8") : null })
      .toEqual({ error: true, record: before });
  });
}

test("branch bridge in-place watch verification refuses hook dispatch", async () => {
  const out = join(root, "hook-output");
  const seen: string[] = [];
  const errors: string[] = [];
  const previous = console.error;
  console.error = (...values) => { errors.push(values.join(" ")); };
  const watcher = watchMail({ agent: "kern", debounceMs: 10, pollMs: 20,
    watchImpl: () => ({ close() {} }), onMessage: (message) => { seen.push(message.body); },
    hook: { args: [process.execPath, "-e", 'require("fs").writeFileSync(process.env.HOOK_OUT,"ran")'], env: { HOOK_OUT: out } } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect({ refused: errors.some((line) => line.includes("external-tier")), seen, ran: existsSync(out) })
      .toEqual({ refused: true, seen: [], ran: false });
  } finally { watcher.stop(); console.error = previous; }
});
