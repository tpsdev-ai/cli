/** Real loop/mailbox tests for settlement retries and verifiable committed recovery. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { type DeliverNextResult, type MailDelivery, MailClient } from "../src/io/mail.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { MemoryStore } from "../src/io/memory.js";
import { ProviderManager } from "../src/llm/provider.js";
import { FlairContextProvider } from "../src/io/flair.js";
import { EventLoop, type MailDeliverySource } from "../src/runtime/event-loop.js";
import { DELIVERY_PRESENTATION_TTL_MS, mailboxReplayStore } from "../src/lib/mailbox-policy.js";
import { signEnvelope, type FlairClient } from "../src/lib/signEnvelope.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const SEED = Buffer.alloc(32, 0x61);
const CHILD = fileURLToPath(new URL("./helpers/event-loop-child.mjs", import.meta.url));

let mailDir: string;
let root: string;
let workspace: string;

const cur = (file: string) => join(root, "cur", file);
const fresh = (file: string) => join(root, "new", file);
const intentPath = (file: string) => join(root, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);
const intentPhase = (file: string) => mailboxReplayStore(root).placementPhase(file);
const intentJson = (file: string) => JSON.parse(readFileSync(intentPath(file), "utf8"));
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []);
const newFiles = () => jsonFiles(join(root, "new"));
const curFiles = () => jsonFiles(join(root, "cur"));
const delivered = (result: DeliverNextResult): MailDelivery => {
  if (result.status !== "delivered") throw new Error(`expected a delivery, got ${JSON.stringify(result)}`);
  return result.delivery;
};

/** How many consumed-ledger lines carry `id`. */
function ledgerIds(id: string): number {
  const path = join(root, "consumed.jsonl");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line && JSON.parse(line).id === id).length;
}

function verifier(): FlairClient {
  return { async getAgent(name: string) { return name === FROM ? { publicKey: Buffer.from(ed.getPublicKey(SEED)) } : null; } };
}
const client = () => new MailClient(mailDir, undefined, AGENT, verifier());

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "mail-loop-delivery-"));
  root = join(mailDir, AGENT);
  workspace = join(mailDir, "ws");
  mkdirSync(join(root, "new"), { recursive: true });
  mkdirSync(join(root, "cur"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

/** Write one signed record to `path`. */
function signedRecord(path: string, messageId: string, body = "loop-body"): void {
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope(
    {
      v: 1, from: FROM, to: AGENT, body, messageId, timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: FROM, kind: "agent", timestamp, rationale: "sends", signature: null },
      ],
    },
    { [FROM]: SEED },
  );
  writeFileSync(path, JSON.stringify({ from: FROM, body: JSON.stringify(envelope) }));
}

const plant = (file: string, messageId: string, body = "loop-body") => signedRecord(fresh(file), messageId, body);

interface Seen { id: string; presentation: number; }

/**
 * Run the real EventLoop against `c` and record every delivery. The loop runs
 * until `stopAfter` deliveries have been handed over, or a delivery names
 * `stopOnId`, whichever comes first.
 */
async function runLoop(
  c: MailClient,
  opts: { provider: { complete: (req: unknown) => Promise<unknown> }; maxToolTurns?: number; stopAfter?: number; stopOnId?: string },
): Promise<Seen[]> {
  const seen: Seen[] = [];
  const config = {
    agentId: AGENT, name: "loop-test", mailDir, memoryPath: join(workspace, "mem.jsonl"), workspace,
    llm: { provider: "test", model: "test-model" }, contextWindowTokens: 8000,
    maxToolTurns: opts.maxToolTurns ?? 50,
  };
  const loop = new EventLoop({
    config: config as never,
    memory: { append: async () => {} } as never,
    context: {} as never,
    provider: opts.provider as never,
    tools: { list: () => [], execute: async () => ({ content: "ok" }) } as never,
  }, 1);
  const stopAfter = opts.stopAfter ?? Number.POSITIVE_INFINITY;
  let handovers = 0;
  const source: MailDeliverySource = {
    async deliverNext() {
      const result = await c.deliverNext();
      if (result.status === "delivered") {
        const id = result.delivery.message.verifiedEnvelope?.messageId ?? "?";
        seen.push({ id, presentation: result.delivery.presentation });
        if (++handovers >= stopAfter || id === opts.stopOnId) void loop.stop();
      }
      return result;
    },
    completeDelivery: (delivery) => c.completeDelivery(delivery),
    releaseDelivery: (delivery) => c.releaseDelivery(delivery),
  };
  await loop.runDeliveries(source);
  return seen;
}

