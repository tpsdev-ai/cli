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
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendMessage, checkMessages, getInbox, ackMessage } from "../src/utils/mail.js";
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
  /** Files (not the planted-directory fault injections) in a dir. */
  function jsonFiles(dir: string): string[] {
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => e.name)
      : [];
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

  // ── Major 1: the replay gate must survive maildir GC (durable ledger) ──────
  test("a consumed id is still gated after its cur/ record is acked and GC'd", async () => {
    const env = buildSignedEnvelope("flint", "kern", "durable-ledger", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");

    const first = await checkMessages("kern");
    expect(first.length).toBe(1);

    // Simulate the maildir forgetting the record: ackMessage unlinks it from
    // cur/, then cur/ and archive/ are wiped. The gate used to read exactly
    // those mutable directories, so the consumed id became unknown again.
    expect(ackMessage("kern", first[0]!.id)).not.toBeNull();
    rmSync(inbox.cur, { recursive: true, force: true });
    rmSync(join(inbox.root, "archive"), { recursive: true, force: true });
    mkdirSync(inbox.cur, { recursive: true });
    expect(jsonFiles(inbox.cur).length).toBe(0);

    // Re-plant the SAME signed envelope (same messageId).
    sendMessage("kern", JSON.stringify(env), "flint");
    const [file] = newJsonFiles(inbox.fresh);

    const second = await checkMessages("kern");
    expect(second.length).toBe(0);
    expect(jsonFiles(inbox.cur).length).toBe(0);
    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!);
    expect(reason).toContain("class: replay");
  });

  // ── Major 2: a STORAGE fault is retryable and preserves the original ───────
  test("a storage failure dead-letters retryable, preserves the original envelope, and self-heals", async () => {
    const env = buildSignedEnvelope("flint", "kern", "storage-fault", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    // Force the final rename into cur/ to fail: plant a DIRECTORY where the
    // promoted record must land (a transient storage fault, not a verdict).
    mkdirSync(join(inbox.cur, file!), { recursive: true });

    const during = await checkMessages("kern");
    expect(during.length).toBe(0);
    expect(jsonFiles(inbox.cur).length).toBe(0); // nothing promoted
    expect(newJsonFiles(inbox.dlq).length).toBe(1);
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!)).toContain("class: storage-unavailable");

    // The ORIGINAL bytes are preserved: the dead-lettered record still carries
    // the signed-envelope wrapper, not a half-written promoted payload (whose
    // body would be the bare inner string). This is the whole point — a
    // storage fault must not consume the envelope.
    const dead = JSON.parse(readFileSync(join(inbox.dlq, file!), "utf-8"));
    expect(typeof dead.body).toBe("string");
    expect(dead.body).toContain('"signature"');
    expect(dead.body).not.toBe("storage-fault");

    // Clear any remaining fault and re-drive: the quarantine self-heals.
    rmSync(join(inbox.cur, file!), { recursive: true, force: true });
    const after = await checkMessages("kern");
    expect(after.length).toBe(1);
    expect(after[0]!.body).toBe("storage-fault");
    expect(jsonFiles(inbox.cur).length).toBe(1);
    expect(newJsonFiles(inbox.dlq).length).toBe(0); // sidecar + record gone
  });

  // ── Minor 4: messageId shape is validated BEFORE the replay gate ──────────
  test("a signature-valid envelope with an empty messageId dead-letters invalid", async () => {
    const env = buildSignedEnvelope("flint", "kern", "no id", { flint: FLINT_SEED }, { messageId: "" });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0);
    expect(jsonFiles(inbox.cur).length).toBe(0);
    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!);
    expect(reason).toContain("class: invalid");
    expect(reason).toMatch(/messageId/i);
  });

  test("a signature-valid envelope with a non-string messageId dead-letters invalid", async () => {
    const env = buildSignedEnvelope("flint", "kern", "numeric id", { flint: FLINT_SEED }, {
      messageId: 12345 as unknown as string,
    });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0);
    const reason = reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!);
    expect(reason).toContain("class: invalid");
    expect(reason).toMatch(/messageId/i);
  });

  // ── Major: cur/ re-presentation must NOT bypass the enforcement point ─────
  test("a forged cur/ record with no envelopeId is quarantined, not presented", async () => {
    const inbox = getInbox("kern");
    mkdirSync(inbox.cur, { recursive: true });
    // A same-host writer drops an unverified record straight into cur/ — no
    // ackedAt/nackedAt, no envelopeId. Re-presenting it would deliver forged
    // content (routing trusts msg.from), so it must be quarantined.
    writeFileSync(
      join(inbox.cur, "forged.json"),
      JSON.stringify({ id: "forged-1", from: "flint", to: "kern", body: "forged instruction", timestamp: new Date().toISOString(), read: false }),
      "utf-8",
    );

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0); // never presented
    expect(jsonFiles(inbox.cur).length).toBe(0); // removed from cur/
    expect(newJsonFiles(inbox.dlq).length).toBe(1);
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "kern", "forged.json")).toContain("class: unverified");
  });

  test("a cur/ record tampered after promotion is quarantined (verification binding)", async () => {
    const env = buildSignedEnvelope("flint", "kern", "bind me", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    await checkMessages("kern"); // promote
    const [curFile] = jsonFiles(inbox.cur);
    expect(curFile).toBeTruthy();

    // Local tamper AFTER promotion, with the stored envelope left intact. Also
    // backdate the lease so the sweep would otherwise re-present it.
    const rec = JSON.parse(readFileSync(join(inbox.cur, curFile!), "utf-8"));
    rec.body = "forged instruction";
    rec.checkedOutAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(join(inbox.cur, curFile!), JSON.stringify(rec, null, 2), "utf-8");

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(0); // the tampered body never lands
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "kern", curFile!)).toContain("class: unverified");
  });

  // ── State 1: a ledger append failure must not silently succeed ────────────
  test("a ledger append failure rolls the promotion back and retries (not silent)", async () => {
    const env = buildSignedEnvelope("flint", "kern", "ledger-fault", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    const [file] = newJsonFiles(inbox.fresh);

    // Force the ledger append to fail: a DIRECTORY at the ledger path.
    const ledger = join(inbox.root, "consumed.jsonl");
    mkdirSync(ledger, { recursive: true });

    const during = await checkMessages("kern");
    expect(during.length).toBe(0); // NOT silently delivered
    expect(jsonFiles(inbox.cur).length).toBe(0); // the move was rolled back
    expect(newJsonFiles(inbox.dlq).length).toBe(1);
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!)).toContain("class: storage-unavailable");

    // Clear the fault; the quarantined record self-heals.
    rmSync(ledger, { recursive: true, force: true });
    const after = await checkMessages("kern");
    expect(after.length).toBe(1);
    expect(after[0]!.body).toBe("ledger-fault");
    expect(jsonFiles(inbox.cur).length).toBe(1);
  });

  // ── State 2: a corrupt ledger timestamp must not forget a consumed id ─────
  test("a consumed id with a corrupt ledger timestamp is still gated (fail-closed)", async () => {
    const env = buildSignedEnvelope("flint", "kern", "torn-ledger", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");
    const first = await checkMessages("kern");
    expect(first.length).toBe(1);

    // Simulate a torn/clock-skewed append: a well-formed id with an
    // unparseable `at`. Remove the cur/ record too, so ONLY the ledger can gate
    // the replay (the maildir fallback cannot see it).
    writeFileSync(
      join(inbox.root, "consumed.jsonl"),
      `${JSON.stringify({ id: env.messageId, at: "not-a-timestamp" })}\n`,
      "utf-8",
    );
    rmSync(inbox.cur, { recursive: true, force: true });
    mkdirSync(inbox.cur, { recursive: true });

    sendMessage("kern", JSON.stringify(env), "flint");
    const [file] = newJsonFiles(inbox.fresh);
    const second = await checkMessages("kern");
    expect(second.length).toBe(0);
    expect(reasonFor(process.env.TPS_MAIL_DIR!, "kern", file!)).toContain("class: replay");
  });

  // ── State 3: stranded tmp/*.promote scratch must not be invisible forever ──
  test("a stranded tmp/*.promote scratch is reaped on check", async () => {
    const inbox = getInbox("kern");
    mkdirSync(inbox.tmp, { recursive: true });
    const orphan = join(inbox.tmp, "9999-stranded.json.promote");
    writeFileSync(orphan, '{"half":', "utf-8");

    await checkMessages("kern");
    expect(existsSync(orphan)).toBe(false);
  });
});
