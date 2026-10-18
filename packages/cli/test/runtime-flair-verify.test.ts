import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, canonicalMailboxRoot, hasCommittedMessageId, mailboxReplayStore, ProviderManager } from "@tpsdev-ai/agent";
import { flairTarget } from "./helpers/scratch-flair.js";
import { buildSignedEnvelope, pubkeyFromSeed, writeKeyFile } from "./helpers/stub-flair.js";

const SEED = Buffer.alloc(32, 0x31);
const WRONG_SEED = Buffer.alloc(32, 0x32);

afterEach(() => { mock.restore(); });

/** The scratch Flair the lane started; the operator API and the admin credential. */
function lane() {
  const { baseUrl, opsUrl, admin } = flairTarget();
  const headers = { Authorization: `Basic ${Buffer.from(admin).toString("base64")}`, "Content-Type": "application/json" };
  const operation = (body: unknown) => fetch(opsUrl, { method: "POST", headers, body: JSON.stringify(body) });
  return { baseUrl, operation };
}

/** Register the receiver and sender so Flair can resolve the sender's key. */
function register(operation: (body: unknown) => Promise<Response>, ids: string[], publicKey: string): Promise<Response> {
  return operation({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: ids.map((id) => ({ id, name: id, publicKey, createdAt: new Date().toISOString() })),
  });
}

/** Plant one signed record for `receiver` in its mailbox `new/`, and return its canonical mailbox path. */
function plant(messageId: string, mailDir: string, receiver: string, sender: string, body: string): string {
  const envelope = buildSignedEnvelope(sender, receiver, body, { [sender]: SEED }, { messageId });
  const mailbox = canonicalMailboxRoot(join(mailDir, receiver));
  mkdirSync(join(mailbox, "new"), { recursive: true });
  writeFileSync(join(mailbox, "new", "m1.json"), JSON.stringify({
    from: sender, to: receiver, body: JSON.stringify(envelope), timestamp: new Date().toISOString(),
  }));
  return mailbox;
}

/** A bounded wait for a predicate that has nothing to do with model output. */
async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`runtime-flair lane: condition not met within ${deadlineMs}ms`);
}

/** The parsed JSONL lines a workspace's event-log files hold; unreadable files and unparsable lines contribute nothing. */
function eventLog(workspace: string): Array<Record<string, unknown>> {
  const dir = join(workspace, ".tps", "events");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line): Array<Record<string, unknown>> => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed !== null && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  });
}

/**
 * True once the runtime's mailbox recorded the wrong-key Agent-read refusal:
 * a `mail.receive` error event whose own `error` names the Flair Agent read
 * and the verifier's rejection. A mailbox storage error shares the event
 * shape but carries neither, so it cannot satisfy this.
 */
function recoveryLogged(workspace: string): boolean {
  return eventLog(workspace).some(
    (event) => event.type === "mail.receive"
      && event.status === "error"
      && typeof event.error === "string"
      && event.error.includes("/Agent/")
      && event.error.includes("invalid_signature"),
  );
}

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")("real Flair verifies and handles a signed delivery through the runtime's Agent read", async () => {
  const { baseUrl, operation } = lane();
  const root = mkdtempSync(join(tmpdir(), "runtime-flair-"));
  const receiver = `runtime-receiver-${randomUUID()}`;
  const sender = `runtime-sender-${randomUUID()}`;
  const keyPath = writeKeyFile(root, receiver, SEED);
  const mailDir = join(root, "mail");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const messageId = randomUUID();
  const mailbox = plant(messageId, mailDir, receiver, sender, "runtime-lane-body");
  const inserted = await register(operation, [receiver, sender], pubkeyFromSeed(SEED).toString("base64"));
  expect(inserted.ok).toBe(true);
  let handled!: () => void;
  const handledOnce = new Promise<void>((resolve) => { handled = resolve; });
  const provider = spyOn(ProviderManager.prototype, "complete").mockImplementation(async () => {
    handled();
    return { content: "done", toolCalls: undefined, inputTokens: 1, outputTokens: 1 } as never;
  });
  const runtime = new AgentRuntime({
    agentId: receiver, name: "runtime-verify", mailDir, workspace,
    memoryPath: join(workspace, "memory.jsonl"), maxToolTurns: 0,
    flair: { url: baseUrl, keyPath },
    llm: { provider: "openai", model: "test", apiKey: "test" },
  });
  const start = runtime.start();
  void start.catch(() => {});
  try {
    await handledOnce;
    await runtime.stop();
    await start;
    expect(readdirSync(join(mailbox, "cur"))).toEqual(["m1.json"]);
    expect(readdirSync(join(mailbox, "new"))).toEqual([]);
    expect(hasCommittedMessageId(mailbox, messageId)).toBe(true);
    expect(mailboxReplayStore(mailbox).placementPhase("m1.json")).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.stop();
    await start.catch(() => {});
    provider.mockRestore();
    await operation({ operation: "delete", database: "flair", table: "Agent", hash_values: [receiver, sender] });
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")("a refused Agent read leaves the runtime's mail uncommitted", async () => {
  const { baseUrl, operation } = lane();
  const root = mkdtempSync(join(tmpdir(), "runtime-flair-"));
  const receiver = `runtime-receiver-${randomUUID()}`;
  const sender = `runtime-sender-${randomUUID()}`;
  // The receiver's Agent row is registered with SEED's public key, but the
  // runtime signs the Agent read with WRONG_SEED, so Flair refuses it.
  const keyPath = writeKeyFile(root, receiver, WRONG_SEED);
  const mailDir = join(root, "mail");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const messageId = randomUUID();
  const mailbox = plant(messageId, mailDir, receiver, sender, "runtime-lane-body");
  const inserted = await register(operation, [receiver, sender], pubkeyFromSeed(SEED).toString("base64"));
  expect(inserted.ok).toBe(true);
  const provider = spyOn(ProviderManager.prototype, "complete").mockImplementation(async () => {
    throw new Error("the handler must not run for a refused Agent read");
  });
  const runtime = new AgentRuntime({
    agentId: receiver, name: "runtime-verify", mailDir, workspace,
    memoryPath: join(workspace, "memory.jsonl"), maxToolTurns: 0,
    flair: { url: baseUrl, keyPath },
    llm: { provider: "openai", model: "test", apiKey: "test" },
  });
  const start = runtime.start();
  void start.catch(() => {});
  try {
    await waitFor(() => recoveryLogged(workspace), 30_000);
    await runtime.stop();
    await start;
    expect(readdirSync(join(mailbox, "new"))).toEqual(["m1.json"]);
    expect(readdirSync(join(mailbox, "cur"))).toEqual([]);
    expect(hasCommittedMessageId(mailbox, messageId)).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    await runtime.stop();
    await start.catch(() => {});
    provider.mockRestore();
    await operation({ operation: "delete", database: "flair", table: "Agent", hash_values: [receiver, sender] });
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