/** A provider whose handler returns a normal completion. */
const completingProvider = { async complete() { return { content: "done", toolCalls: undefined, inputTokens: 1, outputTokens: 1 }; } };
/** A provider whose handler always calls a tool, so the turn limit is reached. */
const toolCallingProvider = { async complete() { return { content: "", toolCalls: [{ id: "t1", name: "noop", input: {} }], inputTokens: 1, outputTokens: 1 }; } };
/** Calls tools for a body containing `poison-body`. */
const poisonAwareProvider = {
  async complete(req: unknown) {
    const text = JSON.stringify((req as { messages?: unknown }).messages ?? "");
    return text.includes("poison-body")
      ? { content: "", toolCalls: [{ id: "t1", name: "noop", input: {} }], inputTokens: 1, outputTokens: 1 }
      : { content: "done", toolCalls: undefined, inputTokens: 1, outputTokens: 1 };
  },
};

interface KillRun { signal: NodeJS.Signals | null; reached: boolean; stderr: string; }

/** Run the loop in a child; SIGKILL it once its handler writes the marker. */
function runChildAndKill(timeoutMs = 30_000): Promise<KillRun> {
  const marker = join(mailDir, "child-in-handler");
  const child = spawn(process.execPath, [CHILD, mailDir, AGENT], {
    env: {
      HOME: mailDir,
      PATH: process.env.PATH,
      TPS_FROM: FROM,
      TPS_SEED: SEED.toString("base64"),
      TPS_MARKER: marker,
      TPS_WORKSPACE: workspace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<KillRun>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const poll = setInterval(() => {
      if (!existsSync(marker)) return;
      clearInterval(poll);
      child.kill("SIGKILL");
    }, 15);
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(deadline);
      child.kill("SIGKILL");
      reject(new Error(`child never reached the handler (stderr: ${stderr})`));
    }, timeoutMs);
    child.once("error", (e) => { if (!settled) { settled = true; clearInterval(poll); clearTimeout(deadline); reject(e); } });
    child.once("exit", (_code, signal) => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(deadline);
      resolve({ signal, reached: existsSync(marker), stderr });
    });
  });
}

describe("a committed delivery killed mid-handler is re-presented when verification succeeds", () => {
  test("first delivery, killed while in_progress: re-presented once, later mail handled", async () => {
    plant("m1.json", "kill-first");
    plant("m2.json", "later");

    const run = await runChildAndKill();
    expect(run.reached, `child never reached the handler; stderr=${run.stderr}`).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(newFiles()).toEqual(["m2.json"]);
    expect(curFiles()).toEqual(["m1.json"]);

    const seen = await runLoop(client(), { provider: completingProvider, stopAfter: 2 });
    expect(seen).toEqual([{ id: "kill-first", presentation: 2 }, { id: "later", presentation: 1 }]);
    expect(newFiles()).toEqual([]);
    expect(intentPhase("m1.json")).toBeNull();
    expect(intentPhase("m2.json")).toBeNull();
  });

  test("recovery, killed while in_progress: re-presented once, later mail handled", async () => {
    plant("m1.json", "kill-recovered");
    linkSync(fresh("m1.json"), cur("m1.json"));
    unlinkSync(fresh("m1.json"));
    mailboxReplayStore(root).beginPlacement("kill-recovered", "m1.json", cur("m1.json"));
    plant("m2.json", "later");

    const run = await runChildAndKill();
    expect(run.reached, `child never reached the handler; stderr=${run.stderr}`).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(newFiles()).toEqual(["m2.json"]);

    const seen = await runLoop(client(), { provider: completingProvider, stopAfter: 2 });
    expect(seen).toEqual([{ id: "kill-recovered", presentation: 2 }, { id: "later", presentation: 1 }]);
    expect(newFiles()).toEqual([]);
    expect(intentPhase("m1.json")).toBeNull();
  });
});

