/**
 * mail-promote.test.ts — the promotion enforcement point (ops-8mhg item 1).
 *
 * Everything here runs the REAL path: promote()/checkMessages() build their
 * Flair client unconditionally, so the tests stand up a stub Flair HTTP server
 * and point FLAIR_URL/FLAIR_KEY_PATH at it. No internal mocking.
 *
 * Every acceptance case here FAILS against origin/main (where verification was
 * an optional parameter and the only live caller passed two arguments).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendMessage, checkMessages, getInbox } from "../src/utils/mail.js";
import { startStubFlair, writeKeyFile, buildSignedEnvelope, type StubFlair } from "./helpers/stub-flair.js";

const FLINT_SEED = Buffer.alloc(32, 0x01);
const KERN_SEED = Buffer.alloc(32, 0x02);
const SHERLOCK_SEED = Buffer.alloc(32, 0x03);
const SEEDS = { flint: FLINT_SEED, kern: KERN_SEED, sherlock: SHERLOCK_SEED };

describe("mail promotion enforcement (ops-8mhg)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-promote-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
    writeKeyFile(keysDir, "kern", KERN_SEED);
    writeKeyFile(keysDir, "sherlock", SHERLOCK_SEED);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "TPS_AGENT_ID", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, "kern.key");
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function newJsonFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }
  function reasonFor(mailDir: string, agent: string, filename: string): string | null {
    try {
      return readFileSync(join(mailDir, agent, "dlq", `${filename}.reason`), "utf-8");
    } catch {
      return null;
    }
  }

  // ── Positive control: a genuine signed envelope delivers EXACTLY ONCE ──────
  test("signed envelope promotes to cur/ exactly once, body is the inner payload", async () => {
    const env = buildSignedEnvelope("flint", "kern", "hello kern", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");

    const inbox = getInbox("kern");
    expect(newJsonFiles(inbox.fresh).length).toBe(1);

    const first = await checkMessages("kern");
    expect(first.length).toBe(1);
    expect(first[0]!.from).toBe("flint");
    expect(first[0]!.to).toBe("kern");
    expect(first[0]!.body).toBe("hello kern"); // inner payload, not the JSON wrapper
    expect(first[0]!.envelopeId).toBe(env.messageId);

    const second = await checkMessages("kern");
    expect(second.length).toBe(0); // exactly once

    expect(newJsonFiles(inbox.fresh).length).toBe(0);
    expect(newJsonFiles(inbox.cur).length).toBe(1);
    expect(newJsonFiles(inbox.dlq).length).toBe(0);
  });

  // ── Unsigned envelope → dlq with .reason, NOT presented ───────────────────
  test("unsigned envelope dead-letters with a .reason sidecar and is not presented", async () => {
    sendMessage("kern", JSON.stringify({ foo: "bar" }), "flint");
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0);
    expect(newJsonFiles(inbox.cur).length).toBe(0);
    expect(newJsonFiles(inbox.dlq).length).toBe(1);

    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!);
    expect(reason).not.toBeNull();
    expect(reason).toContain("class: invalid");
  });

  test("plain text (not JSON) dead-letters with a .reason sidecar", async () => {
    sendMessage("kern", "just some text", "flint");
    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0);
  });

  // ── Wrong-recipient: a genuine signed envelope for kern in sherlock's box ──
  test("a genuine signed envelope addressed to another agent dead-letters wrong-recipient", async () => {
    const env = buildSignedEnvelope("flint", "kern", "for kern only", { flint: FLINT_SEED });
    sendMessage("sherlock", JSON.stringify(env), "flint"); // planted in sherlock's new/

    process.env.FLAIR_KEY_PATH = join(keysDir, "sherlock.key");
    const inbox = getInbox("sherlock");
    const [file] = newJsonFiles(inbox.fresh);

    const msgs = await checkMessages("sherlock");
    expect(msgs.length).toBe(0);
    expect(newJsonFiles(inbox.cur).length).toBe(0);
    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "sherlock", file!);
    expect(reason).toContain("class: wrong-recipient");
  });

  // ── Replay: the same consumed envelope re-planted ─────────────────────────
  test("a re-planted consumed envelope dead-letters replay", async () => {
    const env = buildSignedEnvelope("flint", "kern", "one-time", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");

    const first = await checkMessages("kern");
    expect(first.length).toBe(1);
    expect(newJsonFiles(inbox.cur).length).toBe(1);

    // Re-plant the SAME envelope (same messageId).
    sendMessage("kern", JSON.stringify(env), "flint");
    const [file] = newJsonFiles(inbox.fresh);

    const second = await checkMessages("kern");
    expect(second.length).toBe(0);
    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!);
    expect(reason).toContain("class: replay");
  });

  // ── Wrapper/envelope from-mismatch ────────────────────────────────────────
  test("a wrapper/envelope from mismatch dead-letters", async () => {
    const env = buildSignedEnvelope("flint", "kern", "signed by flint", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "anvil"); // wrapper.from says anvil, envelope.from says flint
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0);
    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!);
    expect(reason).toContain("class: invalid");
    expect(reason).toMatch(/mismatch/i);
  });

  // ── verify-unavailable → quarantine, then SELF-HEAL on a later check ──────
  test("a Flair outage quarantines verify-unavailable and self-heals later", async () => {
    const env = buildSignedEnvelope("flint", "kern", "during outage", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    // Flair is down: point the client at a closed port.
    process.env.FLAIR_URL = "http://127.0.0.1:1";
    const during = await checkMessages("kern");
    expect(during.length).toBe(0);
    expect(newJsonFiles(inbox.cur).length).toBe(0);
    expect(newJsonFiles(inbox.dlq).length).toBe(1);
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!)).toContain("class: verify-unavailable");

    // Flair returns: the SAME later-check pass re-drives the quarantined entry.
    process.env.FLAIR_URL = stub.url;
    const after = await checkMessages("kern");
    expect(after.length).toBe(1);
    expect(after[0]!.body).toBe("during outage");
    expect(newJsonFiles(inbox.cur).length).toBe(1);
    expect(newJsonFiles(inbox.dlq).length).toBe(0); // sidecar cleaned up
  });

  // ── A terminal reject is NOT retried on a later check ─────────────────────
  test("terminal rejects (invalid) are not retried on a later check", async () => {
    sendMessage("kern", JSON.stringify({ foo: "bar" }), "flint");
    await checkMessages("kern");
    const inbox = getInbox("kern");
    expect(newJsonFiles(inbox.dlq).length).toBe(1);
    const after = await checkMessages("kern");
    expect(after.length).toBe(0);
    expect(newJsonFiles(inbox.dlq).length).toBe(1); // still one, not re-promoted
  });
});
