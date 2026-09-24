/**
 * obligation-retention.test.ts — cli#401: the obligation-record retention policy.
 *
 * (a) a terminal record older than N days → removed at startup; a younger one kept.
 * (b) pending / posted / yielded at ANY age → never removed.
 * (c) a malformed record older than N → kept + logged once.
 * (d) the config key changes N (N=1 removes a 2-day-old terminal record the default would keep).
 * (e) replay after a sweep: a replayed inbound id whose record was swept opens a FRESH obligation.
 *
 * Terminal records only; aged by the record's OWN `lastTransitionAt` (falling
 * back to `inboundTimestamp`), never the file mtime. (a) is RED on pre-fix main
 * (nothing is ever deleted).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pluginModule from "../src/index.js";
import { resolveObligationRetentionDays } from "../src/index.js";
import {
  createObligation,
  obligationPath,
  obligationsDir,
  readObligation,
  sweepTerminalObligations,
  writeReceipt,
} from "../src/obligations.js";

const AGENT = "retentionbot";
let mailDir: string;
let capturedPlugin: any;
let controller: AbortController;
const logs: { info: string[]; warn: string[] } = { info: [], warn: [] };

const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => { capturedPlugin = plugin; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  config: {},
  pluginConfig: {},
};

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Write a record into an agent's store (the suite's agent unless given). */
function writeRecordFor(
  agent: string,
  inboundId: string,
  obligationId: string,
  state: string,
  lastTransitionAt: string | null,
): void {
  const dir = obligationsDir(mailDir, agent);
  mkdirSync(dir, { recursive: true });
  const rec = {
    obligationId,
    inboundId,
    inboundTimestamp: lastTransitionAt ?? daysAgo(30),
    from: "sender",
    to: agent,
    accountId: "default",
    state,
    deadlineAt: null,
    attempts: 1,
    ...(lastTransitionAt ? { lastTransitionAt } : {}),
  };
  writeFileSync(join(dir, `${inboundId}.json`), JSON.stringify(rec, null, 2), "utf-8");
}

function writeRecord(id: string, state: string, lastTransitionAt: string | null): void {
  writeRecordFor(AGENT, id, `ob-${id}`, state, lastTransitionAt);
}

/** The receipts dir for an agent — inside that agent's own obligation store. */
const receiptsRootFor = (agent: string = AGENT): string => join(obligationsDir(mailDir, agent), "receipts");

