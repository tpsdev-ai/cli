/**
 * bridge-signs-external.test.ts — cli#433 slice B2-2.
 *
 * The channel bridge signs every inbound channel message as ITS OWN identity
 * (the bridgeAgentId and its own key, never the host agent's) through the same
 * signing path the other producers use. This suite exercises the REAL producer:
 * `BridgeCore.handleInbound` writes into a recipient's `new/` and the recipient's
 * real `checkMessages()` promotes it.
 *
 * Covered here: no bridge key → no write; the bridge identity is the signed
 * sender; the channel author is present only as signed data; a tampered tier
 * fails verification. The bridge-principal-signing-`internal` refusal at
 * promotion is B2-1's (bridge-tier-promotion / mail-trust-ceiling); it is reused,
 * not duplicated. The consumer gate is exercised end to end on the message this
 * producer emits.
 */
import { startFetchFlair } from "./helpers/fetch-flair.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeCore } from "../src/bridge/core.js";
import type { BridgeAdapter, BridgeEnvelope } from "../src/bridge/adapter.js";
import { checkMessages, verifyRecordForMailbox } from "../src/utils/mail.js";
import { externalDispatchRefusal } from "../src/utils/mail-tier.js";
import { claudeCodeDispatchRefusal } from "../src/utils/claude-code-runtime.js";

const BRIDGE_ID = "openclaw-bridge"; // a default bridge principal name
const KERN_SEED = Buffer.alloc(32, 0x61);
const BRIDGE_SEED = Buffer.alloc(32, 0x62);
const SEEDS = { kern: KERN_SEED, [BRIDGE_ID]: BRIDGE_SEED };

const noopAdapter: BridgeAdapter = {
  name: "openclaw",
  async start() {},
  async send() {},
  async stop() {},
};

function jsonFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

describe("channel bridge signs as its own identity (cli#433 slice B2-2)", () => {
  let root: string;
  let mailDir: string;
  let keysDir: string;
  let emptyKeys: string;
  let stub: ReturnType<typeof startFetchFlair>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bridge-signs-external-"));
    mailDir = join(root, "mail");
    keysDir = join(root, "keys");
    emptyKeys = join(root, "no-keys");
    mkdirSync(keysDir, { recursive: true });
    mkdirSync(emptyKeys, { recursive: true });
    // The bridge principal's own key, and the recipient's key for the verify
    // client's request auth.
    writeFileSync(join(keysDir, `${BRIDGE_ID}.key`), BRIDGE_SEED);
    writeFileSync(join(keysDir, "kern.key"), KERN_SEED);

    stub = startFetchFlair(SEEDS);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_BRIDGE_AGENT_ID"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = mailDir;
    process.env.TPS_TEST_KEYS_DIR = keysDir;
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, "kern.key");
    delete process.env.TPS_BRIDGE_AGENT_ID;
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function core() {
    return new BridgeCore(noopAdapter, { bridgeAgentId: BRIDGE_ID, defaultAgentId: "kern", mailDir }, () => {});
  }

  function inbound(overrides: Partial<BridgeEnvelope> = {}): BridgeEnvelope {
    return {
      channel: "discord",
      channelId: "123",
      senderId: "456",
      senderName: "Anvil",
      content: "hey",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  function emit(envelope: BridgeEnvelope = inbound()): { record: any; file: string } {
    const c = core();
    const deliveredTo = (c as any).handleInbound(envelope) as string;
    expect(deliveredTo).toBe("kern");
    const newDir = join(mailDir, "kern", "new");
    const files = jsonFiles(newDir);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    return { record: JSON.parse(readFileSync(join(newDir, file), "utf8")), file };
  }

  test("no bridge key refuses with the named missing-key error and writes nothing", () => {
    process.env.TPS_TEST_KEYS_DIR = emptyKeys;
    const c = core();
    let thrown: Error | null = null;
    try {
      (c as any).handleInbound(inbound());
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain(`no Ed25519 private key for agent "${BRIDGE_ID}"`);
    expect(jsonFiles(join(mailDir, "kern", "new"))).toHaveLength(0);
  });

  test("the bridge identity is the signed sender and the recipient promotes it", async () => {
    const { record } = emit();
    expect(record.from).toBe(BRIDGE_ID);
    const envelope = JSON.parse(record.body);
    expect(envelope.from).toBe(BRIDGE_ID);
    expect(envelope.trust).toBe("external");

    const messages = await checkMessages("kern");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.from).toBe(BRIDGE_ID);
    expect(messages[0]!.trustTier).toBe("external");
  });

  test("the channel author is present only as signed data, never as a wrapper field", () => {
    const { record } = emit(inbound({ senderId: "284437008405757953", channelId: "999" }));
    // The wrapper carries no unsigned author/channel claim (the old X-TPS-Sender
    // / X-TPS-Channel headers are gone).
    expect(record.headers?.["X-TPS-Sender"]).toBeUndefined();
    expect(record.headers?.["X-TPS-Channel"]).toBeUndefined();
    // The author and channel are inside the SIGNED body.
    const envelope = JSON.parse(record.body);
    const inner = JSON.parse(envelope.body);
    expect(inner.senderId).toBe("284437008405757953");
    expect(inner.channelId).toBe("999");
    expect(inner.channel).toBe("discord");
  });

  test("a tampered tier fails verification", async () => {
    const { record, file } = emit();
    // The untampered envelope verifies, so the refusal below is the tamper: the
    // tier lives INSIDE the signed payload, not beside it.
    expect((await verifyRecordForMailbox("kern", record, mailDir)).ok).toBe(true);
    const envelope = JSON.parse(record.body);
    envelope.trust = "internal"; // flip the signed tier
    record.body = JSON.stringify(envelope);
    const newDir = join(mailDir, "kern", "new");
    writeFileSync(join(newDir, file), JSON.stringify(record));

    const messages = await checkMessages("kern");
    expect(messages).toHaveLength(0);
    const dlq = join(mailDir, "kern", "dlq");
    expect(jsonFiles(dlq)).toHaveLength(1);
    const reason = readFileSync(join(dlq, `${file}.reason`), "utf8");
    expect(reason).toContain("class: invalid");
    expect(reason).toContain("signature verification failed");
  });

  test("a consumer applies the external capability set to bridge mail end to end", async () => {
    emit();
    const messages = await checkMessages("kern");
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.trustTier).toBe("external");
    expect(externalDispatchRefusal(msg.envelope, msg.from)).not.toBeNull();
    expect(claudeCodeDispatchRefusal(msg.envelope, msg.from)).toContain("external-tier");
  });
});
