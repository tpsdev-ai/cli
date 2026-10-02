import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { acquireMailLock, mailboxReplayStore, peekConsumedForMailboxRoot, type MailLock } from "@tpsdev-ai/agent";
import { FlairClient } from "../src/utils/flair-client.js";
import { getInbox, promote, recoverPromoted, redriveRetryable, sendMessage } from "../src/utils/mail.js";
import { runAgent } from "../src/commands/agent.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";
const seed = Buffer.alloc(32, 1);
let root: string;
let oldMail: string | undefined;
let verifier: ReturnType<typeof spyOn>;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "final-controls-"));
  oldMail = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue({ id: "flint", name: "flint", publicKey: pubkeyFromSeed(seed).toString("base64") });
});
afterEach(() => {
  verifier.mockRestore();
  if (oldMail === undefined) delete process.env.TPS_MAIL_DIR; else process.env.TPS_MAIL_DIR = oldMail;
  fs.rmSync(root, { recursive: true, force: true });
});
function plant() {
  const envelope = buildSignedEnvelope("flint", "kern", "once", { flint: seed });
  return { envelope, source: sendMessage("kern", JSON.stringify(envelope), "flint").filePath, inbox: getInbox("kern") };
}

test("promotion delivers with the public key registered by agent create", async () => {
  verifier.mockRestore();
  const id = "created-promotion-regression";
  const oldUrl = process.env.FLAIR_URL;
  const oldKey = process.env.FLAIR_KEY_PATH;
  const identity = join(homedir(), ".tps", "identity");
  let registered: { id: string; name: string; publicKey: string } | undefined;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === "/Health") return new Response("ok");
    if (init?.method === "PUT") { registered = JSON.parse(String(init.body)); return Response.json(registered); }
    return registered ? Response.json(registered) : new Response("missing", { status: 404 });
  });
  try {
    process.env.FLAIR_URL = "http://registry.test";
    await runAgent({ action: "create", id, noSeed: true, flairUrl: "http://registry.test" });
    expect(registered?.publicKey).toMatch(/^[a-f0-9]{64}$/);
    process.env.FLAIR_KEY_PATH = join(identity, `${id}.key`);
    const signingSeed = fs.readFileSync(process.env.FLAIR_KEY_PATH);
    const envelope = buildSignedEnvelope(id, "kern", "created", { [id]: signingSeed });
    const source = sendMessage("kern", JSON.stringify(envelope), id).filePath;
    expect(await promote("kern", source)).toMatchObject({ ok: true });
    const inbox = getInbox("kern");
    fs.rmSync(inbox.cur, { recursive: true });
    fs.mkdirSync(inbox.cur);
    const retry = sendMessage("kern", JSON.stringify(envelope), id).filePath;
    const filename = retry.split("/").pop()!;
    const quarantined = join(inbox.dlq, filename);
    fs.renameSync(retry, quarantined);
    expect(await redriveRetryable("kern", inbox.dlq)).toEqual([]);
    for (const sidecar of [undefined, "torn", "class: invalid\n", "class: verify-unavailable\n"]) {
      if (sidecar !== undefined) fs.writeFileSync(`${quarantined}.reason`, sidecar);
      const read = fs.readFileSync;
      const unreadable = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
        if (sidecar === undefined && args[0] === `${quarantined}.reason`) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return read(...args);
      });
      try { expect(await redriveRetryable("kern", inbox.dlq)).toEqual([]); }
      finally { unreadable.mockRestore(); }
      expect(fs.readdirSync(inbox.cur)).toEqual([]);
    }
    expect(await redriveRetryable("kern", join(root, "missing-dlq"))).toEqual([]);
    const list = fs.readdirSync;
    const unreadableDlq = spyOn(fs, "readdirSync").mockImplementation((...args: Parameters<typeof list>) => {
      if (args[0] === inbox.dlq) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return list(...args);
    });
    try { await expect(redriveRetryable("kern", inbox.dlq)).rejects.toThrow("EACCES"); }
    finally { unreadableDlq.mockRestore(); }
    fs.rmSync(quarantined);
    fs.rmSync(`${quarantined}.reason`, { force: true });
    const next = buildSignedEnvelope(id, "kern", "concurrent", { [id]: signingSeed });
    const nextSource = sendMessage("kern", JSON.stringify(next), id).filePath;
    const nextDlq = join(inbox.dlq, nextSource.split("/").pop()!);
    fs.renameSync(nextSource, nextDlq);
    fs.writeFileSync(`${nextDlq}.reason`, "class: verify-unavailable\n");
    const concurrent = await Promise.all([redriveRetryable("kern", inbox.dlq), redriveRetryable("kern", inbox.dlq)]);
    expect(concurrent.flat()).toHaveLength(1);
    expect(fs.readdirSync(inbox.cur)).toHaveLength(1);
    const invalid = buildSignedEnvelope(id, "kern", "invalid", { [id]: Buffer.alloc(32, 9) });
    const invalidSource = sendMessage("kern", JSON.stringify(invalid), id).filePath;
    const rename = fs.renameSync;
    let attempted = false;
    const quarantineFault = spyOn(fs, "renameSync").mockImplementation((...args: Parameters<typeof rename>) => {
      if (String(args[1]).startsWith(inbox.dlq)) { attempted = true; throw new Error("dlq unavailable"); }
      return rename(...args);
    });
    try {
      expect(await promote("kern", invalidSource)).toMatchObject({ ok: false, class: "invalid" });
      expect(attempted).toBe(true);
      expect(fs.existsSync(invalidSource)).toBe(true);
      expect(fs.readdirSync(inbox.cur)).toHaveLength(1);
    } finally { quarantineFault.mockRestore(); }
    const forgedDlq = join(inbox.dlq, invalidSource.split("/").pop()!);
    fs.renameSync(invalidSource, forgedDlq);
    fs.writeFileSync(`${forgedDlq}.reason`, "class: storage-unavailable\n");
    expect(await redriveRetryable("kern", inbox.dlq)).toEqual([]);
    expect(fs.readdirSync(inbox.cur)).toHaveLength(1);
  } finally {
    fetch.mockRestore();
    for (const [name, value] of [["FLAIR_URL", oldUrl], ["FLAIR_KEY_PATH", oldKey]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    for (const suffix of ["key", "pub", "x25519.key", "x25519.pub", "meta.json"]) fs.rmSync(join(identity, `${id}.${suffix}`), { force: true });
    fs.rmSync(join(homedir(), ".tps", "agents", id), { recursive: true, force: true });
  }
});

