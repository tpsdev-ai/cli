import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MailLock } from "@tpsdev-ai/agent";
import { FlairClient } from "../src/utils/flair-client.js";

const lockModuleUrl = new URL("../../agent/dist/lib/mail-lock.js", import.meta.url);
for (const path of [new URL("../../agent/dist/index.js", import.meta.url), lockModuleUrl]) {
  if (!fs.existsSync(path)) throw new Error("packages/agent/dist missing — run bun run build");
}
const { acquireMailLock, mailboxReplayStore } = await import("@tpsdev-ai/agent");
const { getInbox, promote, redriveRetryable, sendMessage } = await import("../src/utils/mail.js");
const { buildSignedEnvelope, pubkeyFromSeed } = await import("./helpers/stub-flair.js");

const SEED = Buffer.alloc(32, 1);
let root: string;
let oldMailDir: string | undefined;
let verifier: ReturnType<typeof spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "mail-delivery-controls-"));
  oldMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockImplementation(async (name: string) => (
    name === "flint" ? { id: name, name, publicKey: pubkeyFromSeed(SEED).toString("base64") } : null
  ));
});

afterEach(() => {
  verifier.mockRestore();
  if (oldMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = oldMailDir;
  fs.rmSync(root, { recursive: true, force: true });
});

for (const code of ["EACCES", "EISDIR"]) {
  test(`promote withholds a replay when its ledger is unreadable (${code}) and cur/ is gone`, async () => {
    const envelope = buildSignedEnvelope("flint", "kern", "once", { flint: SEED });
    sendMessage("kern", JSON.stringify(envelope), "flint");
    const inbox = getInbox("kern");
    const first = await promote("kern", join(inbox.fresh, fs.readdirSync(inbox.fresh)[0]!));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    fs.rmSync(first.path);
    sendMessage("kern", JSON.stringify(envelope), "flint");
    const source = join(inbox.fresh, fs.readdirSync(inbox.fresh)[0]!);
    const read = fs.readFileSync;
    const fault = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
      if (args[0] === join(inbox.root, "consumed.jsonl")) throw Object.assign(new Error(code), { code });
      return read(...args);
    });
    try {
      const result = await promote("kern", source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.class).toBe("storage-unavailable");
      expect(fs.readdirSync(inbox.cur)).toEqual([]);
      expect(() => mailboxReplayStore(inbox.root).isConsumed(envelope.messageId)).toThrow(code);
    } finally {
      fault.mockRestore();
    }
    expect(await redriveRetryable("kern", inbox.dlq)).toEqual([]);
    expect(fs.readdirSync(inbox.cur)).toEqual([]);
  });
}

for (const directory of ["new", "dlq"] as const) {
  test(`source removal after ledger append is cleanup for ${directory}/ promotion`, async () => {
    const envelope = buildSignedEnvelope("flint", "kern", "committed", { flint: SEED });
    sendMessage("kern", JSON.stringify(envelope), "flint");
    const inbox = getInbox("kern");
    const filename = fs.readdirSync(inbox.fresh)[0]!;
    const source = join(inbox.root, directory, filename);
    if (directory === "dlq") {
      fs.renameSync(join(inbox.fresh, filename), source);
      fs.writeFileSync(`${source}.reason`, "class: storage-unavailable\n");
    }
    const rm = fs.rmSync;
    let committedBeforeCleanup = false;
    const fault = spyOn(fs, "rmSync").mockImplementation((...args: Parameters<typeof rm>) => {
      if (args[0] === source) {
        committedBeforeCleanup = fs.readFileSync(join(inbox.root, "consumed.jsonl"), "utf-8").includes(envelope.messageId);
        throw Object.assign(new Error("source removal fault"), { code: "EACCES" });
      }
      return rm(...args);
    });
    try {
      const result = await promote("kern", source);
      expect(committedBeforeCleanup).toBe(true);
      expect(result.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(join(inbox.cur, filename), "utf-8")).envelopeId).toBe(envelope.messageId);
      expect(fs.existsSync(join(inbox.dlq, `${filename}.reason`))).toBe(false);
    } finally {
      fault.mockRestore();
    }
    expect(await redriveRetryable("kern", inbox.dlq)).toEqual([]);
    expect(fs.existsSync(join(inbox.cur, filename))).toBe(true);
    expect(fs.existsSync(join(inbox.dlq, `${filename}.reason`))).toBe(false);
  });
}

test("a live holder's unreadable owner file cannot be reclaimed", async () => {
  const child = spawn("node", ["--input-type=module", "--eval", `
    import { acquireMailLock } from ${JSON.stringify(lockModuleUrl.href)};
    const lock = await acquireMailLock(${JSON.stringify(root)});
    if (!lock) process.exit(2);
    process.stdin.once("data", () => { lock.release(); process.exit(0); });
    process.stdout.write("ready");
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let contender: MailLock | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
      child.stdout.once("data", (chunk) => chunk.toString() === "ready" ? resolve() : reject(new Error(String(chunk))));
    });
    expect(await acquireMailLock(root, { timeoutMs: 50 })).toBeNull();
    const ownerPath = join(root, ".mail-lock", "owner.json");
    const owner = fs.readFileSync(ownerPath, "utf-8");
    expect(JSON.parse(owner).pid).toBe(child.pid);
    const read = fs.readFileSync;
    const fault = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
      if (args[0] === ownerPath) throw Object.assign(new Error("owner unreadable"), { code: "EACCES" });
      return read(...args);
    });
    try {
      contender = await acquireMailLock(root, { timeoutMs: 50 });
      expect(contender).toBeNull();
    } finally {
      fault.mockRestore();
    }
    expect(fs.readFileSync(ownerPath, "utf-8")).toBe(owner);
  } finally {
    contender?.release();
    child.stdin.end("release");
    await exited;
  }
  expect(fs.existsSync(join(root, ".mail-lock"))).toBe(false);
  const next = await acquireMailLock(root, { timeoutMs: 50 });
  expect(next).not.toBeNull();
  next?.release();
});

for (const owner of [undefined, "", '{"pid":', '{"startToken":"unknown"}']) {
  test(`unverifiable ownership is retained: ${String(owner)}`, async () => {
    const lockDir = join(root, ".mail-lock");
    fs.mkdirSync(lockDir);
    if (owner !== undefined) fs.writeFileSync(join(lockDir, "owner.json"), owner);
    const lock = await acquireMailLock(root, { timeoutMs: 50 });
    try {
      expect(lock).toBeNull();
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      lock?.release();
    }
  });
}
