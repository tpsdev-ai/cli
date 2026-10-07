/**
 * cli#524: `office connect` announces a relayed message after the local
 * acceptance path (#532) has published its inbox record. These cases drive
 * `connectAndKeepAlive` — the acceptance path `office connect` wires its
 * announcement to — against REAL inbox files under a mkdtemp root.
 *
 * The announcement is observed through the `onAccepted` callback `office
 * connect` now passes; this PR leaves `onMessage` unchanged.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import { getInbox } from "../src/utils/mail.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, type MailDeliverBody } from "../src/utils/wire-mail.js";
import type { TransportChannel, TpsMessage } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

describe("office connect announcement follows local acceptance", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let stop: (() => Promise<void>) | undefined;
  let handlers: Set<(msg: TpsMessage) => void>;
  let acks: TpsMessage[];
  /** The inbox record count observed each time an accepted delivery is announced. */
  let announced: number[];

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), "tps-connect-announce-"));
    savedEnv = {};
    for (const k of ["HOME", "TPS_ROOT", "TPS_MAIL_DIR", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON"]) savedEnv[k] = process.env[k];
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_BRANCH_NO_DAEMON = "1";
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "connect-announce-test";
    await initHostIdentity();
    const kp = generateKeyPair();
    registerBranch("remote", kp.signing.publicKey, undefined, kp.encryption.publicKey);
    const branchDir = join(root, ".tps", "branch-office", "remote");
    fs.mkdirSync(branchDir, { recursive: true });
    fs.writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));

    handlers = new Set();
    acks = [];
    announced = [];
    let alive = true;
    const channel: TransportChannel = {
      async send(msg) { if (msg.type === MSG_MAIL_ACK) acks.push(msg); },
      onMessage(handler) { handlers.add(handler); },
      offMessage(handler) { handlers.delete(handler); },
      async close() { alive = false; },
      isAlive() { return alive; },
      peerFingerprint() { return "remote"; },
    };
    spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
    stop = await connectAndKeepAlive("remote", {
      onAccepted: () => announced.push(jsonFiles(getInbox("local").fresh).length),
    });
    for (let i = 0; handlers.size === 0 && i < 200; i++) await Bun.sleep(5);
    expect(handlers.size).toBeGreaterThan(0);
  });

  afterEach(async () => {
    if (stop) await stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function jsonFiles(dir: string): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  function body(content: string): MailDeliverBody {
    return { id: randomUUID(), from: "remote", to: "local", content, timestamp: new Date().toISOString() };
  }

  function deliver(delivery: MailDeliverBody): void {
    const msg: TpsMessage = { type: MSG_MAIL_DELIVER, seq: 1, ts: new Date().toISOString(), body: delivery };
    for (const handler of handlers) handler(msg);
  }

  /** Wait (bounded) for the in-flight acceptance's ACK to settle. */
  async function settled(): Promise<void> {
    for (let i = 0; i < 200 && acks.length === 0; i++) await Bun.sleep(5);
  }

  test("an accepted delivery is announced after its inbox record is published", async () => {
    deliver(body("hello"));
    await settled();
    expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
    expect(announced).toEqual([1]);
  });

  test("a same-id conflict is not acknowledged and is not announced", async () => {
    const accepted = body("original payload");
    deliver(accepted);
    await settled();
    expect(announced).toEqual([1]);
    acks.length = 0;

    deliver({ ...accepted, content: "changed payload" });
    await Bun.sleep(50);

    expect(acks).toEqual([]);
    expect(jsonFiles(getInbox("local").fresh).length).toBe(1);
    expect(announced).toEqual([1]);
  });

  test("a delivery whose inbox write fails is quarantined and is not announced", async () => {
    const inbox = getInbox("local");
    const write = fs.writeFileSync;
    let failed = false;
    const fault = spyOn(fs, "writeFileSync").mockImplementation((path, data, opts) => {
      if (!failed && String(path).startsWith(inbox.tmp)) {
        failed = true;
        throw new Error("injected transient inbox write failure");
      }
      return write(path, data, opts);
    });
    try {
      deliver(body("write fault"));
      await settled();
    } finally {
      fault.mockRestore();
    }
    expect(failed).toBe(true);
    expect(acks.length).toBe(1);
    expect(jsonFiles(inbox.fresh)).toEqual([]);
    expect(jsonFiles(inbox.dlq).length).toBe(1);
    expect(announced).toEqual([]);
  });
});
