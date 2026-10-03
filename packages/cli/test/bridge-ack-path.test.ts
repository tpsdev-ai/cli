import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeCore } from "../src/bridge/core.js";
import type { BridgeAdapter, BridgeEnvelope } from "../src/bridge/adapter.js";
import { FlairClient } from "../src/utils/flair-client.js";
import * as mail from "../src/utils/mail.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "./helpers/stub-flair.js";

const BRIDGE = "ack-bridge";
const seed = Buffer.alloc(32, 0x22);
let root: string;
let verifier: ReturnType<typeof spyOn>;
let stops: Array<() => void>;
let faults: Array<ReturnType<typeof spyOn>>;
const path = (dir: string, file = "record.json") => join(root, BRIDGE, dir, file);
const record = () => JSON.parse(fs.readFileSync(path("cur"), "utf8"));

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "bridge-ack-"));
  for (const dir of ["new", "cur", "tmp", "dlq"]) fs.mkdirSync(path(dir, ""), { recursive: true });
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockResolvedValue({
    id: "kern", name: "kern", publicKey: pubkeyFromSeed(seed).toString("base64"),
  });
  stops = [];
  faults = [];
});
afterEach(() => {
  for (const stop of stops) stop();
  for (const fault of faults) fault.mockRestore();
  verifier.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

function plant(file = "record.json", id = "wrapper-id") {
  const envelope = buildSignedEnvelope("kern", BRIDGE, file, { kern: seed });
  fs.writeFileSync(path("new", file), JSON.stringify({ id, from: "kern", to: BRIDGE, body: JSON.stringify(envelope) }));
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("bridge did not settle");
}
function start(onSend?: () => void) {
  const sent: BridgeEnvelope[] = [];
  const logs: string[] = [];
  const adapter: BridgeAdapter = {
    name: "test", async start() {}, async stop() {},
    async send(envelope) { sent.push(envelope); onSend?.(); },
  };
  const core = new BridgeCore(adapter, { bridgeAgentId: BRIDGE, mailDir: root }, (line) => logs.push(line));
  const stop = (core as unknown as { watchOutbox(): () => void }).watchOutbox();
  stops.push(stop);
  return { sent, logs, stop };
}
async function restartWithoutResend() {
  plant("zz-barrier.json", "barrier-id");
  expect((await mail.promote(BRIDGE, path("new", "zz-barrier.json"))).ok).toBe(true);
  const restarted = start();
  await waitFor(() => restarted.sent.some((envelope) => envelope.content === "zz-barrier.json"));
  expect(restarted.sent.map((envelope) => envelope.content)).toEqual(["zz-barrier.json"]);
  restarted.stop();
}

for (const [name, queued] of [
  ["id-less", JSON.stringify({ from: "kern", body: "queued" })],
  ["corrupt", "{"],
  ["same-id", JSON.stringify({ id: "wrapper-id", from: "kern", body: "queued" })],
]) {
  test(`a queued ${name} record does not interfere with acknowledgement`, async () => {
    plant();
    const running = start(() => {
      fs.writeFileSync(path("new", "pending.json"), queued!);
      running.stop();
    });
    await waitFor(() => running.logs.length > 0);
    expect(running.sent).toHaveLength(1);
    expect(fs.readFileSync(path("new", "pending.json"), "utf8")).toBe(queued!);
    expect(fs.existsSync(path("cur"))).toBe(false);
    expect(running.logs.some((line) => line.includes("Delivery failed"))).toBe(false);
  });
}

test("an invalid wrapper id does not interfere with acknowledgement", async () => {
  plant("record.json", "invalid/id");
  const running = start();
  await waitFor(() => running.logs.length > 0);
  expect(running.sent).toHaveLength(1);
  expect(fs.existsSync(path("cur"))).toBe(false);
});

test("a partial acknowledgement write failure preserves the sent record on restart", async () => {
  plant();
  const write = fs.writeFileSync;
  const running = start(() => {
    running.stop();
    faults.push(spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof write>) => {
      if (JSON.parse(String(args[1])).ackedAt) {
        write(args[0], String(args[1]).slice(0, -1), "utf8");
        throw new Error("partial ack write fault");
      }
      return write(...args);
    }));
  });
  await waitFor(() => running.logs.some((line) => line.includes("fault")));
  expect(running.sent).toHaveLength(1);
  expect(record().bridgeSentAt).toEqual(expect.any(String));
  expect(record().ackedAt).toBeUndefined();
  expect(fs.readdirSync(path("cur", ""))).toEqual(["record.json"]);
  for (const fault of faults.splice(0)) fault.mockRestore();
  await restartWithoutResend();
  expect(running.logs.some((line) => line.includes("ack failed"))).toBe(true);
  expect(running.logs.some((line) => line.includes("Delivery failed"))).toBe(false);
});

test("a cleanup failure leaves an acknowledged record that is not resent (cli#487)", async () => {
  plant();
  const unlink = fs.unlinkSync;
  const running = start(() => {
    running.stop();
    faults.push(spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === path("cur")) throw new Error("cleanup fault");
      return unlink(file);
    }));
  });
  await waitFor(() => running.logs.length > 0);
  expect(record().bridgeSentAt).toEqual(expect.any(String));
  expect(record().read).toBe(true);
  expect(record().ackedAt).toEqual(expect.any(String));
  for (const fault of faults.splice(0)) fault.mockRestore();
  await restartWithoutResend();
});

