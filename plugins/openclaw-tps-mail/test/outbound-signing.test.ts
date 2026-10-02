/**
 * outbound-signing.test.ts — cli#433 slice B1: the channel adapter's outbound
 * `sendText` emits a SIGNED envelope through the ONE outbound signing path
 * (`tps mail send`'s, the CLI's `mail-producer` helper) — the same key
 * resolution and the same named refusal when no key exists. The reply thread
 * rides INSIDE the signed envelope (`replyToId`), so the record carries no
 * unsigned wrapper field a reader could present as a thread that was never
 * signed.
 *
 * The verification seam is replaced (`mock.module`, exactly as the locality
 * suite does) so the recipient's REAL `promote()` runs with an in-process key
 * provider: no Flair, no network. The isolated launcher already points HOME,
 * TPS_MAIL_DIR and TPS_TEST_KEYS_DIR at a throwaway root.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const SENDER = "anvil"; // the channel identity sendText resolves from ctx.identity
const RECIPIENT = "flint"; // bound to the account → the local route
const ANVIL_SEED = Buffer.alloc(32, 0x0a);
const THREAD = "5f0c8a52-3d1e-4b7a-9c2f-7e6d5c4b3a21"; // a valid envelope id
const TEXT = "hello from the channel";

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

// The one seam the tests replace (mail-verify.ts says so itself): the real
// promote() policy runs, the key comes from this process instead of Flair.
mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
  createMailVerifyClient: async () => ({
    async getAgent(name: string) {
      return name === SENDER ? { publicKey: pubkeyFromSeed(ANVIL_SEED) } : null;
    },
  }),
}));

const { promote } = await import("@tpsdev-ai/cli/utils/mail");
const pluginModule = (await import("../src/index.js")).default;
let capturedPlugin: any;
pluginModule.register({
  registerChannel: ({ plugin }: { plugin: any }) => {
    capturedPlugin = plugin;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

let root: string;
let mailDir: string;

const keysDir = () => join(root, "keys");
const newDir = () => join(mailDir, RECIPIENT, "new");
const newRecords = (): string[] => (existsSync(newDir()) ? readdirSync(newDir()).filter((f) => f.endsWith(".json")) : []);
const provisionKey = () => writeFileSync(join(keysDir(), `${SENDER}.key`), ANVIL_SEED);

function cfg(): any {
  return {
    channels: { "tps-mail": { accounts: { default: { mailDir, enabled: true } } } },
    bindings: [{ agentId: RECIPIENT, match: { channel: "tps-mail", accountId: "default" } }],
  };
}

async function send(replyToId?: string): Promise<any> {
  return await capturedPlugin.outbound.sendText({
    cfg: cfg(),
    accountId: "default",
    to: RECIPIENT,
    text: TEXT,
    identity: { agentId: SENDER },
    replyToId,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-sendtext-sign-"));
  mailDir = join(root, "mail");
  mkdirSync(mailDir, { recursive: true });
  mkdirSync(keysDir(), { recursive: true });
  // The signing path resolves the sender's key through this override; the
  // launcher gives it a throwaway dir, and these tests add the key (or not).
  process.env.TPS_TEST_KEYS_DIR = keysDir();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cli#433 B1: outbound.sendText signs through the ONE signing path", () => {
  it("(a) the signed envelope is what lands, threaded inside it; the recipient's promote() accepts it", async () => {
    provisionKey();
    const res = await send(THREAD);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.details.route, "a bound recipient is local").toBe("local");

    const files = newRecords();
    expect(files.length, "exactly one record").toBe(1);
    const record = JSON.parse(readFileSync(join(newDir(), files[0]!), "utf-8"));
    expect(record.replyToId, "no unsigned wrapper thread field").toBeUndefined();
    expect(record.body, "the raw text is not the body").not.toBe(TEXT);

    const env = JSON.parse(record.body) as Envelope;
    expect(env.from).toBe(SENDER);
    expect(env.to).toBe(RECIPIENT);
    expect(env.body).toBe(TEXT);
    expect(env.replyToId, "the thread rides INSIDE the signed envelope").toBe(THREAD);
    expect(
      await verifyEnvelope(env, {
        async getAgent(name: string) {
          return name === SENDER ? { publicKey: pubkeyFromSeed(ANVIL_SEED) } : null;
        },
      }),
    ).toEqual({ ok: true });

    // The recipient's own promote() (real policy, in-process keys) accepts it,
    // and presents the sender, the body and the thread from the envelope.
    const promoted = await promote(RECIPIENT, join(newDir(), files[0]!));
    expect(promoted.ok, JSON.stringify(promoted)).toBe(true);
    if (promoted.ok) {
      expect(promoted.message.from).toBe(SENDER);
      expect(promoted.message.body).toBe(TEXT);
      expect(promoted.message.envelopeId).toBe(env.messageId);
      expect(promoted.message.replyToId).toBe(THREAD);
    }
  });

  it("(b) no signing key: the path's named refusal, and nothing is written", async () => {
    const res = await send(THREAD);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('no Ed25519 private key for agent "anvil"');
    expect(String(res.error)).toContain("refusing to send an unsigned body");
    expect(newRecords(), "no record in the recipient's mailbox").toEqual([]);
    expect(existsSync(join(process.env.HOME ?? "", ".tps", "outbox", "new")), "no outbox record either").toBe(false);
  });
});
