/**
 * cli#617 slice (c): the event loop consumes the per-message delivery API
 * (deliverNext / completeDelivery / releaseDelivery) and finalizes a message
 * only after its processing completes. A stop breaks before the next commit; a
 * crash or kill at any point before completion re-presents the message on the
 * next check. The design's acceptance list for this slice, at the loop seam.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { type DeliverNextResult, type MailDelivery, MailClient } from "../src/io/mail.js";
import { EventLoop, type MailDeliverySource } from "../src/runtime/event-loop.js";
import { mailboxReplayStore } from "../src/lib/mailbox-policy.js";
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
 * `stopOnId`, whichever comes first — a delivery already handed over is still
 * processed and finalized before the stop takes effect.
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
  });
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
/** A provider that never completes for a body containing `poison-body`. */
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

describe("a kill mid-handler re-presents the message on the loop's next check", () => {
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

describe("a graceful stop drains the message in flight and commits nothing further", () => {
  test("completed mail is not re-presented; every unhandled message is handled next", async () => {
    plant("m1.json", "first");
    plant("m2.json", "second");
    plant("m3.json", "third");

    const first = await runLoop(client(), { provider: completingProvider, stopAfter: 1 });
    expect(first).toEqual([{ id: "first", presentation: 1 }]);
    // The stop broke before committing the next message: both stay in new/.
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

describe("the liveness bound quarantines a handler that never completes", () => {
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
