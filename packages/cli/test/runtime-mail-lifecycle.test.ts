/**
 * runtime-mail-lifecycle.test.ts — cli#380 PR 1 drills.
 *
 * The three agent runtimes used to carry a private `checkNewMail()` that
 * renamed `new/`→`cur/` with NO verification and then handed the body to a
 * tool-holding model. These tests exercise the promoted lifecycle they now use
 * (utils/runtime-mail.ts): promotion through `promote()`, retryable-`dlq`
 * self-heal, `cur/` recovery + lease sweep, SIGNED outbound, and ack AFTER the
 * completion boundary.
 *
 * Everything runs the REAL path: pollRuntimeMail() builds its Flair client
 * unconditionally, so the tests stand up the stub Flair HTTP server and point
 * the runtime-scoped verify config at it. No internal mocking.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyEnvelope } from "@tpsdev-ai/agent";
import { getInbox, sendMessage, getMailDir } from "../src/utils/mail.js";
import { createMailVerifyClient } from "../src/utils/mail-verify.js";
import {
  pollRuntimeMail,
  sendRuntimeMail,
  completeRuntimeMail,
  runtimeBootPreflight,
} from "../src/utils/runtime-mail.js";
import { startStubFlair, writeKeyFile, buildSignedEnvelope, type StubFlair } from "./helpers/stub-flair.js";

const FLINT_SEED = Buffer.alloc(32, 0x01);
const KERN_SEED = Buffer.alloc(32, 0x02);
const SHERLOCK_SEED = Buffer.alloc(32, 0x03);
const SEEDS = { flint: FLINT_SEED, kern: KERN_SEED, sherlock: SHERLOCK_SEED };

describe("runtime promote() lifecycle (cli#380 PR 1)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;
  let kernKey: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-runtime-mail-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
    writeKeyFile(keysDir, "kern", KERN_SEED);
    writeKeyFile(keysDir, "flint", FLINT_SEED);
    kernKey = join(keysDir, "kern.key");

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) savedEnv[k] = process.env[k];
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    // Deliberately DO NOT set FLAIR_URL/FLAIR_KEY_PATH: the runtime-scoped
    // config must be the thing that resolves the endpoint (requirement 4).
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_KEY_PATH;
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const kernCfg = () => ({ agentId: "kern", flairUrl: stub.url, flairKeyPath: kernKey });

  function files(dir: string): string[] {
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name)
      : [];
  }

  // ── 1. Signed mail is promoted; unsigned mail is NOT presented ─────────────
  test("promotes a signed envelope and dead-letters an unsigned body instead of running it", async () => {
    const env = buildSignedEnvelope("flint", "kern", "do the thing", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    sendMessage("kern", "plain text, no envelope", "flint");

    const inbox = getInbox("kern");
    const msgs = await pollRuntimeMail(kernCfg());

    // Only the signed envelope is presented to the runtime; the unsigned body is
    // unverified input and must never reach a tool-holding model.
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("flint");
    expect(msgs[0]!.body).toBe("do the thing");
    expect(msgs[0]!.envelopeId).toBe(env.messageId);

    expect(files(inbox.cur).length).toBe(1);
    expect(files(inbox.dlq).length).toBe(1); // the unsigned one was quarantined

    const reason = readFileSync(join(inbox.dlq, `${files(inbox.dlq)[0]}.reason`), "utf-8");
    expect(reason).toContain("class: invalid");
  });

  // ── 2. Runtime-scoped verify config (requirement 4, corrected) ─────────────
  test("verification uses the runtime's own flairUrl/keyPath, not the process env", async () => {
    // Sanity: the env is NOT what makes this work.
    expect(process.env.FLAIR_URL).toBeUndefined();

    const env = buildSignedEnvelope("flint", "kern", "runtime-scoped verify", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");

    const msgs = await pollRuntimeMail(kernCfg());
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.envelopeId).toBe(env.messageId);
  });

  // ── 3. Ack removes the record; it is not re-presented ──────────────────────
  test("completeRuntimeMail acks so the record is not re-presented (no infinite re-dispatch)", async () => {
    const env = buildSignedEnvelope("flint", "kern", "ack me", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");

    const first = await pollRuntimeMail(kernCfg());
    expect(first.length).toBe(1);
    completeRuntimeMail(kernCfg(), first[0]!.id);

    expect(files(inbox.cur).length).toBe(0); // ack removed the cur/ record

    // Even with an expired lease, an acked record never comes back.
    const again = await pollRuntimeMail(kernCfg());
    expect(again.length).toBe(0);
  });

  // ── 4. Un-acked record past its lease IS re-presented (the #377 sweep) ─────
  test("an un-acked cur/ record past its lease is re-presented; acked is not", async () => {
    const env = buildSignedEnvelope("flint", "kern", "long task", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");

    const first = await pollRuntimeMail(kernCfg());
    expect(first.length).toBe(1);

    // Age the lease past LEASE_TIMEOUT_MS (30m) by rewriting checkedOutAt.
    const [file] = files(inbox.cur);
    const curPath = join(inbox.cur, file!);
    const rec = JSON.parse(readFileSync(curPath, "utf-8"));
    rec.checkedOutAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(curPath, JSON.stringify(rec, null, 2), "utf-8");

    const rePresented = await pollRuntimeMail(kernCfg());
    expect(rePresented.length).toBe(1); // re-presented because it was never acked

    completeRuntimeMail(kernCfg(), rePresented[0]!.id);
    expect(files(inbox.cur).length).toBe(0);
  });

  // ── 5. Retryable dlq self-heals on a later poll (requirement 2) ────────────
  test("mail parked verify-unavailable is re-driven once Flair returns", async () => {
    const env = buildSignedEnvelope("flint", "kern", "heal me", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint");
    const inbox = getInbox("kern");

    // Flair unreachable (connection refused) → retryable quarantine.
    const downCfg = { agentId: "kern", flairUrl: "http://127.0.0.1:1", flairKeyPath: kernKey };
    const down = await pollRuntimeMail(downCfg);
    expect(down.length).toBe(0);
    expect(files(inbox.dlq).length).toBe(1);
    const reason = readFileSync(join(inbox.dlq, `${files(inbox.dlq)[0]}.reason`), "utf-8");
    expect(reason).toContain("verify-unavailable");

    // Flair back → the same poll re-drives the quarantined record.
    const healed = await pollRuntimeMail(kernCfg());
    expect(healed.length).toBe(1);
    expect(healed[0]!.envelopeId).toBe(env.messageId);
    expect(files(inbox.cur).length).toBe(1);
  });

  // ── 6. Outbound is SIGNED, honors the configured key, no silent fallback ───
  test("sendRuntimeMail writes a verifiable signed envelope using the configured key", async () => {
    sendRuntimeMail(kernCfg(), "flint", "the reply");

    const outbox = getInbox("flint");
    const [file] = files(outbox.fresh);
    expect(file).toBeDefined();
    const wrapper = JSON.parse(readFileSync(join(outbox.fresh, file!), "utf-8"));
    const env = JSON.parse(wrapper.body);
    expect(env.from).toBe("kern");
    expect(env.to).toBe("flint");
    expect(env.body).toBe("the reply");

    const client = await createMailVerifyClient("kern", { flairUrl: stub.url, flairKeyPath: kernKey });
    const verified = await verifyEnvelope(env, client);
    expect(verified.ok).toBe(true);
  });

  test("sendRuntimeMail refuses to send unsigned when the key is missing", () => {
    const badCfg = { agentId: "kern", flairUrl: stub.url, flairKeyPath: join(keysDir, "missing.key") };
    expect(() => sendRuntimeMail(badCfg, "flint", "should not ship")).toThrow(/refusing to send an unsigned body/);
  });

  // ── 7. Mailbox-root consistency (requirement 6) ────────────────────────────
  test("promotion and acknowledgement resolve the SAME (branch-office) mailbox", async () => {
    // A branch-office mail root exists → getInbox() prefers it.
    const branchRoot = join(tempRoot, ".tps", "branch-office", "kern", "mail");
    for (const d of ["new", "cur", "tmp", "dlq"]) mkdirSync(join(branchRoot, d), { recursive: true });

    const env = buildSignedEnvelope("flint", "kern", "branch mail", { flint: FLINT_SEED });
    sendMessage("kern", JSON.stringify(env), "flint"); // routed via getInbox → branch root

    expect(getInbox("kern").root).toBe(branchRoot);
    expect(files(join(branchRoot, "new")).length).toBe(1);

    const msgs = await pollRuntimeMail(kernCfg());
    expect(msgs.length).toBe(1);
    // Promoted into the SAME root it was polled from.
    expect(files(join(branchRoot, "cur")).length).toBe(1);
    expect(files(join(getMailDir(), "kern", "cur")).length).toBe(0);

    completeRuntimeMail(kernCfg(), msgs[0]!.id);
    // Ack resolved the same mailbox and removed the record there.
    expect(files(join(branchRoot, "cur")).length).toBe(0);
  });

  // ── 8. Boot preflight: loud on failure, true when up ───────────────────────
  test("runtimeBootPreflight reports reachability and is loud on failure", async () => {
    expect(await runtimeBootPreflight({ ping: async () => true }, "kern")).toBe(true);
    expect(await runtimeBootPreflight({ ping: async () => false }, "kern")).toBe(false);
  });
});