describe("a stop finalizes a returned delivery when completion succeeds", () => {
  test("durably finalized mail is not re-presented; later mail is handled next", async () => {
    plant("m1.json", "first");
    plant("m2.json", "second");
    plant("m3.json", "third");

    const first = await runLoop(client(), { provider: completingProvider, stopAfter: 1 });
    expect(first).toEqual([{ id: "first", presentation: 1 }]);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);
    expect(curFiles()).toEqual(["m1.json"]);
    expect(intentPhase("m1.json")).toBeNull();

    const next = await runLoop(client(), { provider: completingProvider, stopAfter: 2 });
    expect(next).toEqual([{ id: "second", presentation: 1 }, { id: "third", presentation: 1 }]);
    expect(newFiles()).toEqual([]);
    expect(intentPhase("m1.json")).toBeNull();
  });
});

describe("a turn-limit return is not completion", () => {
  test("the intent stays in_progress and the message is re-presented on the next check", async () => {
    plant("m1.json", "turn-limited");

    const first = await runLoop(client(), { provider: toolCallingProvider, maxToolTurns: 0, stopAfter: 1 });
    expect(first).toEqual([{ id: "turn-limited", presentation: 1 }]);
    const intent = intentJson("m1.json");
    expect(intent.phase).toBe("in_progress");
    expect(intent.claim).toBeUndefined();
    expect(curFiles()).toEqual(["m1.json"]);

    const again = await runLoop(client(), { provider: toolCallingProvider, maxToolTurns: 0, stopAfter: 1 });
    expect(again).toEqual([{ id: "turn-limited", presentation: 2 }]);
    expect(intentJson("m1.json").phase).toBe("in_progress");
  });
});

describe("the liveness bound quarantines repeated non-completion", () => {
  test("five presentations then the intent is failed with its log line, and other mail keeps flowing", async () => {
    plant("m1.json", "poison", "poison-body");
    plant("m2.json", "healthy", "healthy-body");

    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    let seen: Seen[] = [];
    try {
      seen = await runLoop(client(), { provider: poisonAwareProvider, maxToolTurns: 0, stopOnId: "healthy" });
    } finally {
      warn.mockRestore();
    }

    expect(seen.filter((d) => d.id === "poison").map((d) => d.presentation)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.filter((d) => d.id === "healthy")).toEqual([{ id: "healthy", presentation: 1 }]);
    expect(intentPhase("m1.json")).toBe("failed");
    expect(warnings.some((w) => w.includes("poison") && w.includes("presentation bound"))).toBe(true);
    expect(intentPhase("m2.json")).toBeNull();
  });
});

describe("a re-presented message is never committed twice", () => {
  test("a non-completion then a re-presentation leaves one cur/ record and one consumed ID", async () => {
    plant("m1.json", "once-only");
    await runLoop(client(), { provider: toolCallingProvider, maxToolTurns: 0, stopAfter: 1 });

    expect(curFiles()).toEqual(["m1.json"]);
    expect(newFiles()).toEqual([]);
    expect(ledgerIds("once-only")).toBe(1);
    const identity = intentJson("m1.json").identity;
    const bytes = readFileSync(cur("m1.json"));

    const c = client();
    const m = delivered(await c.deliverNext());
    expect(m.presentation).toBe(2);
    expect(curFiles()).toEqual(["m1.json"]);
    expect(newFiles()).toEqual([]);
    expect(ledgerIds("once-only")).toBe(1);
    expect(intentJson("m1.json").identity).toEqual(identity);
    expect(readFileSync(cur("m1.json")).equals(bytes)).toBe(true);
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
  });
});

