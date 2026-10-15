/**
 * Real filesystem crash-boundary and unresolved-intent regressions (cli#600).
 *
 * cli#617 slice (b): the recovery these tests exercise is the per-message
 * delivery API's completion-gated path. A message delivered by deliverNext()
 * is presented again by a later call once its hand-over is released (or its
 * process is gone), until completeDelivery() finalizes it, so the old
 * at-most-once assertions become "until completed". An unresolved placement
 * is a named deferral, not a null.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { type DeliverNextResult, MailClient } from "../src/io/mail.js";
import { hasCommittedMessageId, mailboxReplayStore } from "../src/lib/mailbox-policy.js";
import { acquireMailLock } from "../src/lib/mail-lock.js";
import { signEnvelope, type FlairClient } from "../src/lib/signEnvelope.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const SEED = Buffer.alloc(32, 0x24);
const CHILD = fileURLToPath(new URL("./helpers/mail-kill-child.mjs", import.meta.url));
const MODULE = new URL("../src/io/mail.ts", import.meta.url).href;

let mailDir: string;
let mailboxRoot: string;
const curPath = () => join(mailboxRoot, "cur", "m1.json");
const newPath = () => join(mailboxRoot, "new", "m1.json");

/** The verifier MailClient uses: resolves FROM to its public key, no network. */
function verifier(): FlairClient {
  return {
    async getAgent(name: string) {
      return name === FROM ? { publicKey: Buffer.from(ed.getPublicKey(SEED)) } : null;
    },
  };
}

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "mail-recovery-"));
  mailboxRoot = join(mailDir, AGENT);
  mkdirSync(join(mailboxRoot, "new"), { recursive: true });
});

afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

/** Plant one signed record in new/ and return its path. */
function plant(messageId: string): string {
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope(
    {
      v: 1,
      from: FROM,
      to: AGENT,
      body: "recovery-body",
      messageId,
      timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: FROM, kind: "agent", timestamp, rationale: "sends", signature: null },
      ],
    },
    { [FROM]: SEED },
  );
  const source = newPath();
  writeFileSync(source, JSON.stringify({ from: FROM, body: JSON.stringify(envelope) }));
  return source;
}

const jsonFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name)
    : [];

interface KillRun {
  signal: NodeJS.Signals | null;
  reached: boolean;
  stderr: string;
}

/** Run deliverNext() in a child and SIGKILL it at `killAt`; resolve on exit. */
function runAndKillAt(killAt: string, source: string, after = false, timeoutMs = 20_000): Promise<KillRun> {
  const marker = join(mailDir, `paused.${killAt}`);
  const child = spawn(process.execPath, [CHILD, mailDir, AGENT], {
    env: {
      HOME: mailDir,
      PATH: process.env.PATH,
      TPS_MAIL_MODULE: MODULE,
      TPS_DRIVE: "deliverNext",
      TPS_KILL_AT: killAt,
      ...(after ? { TPS_KILL_AFTER: "1" } : {}),
      TPS_KILL_MARKER: marker,
      TPS_MAIL_ROOT: mailboxRoot,
      TPS_SRC: source,
      TPS_CUR: curPath(),
      TPS_FROM: FROM,
      TPS_SEED: SEED.toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<KillRun>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const stop = () => {
      clearInterval(poll);
      clearTimeout(deadline);
      settled = true;
    };
    const poll = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(poll);
        child.kill("SIGKILL");
      }
    }, 15);
    const deadline = setTimeout(() => {
      if (settled) return;
      stop();
      child.kill("SIGKILL");
      reject(new Error(`child never reached ${killAt} (stderr: ${stderr})`));
    }, timeoutMs);
    child.once("error", (e) => {
      if (settled) return;
      stop();
      reject(e);
    });
    child.once("exit", (_code, signal) => {
      if (settled) return;
      stop();
      resolve({ signal, reached: existsSync(marker), stderr });
    });
  });
}

const reasonOf = (result: DeliverNextResult) => (result.status === "deferred" ? result.reason : result.status);

/**
 * The cli#617 slice (b) contract: a delivered message is held while its
 * hand-over is live, presented again once released, until it is completed,
 * then never again; placement cleanup is done.
 */