test("append after a torn final line preserves the next consumed ID after cur GC", () => {
  const store = mailboxReplayStore(root);
  const ledger = join(root, "consumed.jsonl");
  fs.writeFileSync(ledger, JSON.stringify({ id: "expired", at: "1970-01-01T00:00:00Z" }) + "\n");
  expect(store.isConsumed("expired")).toBe(false);
  fs.writeFileSync(ledger, '{"id":"undated","at":"invalid"}\n');
  expect(store.isConsumed("undated")).toBe(true);
  fs.writeFileSync(ledger, '{"id":"torn-first","at":');
  store.recordConsumed("next-id");
  expect(store.isConsumed("next-id")).toBe(true);
  expect(peekConsumedForMailboxRoot(root, "next-id")).toBe(true);
  expect(fs.readFileSync(join(root, "consumed.jsonl"), "utf8")).toContain('\n{"id":"next-id"');
});

for (const line of ['{"at":', '{}\n', '{"id":"intact"}{"id":']) {
  test(`unrecoverable consumed history ${JSON.stringify(line)} withholds delivery`, async () => {
    const { source, inbox } = plant();
    fs.writeFileSync(join(inbox.root, "consumed.jsonl"), line);
    expect(await promote("kern", source)).toMatchObject({ ok: false, class: "storage-unavailable" });
    expect(fs.readdirSync(inbox.cur)).toEqual([]);
    expect(() => peekConsumedForMailboxRoot(inbox.root, "unknown-id")).toThrow();
  });
}

test("a deleted initialized ledger with no cur copy withholds delivery", async () => {
  const { source, inbox, envelope } = plant();
  const first = await promote("kern", source);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.reason);
  fs.rmSync(first.path);
  fs.rmSync(join(inbox.root, "consumed.jsonl"));
  const again = sendMessage("kern", JSON.stringify(envelope), "flint").filePath;
  expect(await promote("kern", again)).toMatchObject({ ok: false, class: "storage-unavailable" });
  expect(fs.readdirSync(inbox.cur)).toEqual([]);
});