for (const operation of ["completeDelivery", "releaseDelivery"] as const) {
  test(`${operation} retries the same deferred delivery before later mail`, async () => {
    plant("m1.json", "retry", "poison-body");
    plant("m2.json", "later", "healthy-body");
    const c = client();
    const original = c[operation].bind(c);
    let attempts = 0;
    let held: MailDelivery | undefined;
    const next = c.deliverNext.bind(c);
    const nextSpy = spyOn(c, "deliverNext").mockImplementation(async () => {
      expect(held).toBeUndefined();
      return next();
    });
    const claimDir = join(root, ".mail-lock.claim");
    const savedMailbox = `${root}.saved`;
    const provider = {
      async complete(req: unknown) {
        if (attempts === 0) {
          if (operation === "completeDelivery") mkdirSync(claimDir);
          else {
            renameSync(root, savedMailbox);
            writeFileSync(root, "not a directory");
          }
        }
        return poisonAwareProvider.complete(req);
      },
    };
    const observe = (delivery: MailDelivery, result: { status: string; reason?: string }) => {
      if (delivery.message.verifiedEnvelope?.messageId !== "retry" || attempts >= 2) return;
      attempts++;
      if (attempts === 1) {
        expect(result).toMatchObject({ status: "deferred", reason: operation === "completeDelivery" ? "lock-busy" : "storage-error" });
        held = delivery;
        if (operation === "completeDelivery") rmSync(claimDir, { recursive: true });
        else {
          rmSync(root);
          renameSync(savedMailbox, root);
        }
        expect(intentJson("m1.json").claim).toBeDefined();
      } else {
        expect(delivery).toBe(held);
        expect(result.status).toBe(operation === "completeDelivery" ? "completed" : "released");
        held = undefined;
      }
    };
    const settlementSpy = operation === "completeDelivery"
      ? spyOn(c, "completeDelivery").mockImplementation(async (delivery) => {
          const result = await (original as MailClient["completeDelivery"])(delivery);
          observe(delivery, result);
          return result;
        })
      : spyOn(c, "releaseDelivery").mockImplementation((delivery) => {
          const result = (original as MailClient["releaseDelivery"])(delivery);
          observe(delivery, result);
          return result;
        });
    try {
      const seen = await runLoop(c, {
        provider: operation === "completeDelivery" ? {
          async complete(req) { await provider.complete(req); return completingProvider.complete(); },
        } : provider,
        maxToolTurns: 0, stopOnId: "later",
      });
      expect(attempts).toBe(2);
      expect(seen.at(-1)).toEqual({ id: "later", presentation: 1 });
      expect(intentPhase("m2.json")).toBeNull();
      expect(held).toBeUndefined();
    } finally {
      settlementSpy.mockRestore();
      nextSpy.mockRestore();
    }
  }, 15_000);

  test(`${operation} quarantines an overdue deferred claim once the mailbox lock and storage are available`, async () => {
    plant("m1.json", "overdue");
    plant("m2.json", "later");
    const c = client();
    const claimDir = join(root, ".mail-lock.claim");
    let attempts = 0;
    const original = c[operation].bind(c);
    const expire = () => {
      attempts++;
      if (attempts !== 1) return;
      const intent = intentJson("m1.json");
      intent.firstPresentedAt = new Date(Date.now() - DELIVERY_PRESENTATION_TTL_MS - 1_000).toISOString();
      writeFileSync(intentPath("m1.json"), JSON.stringify(intent));
      mkdirSync(claimDir);
    };
    const observe = (result: { status: string }) => {
      if (attempts === 1) {
        expect(result.status).toBe("deferred");
        rmSync(claimDir, { recursive: true });
      } else if (attempts === 2) expect(result.status).toBe("quarantined");
    };
    const settlementSpy = operation === "completeDelivery"
      ? spyOn(c, "completeDelivery").mockImplementation(async (delivery) => {
          expire();
          const result = await (original as MailClient["completeDelivery"])(delivery);
          observe(result); return result;
        })
      : spyOn(c, "releaseDelivery").mockImplementation((delivery) => {
          expire();
          const result = (original as MailClient["releaseDelivery"])(delivery);
          observe(result); return result;
        });
    try {
      const seen = await runLoop(c, {
        provider: operation === "completeDelivery" ? completingProvider : toolCallingProvider,
        maxToolTurns: 0, stopOnId: "later",
      });
      expect(seen).toEqual([{ id: "overdue", presentation: 1 }, { id: "later", presentation: 1 }]);
      expect(intentPhase("m1.json")).toBe("failed");
      expect(intentJson("m1.json").claim).toBeUndefined();
      expect(existsSync(cur("m1.json"))).toBe(true);
    } finally { settlementSpy.mockRestore(); }
  }, 15_000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const refusal of ["identity", "stale"] as const) {
    test(`AgentRuntime.start logs ${refusal} refusal and keeps the intent pending after ${signal}`, async () => {
      plant("m1.json", `${refusal}-refusal`);
      plant("m2.json", "later");
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let finish!: () => void;
      const finishing = new Promise<void>((resolve) => { finish = resolve; });
      const lookup = spyOn(FlairContextProvider.prototype, "getAgent").mockImplementation(async () => ({ publicKey: Buffer.from(ed.getPublicKey(SEED)).toString("base64") }) as never);
      const provider = spyOn(ProviderManager.prototype, "complete").mockImplementation(async () => {
        if (refusal === "identity") {
          writeFileSync(cur("m1.json"), `${readFileSync(cur("m1.json"), "utf8")} `);
        } else {
          const intent = intentJson("m1.json");
          intent.claim.token = randomUUID();
          intent.claim.moduleNonce = randomUUID();
          writeFileSync(intentPath("m1.json"), JSON.stringify(intent));
        }
        enter(); await finishing;
        return completingProvider.complete();
      });
      const memoryPath = join(workspace, "memory.jsonl");
      const pidPath = join(workspace, ".tps-agent.pid");
      const runtime = new AgentRuntime({
        agentId: AGENT, name: `${refusal}-refusal-test`, mailDir, workspace, memoryPath,
        llm: { provider: "openai", model: "test", apiKey: "test" },
      });
      const seen: string[] = [];
      const next = MailClient.prototype.deliverNext;
      const nextSpy = spyOn(MailClient.prototype, "deliverNext").mockImplementation(async function() {
        const result = await next.call(this);
        if (result.status === "delivered") seen.push(result.delivery.message.verifiedEnvelope!.messageId);
        return result;
      });
      const complete = MailClient.prototype.completeDelivery;
      const settlementSpy = spyOn(MailClient.prototype, "completeDelivery").mockImplementation(async function(delivery) {
        expect(existsSync(pidPath)).toBe(true);
        const before = readFileSync(intentPath("m1.json"), "utf8");
        const result = await complete.call(this, delivery);
        expect(result).toMatchObject({ status: "refused", reason: refusal });
        expect(readFileSync(intentPath("m1.json"), "utf8")).toBe(before);
        return result;
      });
      let loopReturned = false;
      const run = EventLoop.prototype.runDeliveries;
      const loopSpy = spyOn(EventLoop.prototype, "runDeliveries").mockImplementation(async function(source) {
        await run.call(this, source);
        expect(existsSync(pidPath)).toBe(true);
        loopReturned = true;
      });
      const start = runtime.start();
      void start.catch(() => {});
      try {
        await entered;
        const pending = readFileSync(intentPath("m1.json"), "utf8");
        process.emit(signal);
        expect(loopReturned).toBe(false);
        expect(existsSync(pidPath)).toBe(true);
        finish();
        await start;
        expect(settlementSpy).toHaveBeenCalledTimes(1);
        expect(loopReturned).toBe(true);
        expect(existsSync(pidPath)).toBe(false);
        expect(readFileSync(memoryPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toContainEqual({
          type: "error", ts: expect.any(String), data: `delivery settlement refused: ${refusal}`,
        });
        expect(readFileSync(intentPath("m1.json"), "utf8")).toBe(pending);
        expect(intentPhase("m1.json")).toBe("in_progress");
        expect(intentJson("m1.json").claim).toBeDefined();
        expect(nextSpy).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([`${refusal}-refusal`]);
        expect(await client().deliverNext()).toMatchObject({ status: "deferred", reason: refusal === "identity" ? "record-changed" : "active" });
        expect(seen).toEqual([`${refusal}-refusal`]);
        expect(newFiles()).toEqual(["m2.json"]);
        expect(curFiles()).toEqual(["m1.json"]);
      } finally {
        finish();
        await runtime.stop();
        await start.catch(() => {});
        loopSpy.mockRestore(); settlementSpy.mockRestore(); nextSpy.mockRestore();
        provider.mockRestore(); lookup.mockRestore();
      }
    }, 15_000);
  }

  test(`AgentRuntime.start attempts release after memory writes fail during ${signal} before removing its PID file`, async () => {
    plant("m1.json", "memory-failure");
    plant("m2.json", "later");
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    const lookup = spyOn(FlairContextProvider.prototype, "getAgent").mockImplementation(async () => ({ publicKey: Buffer.from(ed.getPublicKey(SEED)).toString("base64") }) as never);
    const provider = spyOn(ProviderManager.prototype, "complete").mockImplementation(async () => {
      enter(); await finishing;
      return completingProvider.complete();
    });
    const memoryPath = join(workspace, "memory.jsonl");
    const pidPath = join(workspace, ".tps-agent.pid");
    const runtime = new AgentRuntime({
      agentId: AGENT, name: "memory-failure-test", mailDir, workspace, memoryPath,
      llm: { provider: "openai", model: "test", apiKey: "test" },
    });
    const append = MemoryStore.prototype.append;
    const failedWrites: string[] = [];
    const memorySpy = spyOn(MemoryStore.prototype, "append").mockImplementation(function(event) {
      try { return append.call(this, event); }
      catch (error) { failedWrites.push(event.type); throw error; }
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    let released = false;
    const release = MailClient.prototype.releaseDelivery;
    const settlementSpy = spyOn(MailClient.prototype, "releaseDelivery").mockImplementation(function(delivery) {
      expect(existsSync(pidPath)).toBe(true);
      expect(intentJson("m1.json").claim).toBeDefined();
      const result = release.call(this, delivery);
      expect(result.status).toBe("released");
      expect(intentJson("m1.json").claim).toBeUndefined();
      released = true;
      return result;
    });
    const start = runtime.start();
    void start.catch(() => {});
    try {
      await entered;
      expect(intentJson("m1.json").claim).toBeDefined();
      expect(existsSync(memoryPath)).toBe(true);
      renameSync(memoryPath, `${memoryPath}.saved`);
      mkdirSync(memoryPath);
      process.emit(signal);
      expect(existsSync(pidPath)).toBe(true);
      finish();
      await start;
      expect(failedWrites).toEqual(["assistant", "error"]);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Failed to record event-loop error"), expect.any(String));
      expect(released).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      expect(intentJson("m1.json").claim).toBeUndefined();
      expect(newFiles()).toEqual(["m2.json"]);
    } finally {
      finish();
      await runtime.stop();
      await start.catch(() => {});
      settlementSpy.mockRestore(); memorySpy.mockRestore(); errorLog.mockRestore();
      provider.mockRestore(); lookup.mockRestore();
    }
  }, 15_000);

  for (const completed of [true, false]) {
    test(`AgentRuntime.start retries deferred ${completed ? "finalize" : "release"} after ${signal} before removing its PID file`, async () => {
      plant("m1.json", "in-flight");
      plant("m2.json", "later");
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let finish!: () => void;
      const finishing = new Promise<void>((resolve) => { finish = resolve; });
      const lookup = spyOn(FlairContextProvider.prototype, "getAgent").mockImplementation(async () => ({ publicKey: Buffer.from(ed.getPublicKey(SEED)).toString("base64") }) as never);
      const provider = spyOn(ProviderManager.prototype, "complete").mockImplementation(async () => {
        enter(); await finishing;
        return completed ? completingProvider.complete() : toolCallingProvider.complete();
      });
      const runtime = new AgentRuntime({
        agentId: AGENT, name: "signal-test", mailDir, workspace,
        memoryPath: join(workspace, "memory.jsonl"), maxToolTurns: 0,
        llm: { provider: "openai", model: "test", apiKey: "test" },
      });
      let returned = false;
      const start = runtime.start().then(() => { returned = true; });
      const pidPath = join(workspace, ".tps-agent.pid");
      const claimDir = join(root, ".mail-lock.claim");
      const original = MailClient.prototype[completed ? "completeDelivery" : "releaseDelivery"];
      let deferred!: () => void;
      const deferring = new Promise<void>((resolve) => { deferred = resolve; });
      const settlementSpy = completed
        ? spyOn(MailClient.prototype, "completeDelivery").mockImplementation(async function(delivery) {
            const result = await (original as MailClient["completeDelivery"]).call(this, delivery);
            if (result.status === "deferred") deferred();
            return result;
          })
        : spyOn(MailClient.prototype, "releaseDelivery").mockImplementation(function(delivery) {
            const result = (original as MailClient["releaseDelivery"]).call(this, delivery);
            if (result.status === "deferred") deferred();
            return result;
          });
      try {
        await entered;
        process.emit(signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(returned).toBe(false);
        expect(existsSync(pidPath)).toBe(true);
        mkdirSync(claimDir);
        finish();
        await deferring;
        expect(returned).toBe(false);
        expect(existsSync(pidPath)).toBe(true);
        expect(intentJson("m1.json").claim).toBeDefined();
        rmSync(claimDir, { recursive: true });
        await start;
        expect(existsSync(pidPath)).toBe(false);
        expect(newFiles()).toEqual(["m2.json"]);
        expect(completed ? intentPhase("m1.json") : intentJson("m1.json").claim).toBe(completed ? null : undefined);
      } finally {
        finish();
        rmSync(claimDir, { recursive: true, force: true });
        await runtime.stop();
        await start;
        settlementSpy.mockRestore(); provider.mockRestore(); lookup.mockRestore();
      }
    }, 15_000);
  }
}

test("a settlement refusal whose durable record fails still logs the refusal reason", async () => {
  plant("m1.json", "identity-refusal");
  const c = client();
  const memoryPath = join(workspace, "memory.jsonl");
  const memory = new MemoryStore(memoryPath);
  const config = {
    agentId: AGENT, name: "refusal-log", mailDir, memoryPath, workspace,
    llm: { provider: "test", model: "test-model" }, contextWindowTokens: 8000, maxToolTurns: 50,
  };
  const provider = {
    async complete() {
      // Break the committed cur/ record's identity so the settlement is refused.
      writeFileSync(cur("m1.json"), `${readFileSync(cur("m1.json"), "utf8")} `);
      return completingProvider.complete();
    },
  };
  const loop = new EventLoop({
    config: config as never,
    memory,
    context: {} as never,
    provider: provider as never,
    tools: { list: () => [], execute: async () => ({ content: "ok" }) } as never,
  }, 1);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  const complete = c.completeDelivery.bind(c);
  const settlementSpy = spyOn(c, "completeDelivery").mockImplementation(async (delivery) => {
    // The real memory file becomes unwritable (a directory) before the refusal is recorded.
    renameSync(memoryPath, `${memoryPath}.saved`);
    mkdirSync(memoryPath);
    const result = await complete(delivery);
    expect(result).toMatchObject({ status: "refused", reason: "identity" });
    return result;
  });
  const source: MailDeliverySource = {
    async deliverNext() {
      const result = await c.deliverNext();
      if (result.status === "delivered") void loop.stop();
      return result;
    },
    completeDelivery: (delivery) => c.completeDelivery(delivery),
    releaseDelivery: (delivery) => c.releaseDelivery(delivery),
  };
  try {
    await loop.runDeliveries(source);
    const refusal = errorLog.mock.calls.find((call) => String(call[0]).includes("delivery settlement refused: identity"));
    expect(refusal).toBeDefined();
    expect(String(refusal?.[1]).length).toBeGreaterThan(0);
    expect(intentPhase("m1.json")).toBe("in_progress");
  } finally {
    settlementSpy.mockRestore();
    errorLog.mockRestore();
  }
}, 15_000);
