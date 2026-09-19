/**
 * mail-promote-guard.test.ts — cli#380 F1 (the packages/agent maildir→model path).
 *
 * `packages/agent/src/io/mail.ts` is a FOURTH consumer that reaches a
 * tool-holding EventLoop (AgentRuntime's EventLoop), alongside the three
 * runtimes moved onto the shared promote() lifecycle. It promoted `new/`→`cur/`
 * with verification OPTIONAL, two ways:
 *
 *   1. `checkNewMail()` guarded verification behind `if (this.flairClient)`, so
 *      a runtime built without Flair config promoted unverified mail;
 *   2. `verifyMailBody()` swallowed a verifier THROW and returned `pass: true`,
 *      so a Flair outage promoted unverified mail.
 *
 * These drills pin the fail-CLOSED contract: no verifier → no promotion;
 * a throw → no promotion; a deterministic reject → dlq/ with the shared
 * `.reason` sidecar. Both defects are RED at 545e23cd and GREEN after.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { signEnvelope, type Envelope, type ChainEntry, type FlairClient } from "../src/lib/signEnvelope.js";
import { MailClient } from "../src/io/mail.js";

const AGENT = "mailbox";

function seed(b: number): Buffer {
  return Buffer.alloc(32, b);
}
function pub(seedBytes: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seedBytes)));
}

/** FlairClient stub resolving the named agents to their public keys. */
function flairClient(agents: Record<string, Buffer>): FlairClient {
  return {
    async getAgent(name: string) {
      const pk = agents[name];
      return pk ? { publicKey: pk } : null;
    },
  };
}

/** A verifier that cannot run (Flair unreachable). */
const throwingFlair: FlairClient = {
  async getAgent() {
    throw new Error("Flair unreachable: ECONNREFUSED");
  },
};

function signedEnvelope(from: string, to: string, body: string, seeds: Record<string, Buffer>): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: "sends", signature: null },
  ];
  return signEnvelope(
    { v: 1, from, to, body, messageId: randomUUID(), timestamp: now, delegationChain: chain },
    { [from]: seeds[from]! },
  );
}

describe("agent MailClient promotion is fail-closed (cli#380 F1)", () => {
  let tmpDir: string;
  const FLINT = seed(0x01);
  const KERN = seed(0x02);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-agent-mail-guard-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const inbox = (d: "new" | "cur" | "dlq") => join(tmpDir, AGENT, d);
  const files = (d: "new" | "cur" | "dlq") =>
    existsSync(inbox(d)) ? readdirSync(inbox(d)).filter((f) => f.endsWith(".json")) : [];
  const wrapper = (from: string, env: Envelope) => ({ from, to: AGENT, body: JSON.stringify(env) });
  const plant = (wrapperObj: unknown, name = "m1.json") => {
    mkdirSync(inbox("new"), { recursive: true });
    writeFileSync(join(inbox("new"), name), JSON.stringify(wrapperObj), "utf-8");
  };

  // ── F1 defect 1: verification was optional (no client ⇒ unverified promote) ─
  test("NO verifier: refuses to promote — the record stays in new/", async () => {
    const env = signedEnvelope("flint", AGENT, "hello", { flint: FLINT });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT); // no flairClient
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("new")).toContain("m1.json"); // untouched
    expect(files("cur").length).toBe(0); // never promoted
  });

  // ── F1 defect 2: the verifier throw was swallowed and treated as a pass ────
  test("THROWING verifier: refuses to promote — a throw must not mean pass", async () => {
    const env = signedEnvelope("flint", AGENT, "hello", { flint: FLINT });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, throwingFlair);
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("new")).toContain("m1.json");
    expect(files("cur").length).toBe(0);
  });

  // ── Deterministic rejection → dlq with the SHARED `.reason` sidecar ────────
  test("a signature rejection dead-letters to dlq with a `.reason` sidecar (class: invalid)", async () => {
    const env = signedEnvelope("flint", AGENT, "tampered", { flint: FLINT });
    // Resolve flint to the WRONG key → signature verification fails.
    const wrongKey = flairClient({ flint: pub(KERN) });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, wrongKey);
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("cur").length).toBe(0);
    expect(files("dlq")).toContain("m1.json");

    const sidecar = join(inbox("dlq"), "m1.json.reason");
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf-8")).toContain("class: invalid");
    // Not the old `.reject` sidecar the shared re-drive cannot read.
    expect(existsSync(join(inbox("dlq"), "m1.json.reject"))).toBe(false);
  });

  // ── Topology failure is labelled as such, not as forgery (mirrors #383) ────
  test("an unresolvable principal dead-letters as `unresolvable-principal`, not `invalid`", async () => {
    const ghost = seed(0x09);
    const env = signedEnvelope("ghost", AGENT, "from nowhere", { ghost });
    const reachableNoGhost = flairClient({ flint: pub(FLINT) }); // Flair up, ghost absent
    plant(wrapper("ghost", env));

    const client = new MailClient(tmpDir, undefined, AGENT, reachableNoGhost);
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("dlq")).toContain("m1.json");
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain(
      "class: unresolvable-principal",
    );
  });

  // ── A non-envelope body is a terminal reject too ───────────────────────────
  test("a plain (non-envelope) body is dead-lettered, never promoted", async () => {
    plant({ from: "flint", to: AGENT, body: "plain text, no envelope" });
    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("cur").length).toBe(0);
    expect(files("dlq")).toContain("m1.json");
  });

  // ── Positive control: a valid signed envelope IS promoted ──────────────────
  test("a valid signed envelope with a working verifier is promoted to cur/", async () => {
    const env = signedEnvelope("flint", AGENT, "do the thing", { flint: FLINT });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("flint");
    // The agent MailClient presents the raw record body (unchanged); the
    // verified content is the signed envelope inside it.
    const raw = JSON.parse(msgs[0]!.body) as { from: string; body: string };
    expect(raw.from).toBe("flint");
    expect((JSON.parse(raw.body) as Envelope).body).toBe("do the thing");
    expect(files("cur")).toContain("m1.json");
    expect(files("new").length).toBe(0);
  });

  // ── The refusal is non-destructive: a later verifier promotes the same file ─
  test("a record refused without a verifier is promoted once a verifier is present", async () => {
    const env = signedEnvelope("flint", AGENT, "heal me", { flint: FLINT });
    plant(wrapper("flint", env));

    const noVerifier = new MailClient(tmpDir, undefined, AGENT);
    expect((await noVerifier.checkNewMail()).length).toBe(0);
    expect(files("new")).toContain("m1.json");

    const withVerifier = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const healed = await withVerifier.checkNewMail();
    expect(healed.length).toBe(1);
    expect(files("cur")).toContain("m1.json");
  });
});
