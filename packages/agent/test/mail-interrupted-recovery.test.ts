/** Real filesystem crash-boundary and unresolved-intent regressions (cli#600). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { MailClient } from "../src/io/mail.js";
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

/** Run checkNewMail() in a child and SIGKILL it at `killAt`; resolve on exit. */
function runAndKillAt(killAt: string, source: string, timeoutMs = 20_000): Promise<KillRun> {
  const marker = join(mailDir, `paused.${killAt}`);
  const child = spawn(process.execPath, [CHILD, mailDir, AGENT], {
    env: {
      HOME: mailDir,
      PATH: process.env.PATH,
      TPS_MAIL_MODULE: MODULE,
      TPS_KILL_AT: killAt,
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

/** Check consecutive calls from a fresh client and placement cleanup. */
async function assertDeliveredExactlyOnce(messageId: string): Promise<void> {
  const client = new MailClient(mailDir, undefined, AGENT, verifier());
  const first = await client.checkNewMail();
  const second = await client.checkNewMail();

  expect(first.map((m) => m.verifiedEnvelope?.messageId)).toEqual([messageId]);
  expect(second).toEqual([]);
  expect(existsSync(newPath())).toBe(false);
  expect(jsonFiles(join(mailboxRoot, "cur"))).toEqual(["m1.json"]);
  expect(jsonFiles(join(mailboxRoot, "dlq"))).toEqual([]);
  expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(true);
  expect(
    readdirSync(mailboxRoot).some((n) => n.startsWith(".placement-") && n.endsWith(".json")),
  ).toBe(false);
}

const CASES = ["intent-write", "link-to-cur", "source-removal", "ledger-commit", "intent-finish"];

describe("MailClient recovery at the tested placement boundaries (cli#600)", () => {
  for (const at of CASES) {
    test(`a later check returns the message once after a kill before ${at}`, async () => {
      const messageId = `kill-${at}`;
      const source = plant(messageId);
      const run = await runAndKillAt(at, source);
      expect(run.reached, `child never reached ${at}; stderr=${run.stderr}`).toBe(true);
      expect(run.signal).toBe("SIGKILL");
      await assertDeliveredExactlyOnce(messageId);
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

    expect(await client.checkNewMail()).toEqual([]);
    expect(await client.checkNewMail()).toEqual([]);
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

    expect(await client.checkNewMail()).toEqual([]);
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
    await assertDeliveredExactlyOnce(messageId);
  });

  test("an older intent without identity with only a cur copy is withheld", async () => {
    const messageId = "older-intent";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json");
    renameSync(source, curPath());
    expect(await client.checkNewMail()).toEqual([]);
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
    const lock = await acquireMailLock(mailboxRoot);
    expect(lock).not.toBeNull();
    try {
      expect(await client.checkNewMail()).toEqual([]);
      expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    } finally {
      lock?.release();
    }
    await assertDeliveredExactlyOnce(messageId);
  });
});