test("a reported send failure can be retried on restart", async () => {
  plant();
  const running = start(() => { running.stop(); throw new Error("send fault"); });
  await waitFor(() => running.logs.some((line) => line.includes("Delivery failed")));
  expect(record().bridgeSentAt).toBeUndefined();
  const restarted = start();
  await waitFor(() => !fs.existsSync(path("cur")));
  expect(restarted.sent).toHaveLength(1);
});

test("pending wrapper lifecycle fields cannot suppress first delivery", async () => {
  plant();
  const pending = JSON.parse(fs.readFileSync(path("new"), "utf8"));
  pending.read = true;
  pending.ackedAt = "forged";
  pending.bridgeSendStartedAt = "forged";
  pending.bridgeSentAt = "forged";
  fs.writeFileSync(path("new"), JSON.stringify(pending));
  const running = start();
  await waitFor(() => !fs.existsSync(path("cur")) && running.sent.length === 1);
  expect(running.sent).toHaveLength(1);
});

test("acknowledgement by path does not create a missing record", () => {
  const missing = path("cur", "missing.json");
  expect(typeof mail.ackMessageAtPath).toBe("function");
  expect(() => mail.ackMessageAtPath(missing)).toThrow();
  expect(fs.existsSync(missing)).toBe(false);
});

test("acknowledgement does not recreate a file removed after its read", () => {
  const target = path("cur");
  fs.writeFileSync(target, JSON.stringify({ id: "wrapper-id", read: false }));
  const read = fs.readFileSync;
  faults.push(spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
    const data = read(...args);
    if (args[0] === target) fs.unlinkSync(target);
    return data;
  }));
  expect(() => mail.ackMessageAtPath(target)).toThrow();
  expect(fs.existsSync(target)).toBe(false);
});

test("a sent-marker write failure after successful send allows a duplicate on restart", async () => {
  plant();
  const write = fs.writeFileSync;
  const fault = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof write>) => {
    if (String(args[1]).includes('"bridgeSentAt"')) throw new Error("marker write fault");
    return write(...args);
  });
  faults.push(fault);
  const running = start();
  await waitFor(() => running.logs.some((line) => line.includes("marker write fault")));
  running.stop();
  expect(running.sent).toHaveLength(1);
  expect(record().bridgeSentAt).toBeUndefined();
  fault.mockRestore();
  const restarted = start();
  await waitFor(() => !fs.existsSync(path("cur")));
  expect(restarted.sent).toHaveLength(1);
});


test("a crash after a legacy start marker but before send delivers on restart", async () => {
  plant();
  expect((await mail.promote(BRIDGE, path("new"))).ok).toBe(true);
  const unsent = record();
  unsent.bridgeSendStartedAt = new Date().toISOString();
  fs.writeFileSync(path("cur"), JSON.stringify(unsent));
  const restarted = start();
  await waitFor(() => !fs.existsSync(path("cur")));
  expect(restarted.sent.map((envelope) => envelope.content)).toEqual(["record.json"]);
});

test("the persisted sent marker is absent until adapter send succeeds", async () => {
  plant();
  let duringSend: Record<string, unknown> | undefined;
  const running = start(() => { duringSend = record(); });
  await waitFor(() => !fs.existsSync(path("cur")) && running.sent.length === 1);
  expect(duringSend).toBeDefined();
  expect(duringSend!.bridgeSendStartedAt).toBeUndefined();
  expect(duringSend!.bridgeSentAt).toBeUndefined();
});

for (const operation of ["openSync", "fsyncSync", "closeSync", "renameSync", "statSync"] as const) {
  test(`an ack ${operation} failure leaves the original sent record intact`, () => {
    const target = path("cur");
    const original = JSON.stringify({ id: "wrapper-id", read: false, bridgeSentAt: "sent" });
    fs.writeFileSync(target, original);
    const originalOperation = fs[operation] as (...args: any[]) => any;
    let injected = false;
    const fault = spyOn(fs, operation).mockImplementation(((...args: any[]) => {
      const ackOperation = operation === "fsyncSync" || operation === "closeSync"
        || (operation === "statSync" ? args[0] === target : String(args[0]).includes(".ack-"));
      if (ackOperation && !injected) {
        injected = true;
        throw new Error(`${operation} fault`);
      }
      return originalOperation(...args);
    }) as any);
    faults.push(fault);
    expect(() => mail.ackMessageAtPath(target)).toThrow(`${operation} fault`);
    expect(injected).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).bridgeSentAt).toBe("sent");
    expect(fs.readdirSync(path("cur", ""))).toEqual(["record.json"]);
  });
}

test("ack holds the shared mail lock while checking for the existing record", () => {
  const target = path("cur");
  fs.writeFileSync(target, JSON.stringify({ id: "wrapper-id", read: false, bridgeSentAt: "sent" }));
  const stat = fs.statSync;
  let checked = false;
  faults.push(spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof stat>) => {
    if (args[0] === target) {
      checked = true;
      expect(fs.existsSync(path(".mail-lock", "owner.json"))).toBe(true);
      fs.unlinkSync(target);
    }
    return stat(...args);
  }) as typeof stat));
  expect(() => mail.ackMessageAtPath(target)).toThrow();
  expect(checked).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readdirSync(path("cur", ""))).toEqual([]);
});
