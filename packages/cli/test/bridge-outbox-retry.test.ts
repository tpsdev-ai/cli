import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeCore } from "../src/bridge/core.js";
import type { BridgeAdapter, BridgeEnvelope } from "../src/bridge/adapter.js";
import { FlairClient } from "../src/utils/flair-client.js";
import * as mail from "../src/utils/mail.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

const BRIDGE = "test-bridge";
const SEED = Buffer.alloc(32, 0x42);
let root: string;
let tick: () => void;
let notify: (event: string, file: string) => void;
let stop: (() => void) | undefined;
let spies: Array<{ mockRestore(): void }>;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "bridge-outbox-retry-"));
  fs.mkdirSync(join(root, BRIDGE, "new"), { recursive: true });
  spies = [
    spyOn(fs, "watch").mockImplementation(((_path: unknown, listener: typeof notify) => {
      notify = listener;
      return { close() {} };
    }) as typeof fs.watch),
    spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      tick = callback;
      return 0;
    }) as typeof setInterval),
    spyOn(globalThis, "clearInterval").mockImplementation(() => {}),
    spyOn(FlairClient.prototype, "getAgentForVerification").mockImplementation(async (name: string) => (
      name === "kern" ? { id: name, name, publicKey: pubkeyFromSeed(SEED).toString("base64") } : null
    )),
  ];
});

afterEach(() => {
  stop?.();
  stop = undefined;
  for (const spy of spies.reverse()) spy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

function plant(file: string, body: string, trust?: string) {
  const envelope = buildSignedEnvelope("kern", BRIDGE, body, { kern: SEED }, { trust });
  const record = JSON.stringify({ id: file.replace(/\.json$/, ""), from: "kern", to: BRIDGE, body: JSON.stringify(envelope) });
  fs.writeFileSync(join(root, BRIDGE, "new", file), record);
  return record;
}

function start() {
  const sent: BridgeEnvelope[] = [];
  const logs: string[] = [];
  const adapter: BridgeAdapter = {
    name: "test",
    async start() {},
    async stop() {},
    async send(envelope) { sent.push(envelope); },
  };
  const core = new BridgeCore(adapter, { bridgeAgentId: BRIDGE, mailDir: root }, (line) => logs.push(line));
  stop = (core as unknown as { watchOutbox(): () => void }).watchOutbox();
  return { sent, logs };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function busyOnce() {
  const promote = mail.promote;
  const spy = spyOn(mail, "promote").mockImplementationOnce(async () => ({
    ok: false, class: "busy", reason: "mailbox lock busy; not delivered",
  })).mockImplementation(promote);
  spies.push(spy);
  return spy;
}

test("a busy startup record is forwarded on the next timer tick without restarting", async () => {
  plant("busy.json", "retry me");
  const promotion = busyOnce();
  const { sent } = start();
  await settle();
  expect(promotion).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
  expect(fs.existsSync(join(root, BRIDGE, "new", "busy.json"))).toBe(true);
  tick();
  await settle();
  expect(promotion).toHaveBeenCalledTimes(2);
  expect(sent.map((envelope) => envelope.content)).toEqual(["retry me"]);
});

test("many startup records and an overlapping timer produce no busy promotions", async () => {
  for (let index = 0; index < 24; index++) plant(`${index}.json`, `startup ${index}`);
  const { sent, logs } = start();
  tick();
  tick();
  for (let attempt = 0; attempt < 100 && sent.length < 24; attempt++) await settle();
  expect(logs.filter((line) => line.includes("(busy)"))).toEqual([]);
  expect(sent).toHaveLength(24);
  expect(new Set(sent.map((envelope) => envelope.content)).size).toBe(24);
  expect(fs.readdirSync(join(root, BRIDGE, "cur")).filter((file) => file.endsWith(".json"))).toEqual([]);
});

test("timer retries, watcher notifications and a replay never forward a record twice", async () => {
  const record = plant("once.json", "only once");
  busyOnce();
  const { sent } = start();
  await settle();
  tick();
  await settle();
  expect(sent.map((envelope) => envelope.content)).toEqual(["only once"]);
  fs.writeFileSync(join(root, BRIDGE, "new", "replay.json"), record);
  tick();
  tick();
  notify("rename", "replay.json");
  notify("change", "replay.json");
  notify("rename", "once.json");
  await settle();
  tick();
  await settle();
  expect(sent.map((envelope) => envelope.content)).toEqual(["only once"]);
  expect(fs.readdirSync(join(root, BRIDGE, "new"))).toEqual([]);
});

test("queued promotion caps a bridge principal from the configured mail root before send or ack", async () => {
  const { configureBridgeIdentity } = await import("@tpsdev-ai/agent");
  configureBridgeIdentity(root, "test", "kern");
  plant("capped.json", "external channel input", "internal");
  const { sent } = start();
  await settle();
  expect(sent).toEqual([]);
  const record = JSON.parse(fs.readFileSync(join(root, BRIDGE, "cur", "capped.json"), "utf8"));
  expect(record.trustTier).toBe("external");
  expect(record.ackedAt).toBeUndefined();
});

test("retryable redrive keeps the external tier before send or ack", async () => {
  const lookup = spyOn(FlairClient.prototype, "getAgentForVerification")
    .mockImplementationOnce(async () => { throw new Error("verifier outage"); })
    .mockImplementation(async (name: string) => (
      name === "kern" ? { id: name, name, publicKey: pubkeyFromSeed(SEED).toString("base64") } : null
    ));
  spies.push(lookup);
  plant("external-retry.json", "external", "external");
  const { sent } = start();
  await settle();
  expect(fs.existsSync(join(root, BRIDGE, "dlq", "external-retry.json"))).toBe(true);
  tick();
  await settle();
  expect(sent).toEqual([]);
  const record = JSON.parse(fs.readFileSync(join(root, BRIDGE, "cur", "external-retry.json"), "utf8"));
  expect(record.trustTier).toBe("external");
  expect(record.ackedAt).toBeUndefined();
});