/** Write a metadata receipt fixture by hand — the shape the sweep and scan read. */
const receipt = (obligationId: string, replyToId: string, ts: string, agent: string = AGENT): string => {
  mkdirSync(receiptsRootFor(agent), { recursive: true });
  const path = join(receiptsRootFor(agent), `${obligationId}.json`);
  writeFileSync(
    path,
    JSON.stringify({ replyId: `reply-${obligationId}`, obligationId, replyToId, route: "remote-branch", ts }, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  return path;
};

/** Drive the plugin's startup (which runs the retention sweep) and wait until
 *  `done()` or a deadline, then abort. */
async function runStartup(pluginConfig: Record<string, unknown>, done: () => boolean): Promise<void> {
  mockApi.pluginConfig = pluginConfig;
  pluginModule.register(mockApi);
  controller = new AbortController();
  const ctx = {
    account: { accountId: "default", mailDir, enabled: true },
    cfg: { bindings: [{ agentId: AGENT, match: { channel: "tps-mail", accountId: "default" } }] },
    log: {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: () => {},
    },
    channelRuntime: {
      routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}` },
      reply: { finalizeInboundContext: async (c: any) => c, dispatchReplyWithBufferedBlockDispatcher: async () => {} },
    },
    abortSignal: controller.signal,
  };
  const startPromise = capturedPlugin.gateway.startAccount(ctx);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  try { await startPromise; } catch { /* expected on abort */ }
}

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "tps-mail-retention-"));
  logs.info.length = 0;
  logs.warn.length = 0;
});
afterEach(() => {
  if (controller) { try { controller.abort(); } catch { /* */ } }
  rmSync(mailDir, { recursive: true, force: true });
});

describe("cli#401 — obligation retention", () => {
  it("(a) at startup: a terminal record older than N days is REMOVED; a younger one is KEPT", async () => {
    writeRecord("old-acked", "acked", daysAgo(10));
    writeRecord("young-acked", "acked", daysAgo(1));
    writeRecord("old-failed", "failed", daysAgo(10));
    await runStartup({}, () =>
      !existsSync(obligationPath(mailDir, AGENT, "old-acked")) &&
      !existsSync(obligationPath(mailDir, AGENT, "old-failed")));
    expect(existsSync(obligationPath(mailDir, AGENT, "old-acked")), "10-day-old acked must be removed").toBe(false);
    expect(existsSync(obligationPath(mailDir, AGENT, "old-failed")), "10-day-old failed must be removed").toBe(false);
    expect(existsSync(obligationPath(mailDir, AGENT, "young-acked")), "1-day-old acked must be kept").toBe(true);
  });

  it("(b) pending / posted / yielded at ANY age are NEVER removed", () => {
    writeRecord("pending-old", "pending", daysAgo(30));
    writeRecord("posted-old", "posted", daysAgo(30));
    writeRecord("yielded-old", "yielded", daysAgo(30));
    const before = readdirSync(obligationsDir(mailDir, AGENT)).filter((f) => f.endsWith(".json")).length;
    const res = sweepTerminalObligations(mailDir, AGENT, 7);
    const after = readdirSync(obligationsDir(mailDir, AGENT)).filter((f) => f.endsWith(".json")).length;
    expect(res.removed).toBe(0);
    expect(after).toBe(before);
    expect(existsSync(obligationPath(mailDir, AGENT, "pending-old"))).toBe(true);
    expect(existsSync(obligationPath(mailDir, AGENT, "posted-old"))).toBe(true);
    expect(existsSync(obligationPath(mailDir, AGENT, "yielded-old"))).toBe(true);
  });

  it("(c) a malformed record older than N is KEPT and logged ONCE", () => {
    mkdirSync(obligationsDir(mailDir, AGENT), { recursive: true });
    writeFileSync(join(obligationsDir(mailDir, AGENT), "broken.json"), "{ not json ", "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, { warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m) });
    expect(res.unreadable).toBe(1);
    expect(res.removed).toBe(0);
    expect(existsSync(join(obligationsDir(mailDir, AGENT), "broken.json"))).toBe(true);
    const warns = logs.warn.filter((m) => m.includes("unreadable/malformed"));
    expect(warns.length, "logged once").toBe(1);
    expect(warns[0]).toContain("broken.json");
  });

  it("(c') a terminal record with NO parseable timestamp is left in place", () => {
    writeRecord("no-ts", "acked", null);
    // strip every timestamp field from the record on disk
    const p = obligationPath(mailDir, AGENT, "no-ts");
    writeFileSync(p, JSON.stringify({ obligationId: "ob-no-ts", inboundId: "no-ts", state: "acked" }), "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, { warn: () => {}, info: () => {} });
    expect(res.removed).toBe(0);
    expect(existsSync(p)).toBe(true);
  });

  it("(d) the config key changes N — a 2-day-old terminal record the default keeps is removed at N=1", async () => {
    // resolution: the plugin config key wins; unset/invalid falls back to 7
    expect(resolveObligationRetentionDays({ obligationRetentionDays: 1 }, undefined)).toBe(1);
    expect(resolveObligationRetentionDays({ obligationRetentionDays: "3" }, undefined)).toBe(3);
    expect(resolveObligationRetentionDays({}, { obligationRetentionDays: 2 })).toBe(2);
    expect(resolveObligationRetentionDays({}, undefined)).toBe(7);
    expect(resolveObligationRetentionDays({ obligationRetentionDays: "nope" }, undefined)).toBe(7);

    writeRecord("two-days", "acked", daysAgo(2));
    // default (7): kept
    sweepTerminalObligations(mailDir, AGENT, 7, { info: () => {}, warn: () => {} });
    expect(existsSync(obligationPath(mailDir, AGENT, "two-days")), "default keeps a 2-day-old record").toBe(true);
    // N=1 via the PLUGIN config key at startup: removed
    await runStartup({ obligationRetentionDays: 1 }, () => !existsSync(obligationPath(mailDir, AGENT, "two-days")));
    expect(existsSync(obligationPath(mailDir, AGENT, "two-days")), "N=1 removes it").toBe(false);
  });

  it("(e) replay after a sweep: a swept acked record → the same inbound id opens a FRESH obligation", () => {
    writeRecord("replay-id", "acked", daysAgo(30));
    sweepTerminalObligations(mailDir, AGENT, 7, { info: () => {}, warn: () => {} });
    expect(existsSync(obligationPath(mailDir, AGENT, "replay-id")), "swept").toBe(false);
    const { created, record } = createObligation(mailDir, AGENT, () => ({
      obligationId: "ob-replay-id-fresh",
      inboundId: "replay-id",
      inboundTimestamp: new Date().toISOString(),
      from: "sender",
      to: AGENT,
      accountId: "default",
      state: "pending",
      deadlineAt: null,
      attempts: 0,
    }));
    expect(created, "a fresh obligation is ACCEPTED after a sweep").toBe(true);
    expect(record.state).toBe("pending");
    expect(readObligation(mailDir, AGENT, "replay-id")?.obligationId).toBe("ob-replay-id-fresh");
  });

  it("(f) retention <= 0 disables the sweep", () => {
    writeRecord("very-old", "acked", daysAgo(365));
    const res = sweepTerminalObligations(mailDir, AGENT, 0, { info: () => {}, warn: () => {} });
    expect(res.disabled).toBe(true);
    expect(existsSync(obligationPath(mailDir, AGENT, "very-old"))).toBe(true);
  });

  it("(d2) the DOCUMENTED config path drives the sweep: plugins.entries[id].config → api.pluginConfig", async () => {
    // The path a user sets in openclaw.json:
    const openclawConfig = {
      plugins: { entries: { "openclaw-tps-mail": { config: { obligationRetentionDays: 1 } } } },
    };
    // OpenClaw passes exactly `plugins.entries[id].config` to the plugin as api.pluginConfig:
    const receivedPluginConfig = openclawConfig.plugins.entries["openclaw-tps-mail"].config;
    expect(resolveObligationRetentionDays(receivedPluginConfig, undefined)).toBe(1);
    writeRecord("doc-two-days", "acked", daysAgo(2));
    await runStartup(receivedPluginConfig, () => !existsSync(obligationPath(mailDir, AGENT, "doc-two-days")));
    expect(existsSync(obligationPath(mailDir, AGENT, "doc-two-days")), "the documented path must drive the sweep").toBe(false);
  });

  it("(g) a PRESENT-but-unparseable lastTransitionAt is NOT aged by inboundTimestamp — kept + logged", () => {
    const p = obligationPath(mailDir, AGENT, "bad-ts");
    mkdirSync(obligationsDir(mailDir, AGENT), { recursive: true });
    writeFileSync(p, JSON.stringify({ obligationId: "ob-bad-ts", inboundId: "bad-ts", inboundTimestamp: daysAgo(60), state: "acked", lastTransitionAt: "not-a-date" }), "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, { warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m) });
    expect(res.removed, "unparseable present timestamp must not fall back").toBe(0);
    expect(res.unreadable).toBe(1);
    expect(existsSync(p)).toBe(true);
  });

  it("(h) a store-dir read failure other than ENOENT is LOGGED (not silently zero)", () => {
    // Put a FILE where the obligations dir should be → readdirSync → ENOTDIR.
    mkdirSync(join(mailDir, AGENT), { recursive: true });
    writeFileSync(obligationsDir(mailDir, AGENT), "not a directory", "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, { warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m) });
    expect(res.removed).toBe(0);
    expect(logs.warn.some((m) => m.includes("could not read")), "names the error").toBe(true);
  });

  it("(i) malformed record SHAPES (null / no state / unknown state) are reported unreadable, not skipped", () => {
    const dir = obligationsDir(mailDir, AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "null.json"), "null", "utf-8");
    writeFileSync(join(dir, "no-state.json"), JSON.stringify({ obligationId: "x", inboundId: "no-state" }), "utf-8");
    writeFileSync(join(dir, "bad-state.json"), JSON.stringify({ obligationId: "y", inboundId: "bad-state", state: "weird", lastTransitionAt: daysAgo(30) }), "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, { warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m) });
    expect(res.removed).toBe(0);
    expect(res.unreadable).toBe(3);
    expect(logs.warn.filter((m) => m.includes("unreadable/malformed")).length, "logged once").toBe(1);
    expect(existsSync(join(dir, "null.json")) && existsSync(join(dir, "no-state.json")) && existsSync(join(dir, "bad-state.json"))).toBe(true);
  });

  it("(j) an aged terminal record whose cur/ record is UNRESOLVED is HELD until recovery resolves it", () => {
    writeRecord("held-id", "acked", daysAgo(30));
    const curDir = join(mailDir, AGENT, "cur");
    mkdirSync(curDir, { recursive: true });
    // promoted but never acked (a crash between the obligation ack and the cur/ ackedAt)
    writeFileSync(join(curDir, "held-id.json"), JSON.stringify({ id: "held-id" }), "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, { info: () => {}, warn: () => {} });
    expect(res.removed).toBe(0);
    expect(res.heldForRecovery).toBe(1);
    expect(existsSync(obligationPath(mailDir, AGENT, "held-id"))).toBe(true);
    // once recovery resolves the cur/ record, a later sweep removes it normally
    writeFileSync(join(curDir, "held-id.json"), JSON.stringify({ id: "held-id", ackedAt: new Date().toISOString() }), "utf-8");
    expect(sweepTerminalObligations(mailDir, AGENT, 7, { info: () => {}, warn: () => {} }).removed).toBe(1);
  });
});

// ── cli#389 rounds 3-5: the SAME sweep owns THIS agent's metadata receipts ──

/**
 * A receipt is written on every successful delivery that leaves no locally
 * readable mail file (the wire, the sandbox bridge), so the receipts store grows
 * with traffic and NOTHING else ever removes a file from it. The sweep owns them
 * — and since cli#389 round 5 they live in the REPLYING agent's OWN obligation
 * store (`<mailDir>/<agent>/.obligations/receipts/<obligationId>.json`), so
 * every receipt a sweep sees belongs to an obligation IT can look up:
 *
 *   its obligation is LIVE here     → keep;
 *   its obligation is TERMINAL here → delete;
 *   no obligation here at all       → delete once aged past the window (an
 *                                     orphan), never before. A receipt with no
 *                                     readable timestamp is never aged.
 */
describe("cli#389 — the retention sweep owns THIS agent's receipts", () => {
  /** The receipts dir for this suite's agent (see receiptsRootFor). */
  const ROOT = (agent: string = AGENT): string => receiptsRootFor(agent);
  const quiet = { info: () => {}, warn: () => {} };

  it("(b) a terminal obligation's receipt is REMOVED, a live obligation's OLD receipt is KEPT, and an aged orphan is swept", () => {
    writeRecord("terminal-inbound", "acked", daysAgo(10));
    writeRecord("live-inbound", "posted", daysAgo(30)); // live, and well past the window
    const spent = receipt("ob-terminal-inbound", "terminal-inbound", new Date().toISOString());
    const live = receipt("ob-live-inbound", "live-inbound", daysAgo(30));
    const orphan = receipt("ob-orphan", "no-record-for-this", daysAgo(30));
    const youngOrphan = receipt("ob-young-orphan", "no-record-for-this-either", new Date().toISOString());
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(res.receiptsRemoved).toBe(2);
    expect(existsSync(spent), "a terminal obligation's receipt is gone").toBe(false);
    expect(existsSync(orphan), "an orphan past the window is swept").toBe(false);
    expect(existsSync(live), "a LIVE obligation's OLD receipt is kept").toBe(true);
    expect(existsSync(youngOrphan), "a young orphan is not yet an orphan").toBe(true);
  });

  it("1,000 aged receipts are swept — aged by their OWN ts, never the file mtime", () => {
    for (let i = 0; i < 1000; i++) receipt(`ob-old-${i}`, `inbound-${i}`, daysAgo(30));
    expect(readdirSync(ROOT()).filter((f) => f.endsWith(".json")).length, "fixture written").toBe(1000);
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(res.receiptsRemoved).toBe(1000);
    expect(readdirSync(ROOT()).filter((f) => f.endsWith(".json")).length).toBe(0);
  });

  it("a receipt with NO parseable ts and no obligation is LEFT in place", () => {
    const p = receipt("ob-no-ts", "inbound-not-here", "not-a-date");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(res.receiptsRemoved).toBe(0);
    expect(existsSync(p)).toBe(true);
  });

  it("a receipt that names NO obligation id is LEFT in place (never aged out on a guess)", () => {
    mkdirSync(ROOT(), { recursive: true });
    const p = join(ROOT(), "ob-nameless.json");
    writeFileSync(p, JSON.stringify({ replyId: "reply-x", replyToId: "inbound-x", route: "bridge", ts: daysAgo(30) }), "utf-8");
    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(res.receiptsRemoved).toBe(0);
    expect(existsSync(p)).toBe(true);
  });
});

// ── cli#389 round 5, item 1: the receipts are PER-AGENT ──────────────

/**
 * Two agents on ONE host can answer the SAME inbound id, and each agent's sweep
 * may touch only its OWN receipts. Rounds 3-4 kept receipts in a host-wide
 * shared directory and tried to make that store safe with a pair (obligation id
 * + inbound) and a per-agent live guard — but obligations live in per-agent
 * stores, so neither rule can speak for another agent's obligation: an agent
 * with no live record for an inbound could age out a receipt another agent still
 * needed, and an inbound-keyed live guard could hold another agent's receipt
 * forever.
 *
 * Since round 5 a receipt lives INSIDE the replying agent's own obligation store
 * (`<mailDir>/<agent>/.obligations/receipts/<obligationId>.json`) and is keyed on
 * the obligation id — a unique UUID — so a sweep owns exactly its own receipts
 * and can look up the obligation behind every one. These receipts go through
 * `writeReceipt`, the REAL writer: pointing that back at a shared directory
 * turns this test red.
 */
describe("cli#389 round 5 — two agents answering one inbound own their own receipts", () => {
  const OTHER = "secondbot";
  const quiet = { info: () => {}, warn: () => {} };
  const receiptFor = (agent: string, obligationId: string, replyToId: string, ts: string): string =>
    writeReceipt(mailDir, agent, { replyId: `reply-${obligationId}`, obligationId, replyToId, route: "remote-branch", ts });

  it("(a) each agent's sweep touches only its OWN receipts — neither deletes nor pins the other's", () => {
    const SHARED_INBOUND = "shared-inbound";
    // THIS agent: a TERMINAL obligation for that inbound, aged.
    writeRecordFor(AGENT, SHARED_INBOUND, `ob-${AGENT}-${SHARED_INBOUND}`, "acked", daysAgo(10));
    // THE OTHER agent: a LIVE obligation for the SAME inbound, whose receipt is
    // older than the window (kept because its obligation is live, not because
    // of its age).
    writeRecordFor(OTHER, SHARED_INBOUND, `ob-${OTHER}-${SHARED_INBOUND}`, "posted", daysAgo(30));
    const mine = receiptFor(AGENT, `ob-${AGENT}-${SHARED_INBOUND}`, SHARED_INBOUND, daysAgo(10));
    const theirs = receiptFor(OTHER, `ob-${OTHER}-${SHARED_INBOUND}`, SHARED_INBOUND, daysAgo(30));
    expect(mine).not.toBe(theirs);

    // The OTHER agent's sweep runs FIRST.
    const resOther = sweepTerminalObligations(mailDir, OTHER, 7, quiet);
    expect(resOther.receiptsRemoved, "the other agent removes nothing").toBe(0);
    expect(existsSync(theirs), "its own live obligation's receipt stays").toBe(true);
    expect(existsSync(mine), "and it does not touch this agent's receipt").toBe(true);

    // Then this agent's sweep: only ITS terminal obligation's receipt goes.
    const resMine = sweepTerminalObligations(mailDir, AGENT, 7, quiet);
    expect(resMine.receiptsRemoved, "only this agent's own receipt").toBe(1);
    expect(existsSync(mine), "this agent's terminal obligation's receipt is swept").toBe(false);
    expect(existsSync(theirs), "the OTHER agent's receipt is untouched").toBe(true);
  });

  it("a same-inbound receipt this store has no obligation for is not taken by this agent's terminal obligation", () => {
    // The pair rule's successor: the key is the obligation id alone, so a
    // receipt for ANOTHER obligation is never attributed to this terminal one,
    // whatever inbound they share.
    writeRecordFor(AGENT, "shared-inbound", "ob-shared-inbound", "acked", daysAgo(10));
    const terminalReceipt = receipt("ob-shared-inbound", "shared-inbound", new Date().toISOString());
    const anotherObligationsReceipt = receipt("ob-still-live", "shared-inbound", new Date().toISOString());

    const res = sweepTerminalObligations(mailDir, AGENT, 7, quiet);

    expect(existsSync(terminalReceipt), "the terminal obligation's own receipt is swept").toBe(false);
    expect(existsSync(anotherObligationsReceipt), "a same-inbound receipt for ANOTHER obligation is not terminal").toBe(true);
    expect(res.receiptsRemoved, "exactly the terminal one").toBe(1);
  });
});