for (const mode of ["unreadable", "corrupt", "unknown-shape", "missing-directory-access"] as const) {
  test(`migration history ${mode} withholds delivery`, async () => {
    const { source, inbox } = plant();
    const history = join(inbox.cur, "history.json");
    fs.writeFileSync(history, mode === "corrupt" ? '{"envelopeId":' : '{}');
    const read = fs.readFileSync;
    const exists = fs.existsSync;
    const readFault = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
      if (mode === "unreadable" && args[0] === history) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return read(...args);
    });
    const existsFault = spyOn(fs, "existsSync").mockImplementation((path) => mode === "missing-directory-access" && path === inbox.cur ? false : exists(path));
    const readdir = fs.readdirSync;
    const dirFault = spyOn(fs, "readdirSync").mockImplementation((...args: Parameters<typeof readdir>) => {
      if (mode === "missing-directory-access" && args[0] === inbox.cur) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return readdir(...args);
    });
    try { expect(await promote("kern", source)).toMatchObject({ ok: false, class: "storage-unavailable" }); }
    finally { readFault.mockRestore(); existsFault.mockRestore(); dirFault.mockRestore(); }
  });
}

test("an uncommitted cur copy left after failed rollback cannot be recovered", async () => {
  const { source, inbox } = plant();
  const append = spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("append fault"); });
  const rm = fs.rmSync;
  const fault = spyOn(fs, "rmSync").mockImplementation((...args: Parameters<typeof rm>) => {
    if (String(args[0]).startsWith(inbox.cur)) throw new Error("rollback fault");
    return rm(...args);
  });
  try { expect(await promote("kern", source)).toMatchObject({ ok: false, class: "storage-unavailable" }); }
  finally { append.mockRestore(); fault.mockRestore(); }
  const cur = join(inbox.cur, fs.readdirSync(inbox.cur)[0]!);
  await expect(recoverPromoted("kern", cur)).rejects.toThrow(/ledger|history/);
});

test("stale reclaimers cannot remove a newly acquired lock between owner read and removal", async () => {
  const lockDir = join(root, ".mail-lock");
  const ownerPath = join(lockDir, "owner.json");
  fs.mkdirSync(lockDir);
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: 2147483000 }));
  const read = fs.readFileSync;
  let second: Promise<MailLock | null> | undefined;
  let triggered = false;
  const interleave = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
    const value = read(...args);
    if (args[0] === ownerPath && !triggered) {
      triggered = true;
      second = acquireMailLock(root, { timeoutMs: 0 });
    }
    return value;
  });
  let first: MailLock | null = null;
  let other: MailLock | null = null;
  try {
    first = await acquireMailLock(root, { timeoutMs: 0 });
    other = await second!;
    expect(triggered).toBe(true);
    expect(first).not.toBeNull();
    expect(other).toBeNull();
    expect(JSON.parse(fs.readFileSync(ownerPath, "utf8")).pid).toBe(process.pid);
  } finally { interleave.mockRestore(); first?.release(); other?.release(); }
});

test("a stranded acquisition claim withholds even a provably stale lock", async () => {
  const lockDir = join(root, ".mail-lock");
  fs.mkdirSync(lockDir);
  fs.writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 2147483000 }));
  fs.mkdirSync(join(root, ".mail-lock.claim"));
  const lock = await acquireMailLock(root, { timeoutMs: 0 });
  try { expect(lock).toBeNull(); }
  finally { lock?.release(); }
});

test("a changed live owner token is read again while polling", async () => {
  const lockDir = join(root, ".mail-lock");
  const ownerPath = join(lockDir, "owner.json");
  fs.mkdirSync(lockDir);
  let token = "old";
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startToken: `proc:${token}` }));
  const read = fs.readFileSync;
  const kernel = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
    if (args[0] === `/proc/${process.pid}/stat`) return `1 (process) ${Array(19).fill("0").join(" ")} ${token}`;
    return read(...args);
  });
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startToken: "ps:old" }));
  expect(await acquireMailLock(root, { timeoutMs: 0 })).toBeNull();
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startToken: "proc:different" }));
  const reclaimed = await acquireMailLock(root, { timeoutMs: 0 });
  expect(reclaimed).not.toBeNull();
  reclaimed?.release();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startToken: "proc:old" }));
  const change = setTimeout(() => {
    token = "new";
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startToken: `proc:${token}` }));
  }, 5);
  let lock: MailLock | null = null;
  try {
    lock = await acquireMailLock(root, { timeoutMs: 40, pollMs: 10 });
    expect(lock).toBeNull();
    expect(JSON.parse(fs.readFileSync(ownerPath, "utf8")).startToken).toBe("proc:new");
  } finally { clearTimeout(change); kernel.mockRestore(); lock?.release(); }
});
