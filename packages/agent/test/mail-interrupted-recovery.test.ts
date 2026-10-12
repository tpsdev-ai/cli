/**
 * mail-interrupted-recovery.test.ts — cli#600.
 *
 * MailClient's first delivery writes a placement intent, links `new/<file>`
 * into `cur/<file>`, unlinks `new/<file>`, commits the consumed id and finishes
 * the intent. A process killed after the `new/<file>` unlink and before the
 * consumed id is committed left the record's only copy in `cur/` under a
 * pending intent, which the `new/` scan never sees (gc and archive skip
 * whatever the intent names), so a later check never returned it.
 *
 * Each case runs a REAL checkNewMail() in a child process and SIGKILLs it at an
 * injected pause point BEFORE a named filesystem operation — a killed process,
 * never an injected error — then checks from a fresh client: the message is
 * returned exactly once, never duplicated. Every spawned process has a
 * deadline; roots are mkdtemp'd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { MailClient } from "../src/io/mail.js";
import { hasCommittedMessageId } from "../src/lib/mailbox-policy.js";
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

/** Plant one verified record in new/ and return its path. */
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

/** A fresh client returns the message once and never again; no leftover intent. */
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

describe("MailClient recovers a delivery interrupted at any placement step (cli#600)", () => {
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
