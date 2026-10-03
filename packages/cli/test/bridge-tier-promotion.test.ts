import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkMessages, getInbox, recoverPromoted, sendMessage } from "../src/utils/mail.js";
import { startFetchFlair } from "./helpers/fetch-flair.js";
import { buildSignedEnvelope } from "./helpers/stub-flair.js";

const seeds = { "custom-bridge": Buffer.alloc(32, 4), "openclaw-bridge": Buffer.alloc(32, 5), kern: Buffer.alloc(32, 6) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("--bridge-agent-id binds sender and receiver; defaults remain external; recovery recomputes the tier", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-configured-"));
  const saved = { ...process.env };
  const stub = startFetchFlair(seeds);
  let child: ReturnType<typeof spawn> | undefined;
  let childError = "";
  try {
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.FLAIR_KEY_PATH = join(root, "kern.key");
    process.env.FLAIR_URL = stub.url;
    delete process.env.TPS_BRIDGE_AGENT_ID;
    writeFileSync(process.env.FLAIR_KEY_PATH, seeds.kern);
    // The bridge signs the inbound as its own principal; give it a key.
    const bridgeKeys = join(root, "bridge-keys");
    mkdirSync(bridgeKeys, { recursive: true });
    writeFileSync(join(bridgeKeys, "custom-bridge.key"), seeds["custom-bridge"]);
    process.env.TPS_TEST_KEYS_DIR = bridgeKeys;
    const inbox = getInbox("kern");
    child = spawn(process.execPath, [resolve(import.meta.dir, "../bin/tps.ts"), "bridge", "start",
      "--adapter", "stdio", "--bridge-agent-id", "custom-bridge", "--default-agent", "kern", "--mail-dir", process.env.TPS_MAIL_DIR],
      { env: process.env, stdio: ["pipe", "ignore", "pipe"] });
    child.stderr!.on("data", (data) => { childError += String(data); });
    child.stdin!.write(JSON.stringify({ channel: "stdio", content: "inbound", senderId: "channel-user" }) + "\n");
    let file: string | undefined;
    for (let i = 0; i < 100 && !file; i++) { await sleep(10); file = readdirSync(inbox.fresh).find((f) => f.endsWith(".json")); }
    expect(file, childError).toBeDefined();
    const emitted = JSON.parse(readFileSync(join(inbox.fresh, file!), "utf8"));
    expect(emitted.from).toBe("custom-bridge");
    const signedInbound = JSON.parse(emitted.body);
    expect(signedInbound.from).toBe("custom-bridge");
    expect(signedInbound.trust).toBe("external");
    rmSync(join(inbox.fresh, file!));
    for (const from of [emitted.from, "openclaw-bridge"]) {
      for (const trust of [undefined, "internal", "external", "superuser"]) {
        const env = buildSignedEnvelope(from, "kern", "body", seeds, { trust });
        sendMessage("kern", JSON.stringify(env), from);
      }
    }
    const promoted = await checkMessages("kern");
    expect(promoted).toHaveLength(8);
    expect(promoted.every((msg) => msg.trustTier === "external")).toBe(true);
    const curFile = readdirSync(inbox.cur).find((f) => f.endsWith(".json"))!;
    const path = join(inbox.cur, curFile);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.trustTier = "internal";
    writeFileSync(path, JSON.stringify(record));
    const recovered = await recoverPromoted("kern", path);
    expect(recovered.ok && recovered.message.trustTier).toBe("external");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((r) => child!.once("close", r));
      child.kill("SIGTERM"); await closed;
    }
    stub.stop(); process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("bridge outbound dispatch and cur recovery refuse external mail before adapter send and ack", async () => {
  const { BridgeCore } = await import("../src/bridge/core.js");
  const { promote } = await import("../src/utils/mail.js");
  const root = mkdtempSync(join(tmpdir(), "bridge-outbound-"));
  const saved = { ...process.env };
  const outboundSeeds = { flint: Buffer.alloc(32, 7), "stdio-bridge": Buffer.alloc(32, 8) };
  const stub = startFetchFlair(outboundSeeds);
  let core: InstanceType<typeof BridgeCore> | undefined;
  try {
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.FLAIR_KEY_PATH = join(root, "key"); process.env.FLAIR_URL = stub.url;
    writeFileSync(process.env.FLAIR_KEY_PATH, outboundSeeds["stdio-bridge"]);
    const inbox = getInbox("stdio-bridge");
    for (const [id, trust] of [["recover-external", "external"], ["fresh-external", "external"], ["fresh-internal", "internal"]] as const) {
      const envelope = buildSignedEnvelope("flint", "stdio-bridge", id, outboundSeeds, { trust, messageId: id });
      const path = join(inbox.fresh, `${id}.json`);
      writeFileSync(path, JSON.stringify({ id, from: "flint", to: "stdio-bridge", body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false }));
      if (id === "recover-external") expect((await promote("stdio-bridge", path)).ok).toBe(true);
    }
    const delivered: string[] = [];
    core = new BridgeCore({ name: "stdio", start: async () => {}, stop: async () => {}, send: async (msg) => { delivered.push(msg.content); } },
      { mailDir: process.env.TPS_MAIL_DIR, defaultAgentId: "kern" }, () => {});
    await core.start();
    await sleep(200);
    expect(delivered).toEqual(["fresh-internal"]);
    expect(readdirSync(inbox.cur).filter((f) => f.endsWith(".json")).sort()).toEqual(["fresh-external.json", "recover-external.json"]);
  } finally {
    await core?.stop(); stub.stop(); process.env = saved; rmSync(root, { recursive: true, force: true });
  }
});
