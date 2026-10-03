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

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { signEnvelope, type Envelope, type ChainEntry, type FlairClient } from "../src/lib/signEnvelope.js";
import { FlairContextProvider } from "../src/io/flair.js";
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

/**
 * The FlairClient adapter AgentRuntime builds for envelope verification
 * (a thin wrapper over the provider). Mirrored here so the outage drill
 * exercises the REAL provider, not a stub.
 */
function providerVerifier(provider: FlairContextProvider): FlairClient {
  return {
    async getAgent(name: string) {
      const a = await provider.getAgent(name);
      if (!a) return null;
      return { publicKey: Buffer.from(a.publicKey, "hex") };
    },
  };
}

function signedEnvelope(
  from: string,
  to: string,
  body: string,
  seeds: Record<string, Buffer>,
  overrides: Partial<Envelope> = {},
): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: "sends", signature: null },
  ];
  const envelope: Envelope = {
    v: 1,
    from,
    to,
    body,
    messageId: randomUUID(),
    timestamp: now,
    delegationChain: chain,
    ...overrides,
  };
  return signEnvelope(envelope, { [from]: seeds[from]! });
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
  test("NO verifier: construction throws", () => {
    expect(() => new MailClient(tmpDir, undefined, AGENT)).toThrow(/requires a Flair verifier/);
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
  test("a record a verifier could not run on is promoted once verification can run", async () => {
    const env = signedEnvelope("flint", AGENT, "heal me", { flint: FLINT });
    plant(wrapper("flint", env));

    const unreachable = new MailClient(tmpDir, undefined, AGENT, throwingFlair);
    expect((await unreachable.checkNewMail()).length).toBe(0);
    expect(files("new")).toContain("m1.json");

    const withVerifier = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const healed = await withVerifier.checkNewMail();
    expect(healed.length).toBe(1);
    expect(files("cur")).toContain("m1.json");
  });

  // ── Finding 1: an outage is RETRYABLE, not a terminal dead-letter ───────────

  test("an UNREACHABLE Flair is a RETRYABLE refusal (stays in new/), not a terminal dead-letter", async () => {
    const env = signedEnvelope("flint", AGENT, "during outage", { flint: FLINT });
    plant(wrapper("flint", env));

    const keyPath = join(tmpDir, "reader.key");
    writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const provider = new FlairContextProvider(AGENT, { url: "http://127.0.0.1:1", keyPath });
    const client = new MailClient(tmpDir, undefined, AGENT, providerVerifier(provider));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("dlq").length).toBe(0); // NOT dead-lettered
    expect(files("new")).toContain("m1.json"); // left for a later check (retryable)
  });

  test("a REACHABLE Flair that does not know the principal IS terminal (unresolvable-principal)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/Health") return new Response("ok", { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const env = signedEnvelope("flint", AGENT, "absent", { flint: FLINT });
      plant(wrapper("flint", env));
      const keyPath = join(tmpDir, "reader.key");
      writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
      const provider = new FlairContextProvider(AGENT, { url: server.url.href, keyPath });
      const client = new MailClient(tmpDir, undefined, AGENT, providerVerifier(provider));
      const msgs = await client.checkNewMail();

      expect(msgs.length).toBe(0);
      expect(files("dlq")).toContain("m1.json");
      expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain(
        "class: unresolvable-principal",
      );
    } finally {
      server.stop(true);
    }
  });

  // ── Finding 2: the guard checks WHO FOR, and the wrapper binding ────────────

  test("a correctly-signed envelope addressed to ANOTHER principal is not presented (wrong-recipient)", async () => {
    const env = signedEnvelope("flint", "someone-else", "not for me", { flint: FLINT });
    plant({ from: "flint", to: "someone-else", body: JSON.stringify(env) });

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("cur").length).toBe(0);
    expect(files("dlq")).toContain("m1.json");
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("class: wrong-recipient");
  });

  test("a wrapper whose from disagrees with the envelope is rejected (invalid)", async () => {
    const env = signedEnvelope("flint", AGENT, "spoofed wrapper", { flint: FLINT });
    plant({ from: "nathan", to: AGENT, body: JSON.stringify(env) });

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("dlq")).toContain("m1.json");
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("class: invalid");
  });

  test("an envelope with a malformed messageId is rejected (invalid)", async () => {
    const env = signedEnvelope("flint", AGENT, "bad id", { flint: FLINT }, { messageId: "" });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("dlq")).toContain("m1.json");
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("class: invalid");
  });

  test("a messageId outside the shared id rule is rejected (invalid)", async () => {
    const env = signedEnvelope("flint", AGENT, "bad id", { flint: FLINT }, { messageId: "has a space\n" });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    expect((await client.checkNewMail()).length).toBe(0);
    expect(files("cur").length).toBe(0);
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("invalid messageId");
  });

  test("a replyToId outside the shared id rule is rejected (invalid)", async () => {
    const env = signedEnvelope("flint", AGENT, "bad reply", { flint: FLINT }, { replyToId: "../../etc" });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    expect((await client.checkNewMail()).length).toBe(0);
    expect(files("cur").length).toBe(0);
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("invalid replyToId");
  });

  test("a signed replay is refused after the first copy has left cur/ (replay)", async () => {
    const env = signedEnvelope("flint", AGENT, "once only", { flint: FLINT });
    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));

    plant(wrapper("flint", env), "first.json");
    expect((await client.checkNewMail()).length).toBe(1);
    rmSync(join(inbox("cur"), "first.json"));

    plant(wrapper("flint", env), "again.json");
    expect((await client.checkNewMail()).length).toBe(0);
    expect(files("cur")).not.toContain("again.json");
    expect(readFileSync(join(inbox("dlq"), "again.json.reason"), "utf-8")).toContain("class: replay");
  });

  test("a messageId in the mailbox's consumed ledger is refused (replay)", async () => {
    const env = signedEnvelope("flint", AGENT, "consumed elsewhere", { flint: FLINT });
    mkdirSync(join(tmpDir, AGENT), { recursive: true });
    writeFileSync(
      join(tmpDir, AGENT, "consumed.jsonl"),
      `${JSON.stringify({ id: env.messageId, at: new Date().toISOString() })}\n`,
    );
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    expect((await client.checkNewMail()).length).toBe(0);
    expect(files("cur").length).toBe(0);
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("class: replay");
  });

  // ── cli#482: a first-delivery filename collision must not replace ──────────
  //
  // A second record under the SAME filename must not replace the delivered
  // record. Identical content is an idempotent duplicate (replay); different
  // content is an integrity error. Both leave cur/ untouched.
  test("a second delivery with the same filename and identical content is a duplicate no-op", async () => {
    const first = signedEnvelope("flint", AGENT, "hello", { flint: FLINT }, { messageId: "guard482-id-1" });
    plant(wrapper("flint", first), "collide.json");
    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    expect((await client.checkNewMail()).length).toBe(1);
    const before = readFileSync(join(inbox("cur"), "collide.json"), "utf-8");

    const again = signedEnvelope("flint", AGENT, "hello", { flint: FLINT }, { messageId: "guard482-id-2" });
    plant(wrapper("flint", again), "collide.json");
    expect((await client.checkNewMail()).length).toBe(0);

    expect(readFileSync(join(inbox("cur"), "collide.json"), "utf-8")).toBe(before); // delivered record untouched
    expect(files("new").length).toBe(0); // the duplicate left new/
    const sidecar = readFileSync(join(inbox("dlq"), "collide.json.reason"), "utf-8");
    expect(sidecar).toContain("class: replay");
    expect(sidecar).toContain("guard482-id-1");
  });

  test("a second delivery with the same filename and different content is an integrity error", async () => {
    const first = signedEnvelope("flint", AGENT, "original", { flint: FLINT }, { messageId: "guard482-id-3" });
    plant(wrapper("flint", first), "clash.json");
    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    expect((await client.checkNewMail()).length).toBe(1);
    const before = readFileSync(join(inbox("cur"), "clash.json"), "utf-8");

    const other = signedEnvelope("flint", AGENT, "different", { flint: FLINT }, { messageId: "guard482-id-4" });
    plant(wrapper("flint", other), "clash.json");
    expect((await client.checkNewMail()).length).toBe(0);

    expect(readFileSync(join(inbox("cur"), "clash.json"), "utf-8")).toBe(before); // delivered record untouched
    expect(files("dlq")).toContain("clash.json");
    const sidecar = readFileSync(join(inbox("dlq"), "clash.json.reason"), "utf-8");
    expect(sidecar).toContain("class: invalid");
    expect(sidecar).toContain("guard482-id-3"); // the delivered record id
    expect(sidecar).toContain("guard482-id-4"); // the incoming record id
  });

  for (const code of ["EACCES", "EISDIR"]) {
    test(`an unreadable ledger (${code}) with no cur/ copy withholds delivery`, async () => {
      const env = signedEnvelope("flint", AGENT, "once only", { flint: FLINT });
      const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
      plant(wrapper("flint", env), "first.json");
      expect(await client.checkNewMail()).toHaveLength(1);
      rmSync(join(inbox("cur"), "first.json"));
      plant(wrapper("flint", env), "again.json");
      const ledger = join(tmpDir, AGENT, "consumed.jsonl");
      const read = fs.readFileSync;
      const fault = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
        if (args[0] === ledger) throw Object.assign(new Error(code), { code });
        return read(...args);
      });
      try {
        expect(await client.checkNewMail()).toEqual([]);
        expect(files("cur")).toEqual([]);
        expect(files("new")).toContain("again.json");
      } finally {
        fault.mockRestore();
      }
      expect(await client.checkNewMail()).toEqual([]);
      expect(readFileSync(join(inbox("dlq"), "again.json.reason"), "utf-8")).toContain("class: replay");
    });
  }

  test("a failed ledger append and rollback are both reported without delivery", async () => {
    const env = signedEnvelope("flint", AGENT, "uncommitted", { flint: FLINT });
    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    plant(wrapper("flint", env));
    const append = fs.appendFileSync;
    const rename = fs.renameSync;
    const appendFault = spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof append>) => {
      if (args[0] === join(tmpDir, AGENT, "consumed.jsonl")) throw new Error("append fault");
      return append(...args);
    });
    const rollbackFault = spyOn(fs, "renameSync").mockImplementation((...args: Parameters<typeof rename>) => {
      if (args[0] === join(inbox("cur"), "m1.json")) throw new Error("rollback fault");
      return rename(...args);
    });
    try {
      await expect(client["commitToCur"]("m1.json", join(inbox("new"), "m1.json"),
        readFileSync(join(inbox("new"), "m1.json"), "utf-8"), env)).rejects.toThrow(/append fault.*rollback fault/);
      expect(readFileSync(join(tmpDir, AGENT, "consumed.jsonl"), "utf-8")).toBe("");
    } finally {
      appendFault.mockRestore();
      rollbackFault.mockRestore();
    }
  });

  test("an envelope with a malformed timestamp is rejected (invalid)", async () => {
    const env = signedEnvelope("flint", AGENT, "bad ts", { flint: FLINT }, { timestamp: "not-a-date" });
    plant(wrapper("flint", env));

    const client = new MailClient(tmpDir, undefined, AGENT, flairClient({ flint: pub(FLINT) }));
    const msgs = await client.checkNewMail();

    expect(msgs.length).toBe(0);
    expect(files("dlq")).toContain("m1.json");
    expect(readFileSync(join(inbox("dlq"), "m1.json.reason"), "utf-8")).toContain("class: invalid");
  });
});
