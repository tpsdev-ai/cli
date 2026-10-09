import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { FlairClient } from "../src/utils/flair-client.js";
import { checkMessages, getInbox, promote, recoverPromoted, sendMessage } from "../src/utils/mail.js";
import { processStartToken } from "../src/utils/mail-lock.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const seed = Buffer.alloc(32, 0x11);
let root: string;
let priorMailDir: string | undefined;
const verifierState = { value: undefined as unknown as ReturnType<typeof spyOn> };
const tokenReaderState = { value: undefined as unknown as ReturnType<typeof spyOn> | undefined };
const syncWaitState = { value: undefined as unknown as ReturnType<typeof spyOn> };
const asyncWaitState = { value: undefined as unknown as ReturnType<typeof spyOn> };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-lock-contention-"));
  priorMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
  patchShared(verifierState, "value", spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue({
    id: "flint", name: "flint", publicKey: pubkeyFromSeed(seed).toString("base64"),
  }));
  if (processStartToken(process.pid) === null) {
    patchShared(tokenReaderState, "value", spyOn(childProcess, "execFileSync").mockReturnValue("fixture birth\n"));
  }
  patchShared(syncWaitState, "value", spyOn(Atomics, "wait"));
  patchShared(asyncWaitState, "value", spyOn(globalThis, "setTimeout"));
});

afterEach(() => {
  verifierState.value.mockRestore();
  tokenReaderState.value?.mockRestore();
  patchShared(tokenReaderState, "value", undefined);
  syncWaitState.value.mockRestore();
  asyncWaitState.value.mockRestore();
  if (priorMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = priorMailDir;
  rmSync(root, { recursive: true, force: true });
});

const shapes: Array<[string, () => string]> = [
  ["a held mailbox lock prevents delivery (fail-closed), then clears", () => JSON.stringify({ pid: process.pid, startToken: null })],
  ["a token from a DIFFERENT source prefix on a live owner is unverifiable, not broken", () => {
    const token = processStartToken(process.pid);
    expect(token).not.toBeNull();
    return JSON.stringify({ pid: process.pid, startToken: token!.startsWith("proc:") ? "ps:other" : "proc:other" });
  }],
  ["a lock whose live owner's start token matches is respected", () => {
    const token = processStartToken(process.pid);
    expect(token).not.toBeNull();
    return JSON.stringify({ pid: process.pid, startToken: token });
  }],
  ["a .mail-lock with a truncated owner.json withholds delivery", () => '{"pid":'],
  ["a .mail-lock with an empty owner.json withholds delivery", () => ""],
  ["a .mail-lock with an owner.json with no numeric pid withholds delivery", () => JSON.stringify({ startToken: "x" })],
];

for (const [name, owner] of shapes) {
  test(name, async () => {
    sendMessage("kern", JSON.stringify(buildSignedEnvelope("flint", "kern", "locked", { flint: seed })), "flint");
    const inbox = getInbox("kern");
    const [filename] = readdirSync(inbox.fresh);
    const pending = join(inbox.fresh, filename!);
    const original = readFileSync(pending, "utf8");
    const lockDir = join(inbox.root, ".mail-lock");
    mkdirSync(lockDir);
    const rawOwner = owner();
    writeFileSync(join(lockDir, "owner.json"), rawOwner);
    const started = performance.now();
    expect(await checkMessages("kern")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(readFileSync(join(lockDir, "owner.json"), "utf8")).toBe(rawOwner);
    expect(readFileSync(pending, "utf8")).toBe(original);
    expect(readdirSync(inbox.cur)).toEqual([]);
    expect(readdirSync(inbox.dlq)).toEqual([]);
    const promoting = performance.now();
    expect(await promote("kern", pending)).toMatchObject({ ok: false, class: "busy" });
    expect(performance.now() - promoting).toBeLessThan(500);
    rmSync(lockDir, { recursive: true });
    const delivered = await checkMessages("kern");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body).toBe("locked");
    expect(existsSync(pending)).toBe(false);
    expect(await checkMessages("kern")).toEqual([]);
    const curPath = join(inbox.cur, filename!);
    const record = JSON.parse(readFileSync(curPath, "utf8"));
    delete record.checkedOutAt;
    delete record.checkedOutBy;
    writeFileSync(curPath, JSON.stringify(record));
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), rawOwner);
    const leasing = performance.now();
    expect(await checkMessages("kern")).toEqual([]);
    expect(performance.now() - leasing).toBeLessThan(500);
    expect(JSON.parse(readFileSync(curPath, "utf8"))).toEqual(record);
    expect(readFileSync(join(lockDir, "owner.json"), "utf8")).toBe(rawOwner);
    expect(syncWaitState.value).not.toHaveBeenCalled();
    expect(asyncWaitState.value).not.toHaveBeenCalled();
    rmSync(lockDir, { recursive: true });
    expect(await checkMessages("kern")).toHaveLength(1);
  }, 15000);
}

for (const [label, content] of [["corrupt", "{"], ["unverified", JSON.stringify({ id: "planted", from: "flint", to: "kern", body: "unsigned" })]]) {
  test(`recovery leaves a ${label} cur record intact under an unverifiable lock`, async () => {
    const inbox = getInbox("kern");
    const path = join(inbox.cur, "planted.json");
    writeFileSync(path, content!);
    const lockDir = join(inbox.root, ".mail-lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), "");
    expect(await recoverPromoted("kern", path)).toMatchObject({ ok: false, class: "busy" });
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(readdirSync(inbox.dlq)).toEqual([]);
    expect(syncWaitState.value).not.toHaveBeenCalled();
    expect(asyncWaitState.value).not.toHaveBeenCalled();
    rmSync(lockDir, { recursive: true });
    expect((await recoverPromoted("kern", path)).ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
}
