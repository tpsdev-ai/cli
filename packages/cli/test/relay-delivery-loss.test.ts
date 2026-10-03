/**
 * relay-delivery-loss.test.ts — cli#494.
 *
 * A message relayed by `tps office connect` / `tps office sync` from a remote
 * branch to a LOCAL agent was lost without a trace when the local inbox was at
 * its cap: `sendMessage` threw "Inbox full" and the relay's `catch {}` swallowed
 * it, so the message was neither delivered nor dead-lettered and nothing was
 * logged.
 *
 * The tests here exercise the real delivery helper the relay now shares:
 * `deliverRelayedToLocal`. Every case FAILS on origin/main, where the helper
 * does not exist (the two relay handlers each carried their own `catch {}`).
 * Verification is the real path: FLAIR_URL points at a stub Flair so the
 * dead-lettered record can be RE-DRIVEN through checkMessages() and promoted to
 * cur/, proving it is retained and not stranded.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkMessages, getInbox, MAX_INBOX_MESSAGES, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal } from "../src/utils/relay.js";
import type { Envelope } from "@tpsdev-ai/agent";
import { startStubFlair, writeKeyFile, buildSignedEnvelope, type StubFlair } from "./helpers/stub-flair.js";

const REMOTE_SEED = Buffer.alloc(32, 0x11);
const LOCAL_SEED = Buffer.alloc(32, 0x22);
const SEEDS = { remote: REMOTE_SEED, local: LOCAL_SEED };

describe("relayed local delivery retention (cli#494)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-relay-loss-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
    writeKeyFile(keysDir, "local", LOCAL_SEED);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, "local.key");
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function jsonFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  /** Fill the recipient's new/ to the cap with unprocessable filler. */
  function fillInboxToCap(agent: string): void {
    const fresh = getInbox(agent).fresh;
    for (let i = 0; i < MAX_INBOX_MESSAGES; i++) {
      sendMessage(agent, `filler-${i}`, "seeder");
    }
    expect(jsonFiles(fresh).length).toBe(MAX_INBOX_MESSAGES);
  }

  /** Capture console.error while `fn` runs. */
  function captureError(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      fn();
    } finally {
      console.error = original;
    }
    return lines;
  }

  function relayedEnvelope(): { env: Envelope; body: () => { id: string; from: string; to: string; content: string; timestamp: string } } {
    const env = buildSignedEnvelope("remote", "local", "relayed reply", { remote: REMOTE_SEED });
    return {
      env,
      body: () => ({
        id: randomUUID(),
        from: "remote",
        to: "local",
        content: JSON.stringify(env),
        timestamp: env.timestamp,
      }),
    };
  }

  test("an over-cap inbox: the relayed message is dead-lettered, not dropped", () => {
    fillInboxToCap("local");
    const { env, body } = relayedEnvelope();
    const msg = body();

    const logs = captureError(() => {
      expect(deliverRelayedToLocal(msg)).toBe(false);
    });

    // Never silent: the failure names the message id, the recipient and the error.
    const joined = logs.join("\n");
    expect(joined).toContain(msg.id);
    expect(joined).toContain("local");
    expect(joined).toContain("Inbox full");

    // Retained: the record is in the recipient's dlq with a reason sidecar.
    const inbox = getInbox("local");
    const dlq = jsonFiles(inbox.dlq);
    expect(dlq.length).toBe(1);
    const record = JSON.parse(readFileSync(join(inbox.dlq, dlq[0]!), "utf-8"));
    expect(record.body).toBe(JSON.stringify(env));
    expect(record.id).toBe(msg.id);
    const reason = readFileSync(join(inbox.dlq, `${dlq[0]!}.reason`), "utf-8");
    expect(reason).toContain("class: inbox-full");
    expect(reason).toContain("Inbox full");
  });

  test("after the inbox drains, the retained message is delivered (retryable class)", async () => {
    fillInboxToCap("local");
    const { env, body } = relayedEnvelope();
    expect(deliverRelayedToLocal(body())).toBe(false);

    const inbox = getInbox("local");
    // Drain new/ the way `mail check` does. The relayed message is the only
    // record in dlq (the filler never left new/).
    for (const f of jsonFiles(inbox.fresh)) rmSync(join(inbox.fresh, f));
    expect(jsonFiles(inbox.dlq).length).toBe(1);

    const delivered = await checkMessages("local");
    const mine = delivered.filter((m) => m.envelopeId === env.messageId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.body).toBe("relayed reply");
    expect(jsonFiles(inbox.cur).length).toBe(1);
    expect(jsonFiles(inbox.dlq).length).toBe(0);
  });

  test("a relayed message with room in the inbox is delivered and never dead-lettered", () => {
    const { body } = relayedEnvelope();
    const msg = body();
    const logs = captureError(() => {
      expect(deliverRelayedToLocal(msg)).toBe(true);
    });
    expect(logs).toEqual([]);
    const inbox = getInbox("local");
    expect(jsonFiles(inbox.fresh).length).toBe(1);
    expect(jsonFiles(inbox.dlq).length).toBe(0);
  });
});