async function assertDeliveredUntilCompleted(messageId: string): Promise<void> {
  const client = new MailClient(mailDir, undefined, AGENT, verifier());
  const first = await client.deliverNext();
  if (first.status !== "delivered") throw new Error(`expected a delivery, got ${JSON.stringify(first)}`);
  expect(first.delivery.message.verifiedEnvelope?.messageId).toBe(messageId);
  expect(reasonOf(await client.deliverNext())).toBe("active");
  client.releaseDelivery(first.delivery);
  const second = await client.deliverNext();
  if (second.status !== "delivered") throw new Error(`expected a delivery, got ${JSON.stringify(second)}`);
  expect(second.delivery.message.verifiedEnvelope?.messageId).toBe(messageId);
  expect(await client.completeDelivery(second.delivery)).toEqual({ status: "completed" });
  expect(await client.deliverNext()).toEqual({ status: "idle" });
  expect(existsSync(newPath())).toBe(false);
  expect(jsonFiles(join(mailboxRoot, "cur"))).toEqual(["m1.json"]);
  expect(jsonFiles(join(mailboxRoot, "dlq"))).toEqual([]);
  expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(true);
  expect(
    readdirSync(mailboxRoot).some((n) => n.startsWith(".placement-") && n.endsWith(".json")),
  ).toBe(false);
}

const CASES: Array<{ at: string; after?: boolean }> = [
  { at: "intent-write" },
  { at: "link-to-cur" },
  { at: "source-removal" },
  { at: "ledger-commit" },
  { at: "phase-write", after: true },
];

describe("MailClient recovery at the tested placement boundaries (cli#600)", () => {
  for (const { at, after } of CASES) {
    test(`a later call re-presents the message until completed after a kill at ${at}`, async () => {
      const messageId = `kill-${at}`;
      const source = plant(messageId);
      const run = await runAndKillAt(at, source, after);
      expect(run.reached, `child never reached ${at}; stderr=${run.stderr}`).toBe(true);
      expect(run.signal).toBe("SIGKILL");
      await assertDeliveredUntilCompleted(messageId);
    });
  }
});

describe("MailClient defers unresolved placements", () => {
  test("a mismatched cur copy and same-id new copy leave the pending intent unchanged", async () => {
    const messageId = "mismatched-copy";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    const original = readFileSync(source);
    plant("unrelated-cur-copy");
    copyFileSync(source, curPath());
    writeFileSync(source, original);
    const intentPath = join(mailboxRoot, readdirSync(mailboxRoot).find((n) => n.startsWith(".placement-") && n.endsWith(".json"))!);
    const intent = readFileSync(intentPath);

    // The cur/ copy verifies, but as another message: deferred by name, twice, unchanged.
    expect(reasonOf(await client.deliverNext())).toBe("verification-failed");
    expect(reasonOf(await client.deliverNext())).toBe("verification-failed");
    expect(readFileSync(intentPath).equals(intent)).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
  });

  test("different invalid UTF-8 bytes with equal decoded text defer recovery", async () => {
    const messageId = "changed-raw-bytes";
    const source = plant(messageId);
    const record = readFileSync(source);
    const bytes = (byte: number) => Buffer.concat([
      Buffer.from('{"transport":"'), Buffer.from([byte]), Buffer.from('",'), record.subarray(1),
    ]);
    const original = bytes(0x80);
    const replacement = bytes(0x81);
    expect(original.equals(replacement)).toBe(false);
    expect(original.toString("utf8")).toBe(replacement.toString("utf8"));
    writeFileSync(source, original);
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    mkdirSync(join(mailboxRoot, "cur"));
    renameSync(source, curPath());
    const normal = verifier();
    let changed = false;
    const client = new MailClient(mailDir, undefined, AGENT, {
      async getAgent(name: string) {
        if (!changed) {
          changed = true;
          writeFileSync(curPath(), replacement);
        }
        return normal.getAgent(name);
      },
    });

    expect(reasonOf(await client.deliverNext())).toBe("record-changed");
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
    await assertDeliveredUntilCompleted(messageId);
  });

  test("an older intent without identity with only a cur copy is withheld", async () => {
    const messageId = "older-intent";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json");
    renameSync(source, curPath());
    expect(reasonOf(await client.deliverNext())).toBe("record-changed");
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
  });

  test("absent-copy cleanup preserves an intent while a mismatched cur copy exists", async () => {
    const messageId = "appeared-copy";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    copyFileSync(source, curPath());
    await (client as unknown as { finishUnlinkedPlacement(id: string, file: string): Promise<void> })
      .finishUnlinkedPlacement(messageId, "m1.json");
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
  });

  test("lock-acquisition failure leaves a cur-only placement pending", async () => {
    const messageId = "lock-failure";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    renameSync(source, curPath());
    // The client locks its mailbox at the path it resolved once at construction.
    const lock = await acquireMailLock(realpathSync(mailboxRoot));
    expect(lock).not.toBeNull();
    try {
      expect(reasonOf(await client.deliverNext())).toBe("lock-busy");
      expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    } finally {
      lock?.release();
    }
    await assertDeliveredUntilCompleted(messageId);
  });
});
