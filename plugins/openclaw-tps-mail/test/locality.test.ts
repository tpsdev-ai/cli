/**
 * locality.test.ts — cli#389: ONE locality decision for outbound mail.
 *
 * The defect: the plugin's `isLocalRecipient` returned true when a directory
 * `~/.tps/mail/<to>/` existed, so a maildir for a REMOTE peer silently
 * reclassified it as local and the reply was written where nothing would read
 * it — while `tps mail send` used a different rule and `deliverOutboundMail` a
 * third. Both plugin paths now go through `resolveMailRoute`
 * (`@tpsdev-ai/cli/utils/mail-routing`), the SAME decision `tps mail send`
 * makes:
 *
 *   (a) branch, unbound, maildir exists        → outbox
 *   (b) branch, bound local agent              → local
 *   (c) office, unbound with a maildir         → local
 *   (d) office, GAL + remote.json              → remote-branch
 *   (e) office, unknown                        → unknown (named failure)
 *   (f) office, GAL without remote.json        → failed (gal-without-remote)
 *   (g) office, branch-office inbox (no remote) → bridge (deliverToSandbox)
 *   (h) office, remote.json under the recipient's OWN name (no GAL) → remote-branch
 *
 * Round 2 also covers item 1: a successful wire send persists a local receipt
 * (route + branch) that the obligation scan finds, so a delivered remote reply
 * is acked rather than nacked.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope, type ChainEntry } from "@tpsdev-ai/agent";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const FLINT_SEED = Buffer.alloc(32, 0x01); // the inbound sender (the reply's recipient)
const ANVIL_SEED = Buffer.alloc(32, 0x02); // the local agent that replies

function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

// ── mock the wire transport + bridge so both are observable ───────────────────
// MUST run before the plugin (which imports them) is loaded.
const relay = {
  deliver: [] as Array<{ branchId: string; msg: any }>,
  bridge: [] as Array<{ branchId: string; msg: any }>,
  failDeliver: false,
};
mock.module("@tpsdev-ai/cli/utils/relay", () => ({
  deliverToRemoteBranch: async (branchId: string, msg: any) => {
    if (relay.failDeliver) throw new Error("relay down");
    relay.deliver.push({ branchId, msg });
  },
  deliverToSandbox: (branchId: string, msg: any) => {
    relay.bridge.push({ branchId, msg });
  },
  resolveAgentMailRoot: (branchId: string) =>
    join(process.env.HOME ?? "", ".tps", "branch-office", branchId, "mail"),
}));

const pluginModule = (await import("../src/index.js")).default;

let capturedPlugin: any;
const mockApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => {
    capturedPlugin = plugin;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockApi);

function buildSignedBody(from: string, to: string, body: string): string {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  return JSON.stringify(
    signEnvelope(
      { v: 1, from, to, body, messageId: `env-${Math.random().toString(36).slice(2, 10)}`, timestamp: now, delegationChain: chain },
      { [from]: FLINT_SEED },
    ),
  );
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function readJsonSafe(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
/** All JSON records under `dirs` matching a header predicate. */
function scanFor(dirs: string[], pred: (rec: any) => boolean): Array<{ path: string; rec: any }> {
  const out: Array<{ path: string; rec: any }> = [];
  for (const dir of dirs) {
    for (const name of readdirSafe(dir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const path = resolve(dir, name);
      const rec = readJsonSafe(path);
      if (rec && pred(rec)) out.push({ path, rec });
    }
  }
  return out;
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
}

/**
 * Run `fn` against a FRESH HOME. Each path gets its own root so one path's
 * probe mail can never perturb the other's observation.
 */
async function inFreshHome<T>(setup: () => void, fn: () => Promise<T>): Promise<T> {
  const prevRoot = root;
  const prevMail = mailDir;
  const prevHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), "tps-locality-"));
  mailDir = join(root, ".tps", "mail");
  mkdirSync(mailDir, { recursive: true });
  process.env.HOME = root;
  relay.deliver.length = 0;
  relay.bridge.length = 0;
  relay.failDeliver = false;
  try {
    setup();
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    root = prevRoot;
    mailDir = prevMail;
  }
}

// ── per-test HOME ────────────────────────────────────────────────────────────

let root: string;
let mailDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-locality-"));
  mailDir = join(root, ".tps", "mail");
  mkdirSync(mailDir, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = root;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── fixture builders (operate on the CURRENT root) ────────────────────────────

function branchHost(): void {
  mkdirSync(join(root, ".tps", "identity"), { recursive: true });
  writeFileSync(join(root, ".tps", "identity", "host.json"), "{}\n", "utf-8");
}
function maildirFor(agent: string): void {
  mkdirSync(join(mailDir, agent, "new"), { recursive: true });
}
function galEntry(agentId: string, branchId: string): void {
  mkdirSync(join(root, ".tps"), { recursive: true });
  writeFileSync(
    join(root, ".tps", "gal.json"),
    JSON.stringify({ version: 1, entries: [{ agentId, branchId, updatedAt: new Date().toISOString() }] }, null, 2),
    "utf-8",
  );
}
function remoteBranch(branchId: string): void {
  mkdirSync(join(root, ".tps", "branch-office", branchId), { recursive: true });
  writeFileSync(
    join(root, ".tps", "branch-office", branchId, "remote.json"),
    JSON.stringify({ host: "127.0.0.1", port: 65000, transport: "ws" }, null, 2),
    "utf-8",
  );
}
function branchInbox(branchId: string): void {
  mkdirSync(join(root, ".tps", "branch-office", branchId, "mail", "inbox"), { recursive: true });
}

/** The shared decision, read directly (both callers use exactly this). */
async function routeViaDecision(to: string, bound: string[] = []): Promise<string> {
  const mod = await import("@tpsdev-ai/cli/utils/mail-routing");
  return mod.resolveMailRoute({ to, mailDir, localAgents: bound }).kind;
}

/** Route the OUTBOUND adapter path; report the route kind or the failure. */
async function routeViaOutbound(to: string, bound: string[] = []): Promise<{ ok: boolean; route: string; error?: string }> {
  const cfg = {
    channels: { "tps-mail": { accounts: { default: { mailDir, enabled: true } } } },
    bindings: bound.map((agentId) => ({ agentId, match: { channel: "tps-mail", accountId: "default" } })),
  };
  const res: any = await capturedPlugin.outbound.sendText({
    cfg,
    accountId: "default",
    to,
    text: "route probe",
    identity: { agentId: "anvil" },
  });
  return res?.ok ? { ok: true, route: res.details.route } : { ok: false, route: "failure", error: String(res?.error ?? "") };
}

interface DispatchOutcome {
  /** Where the reply landed, or "failure" when nothing was delivered. */
  route: "local" | "outbox" | "remote-branch" | "bridge" | "failure";
  /** The reply record's id (never the inbound's). */
  replyId: string | null;
  /** The reply record itself (parsed before the temp root is torn down). */
  replyRecord: any | null;
  /** A receipt record for this inbound (the local metadata receipt, item 1). */
  receiptRecord: any | null;
  /** The receipt file's raw bytes, read BEFORE the throwaway HOME is torn down. */
  receiptRaw: string | null;
  /** The receipt file's permission bits (0600 at creation), read with it. */
  receiptMode: number | null;
  /** The obligation record (state + named failure). */
  obligation: any | null;
  /** A nack record for this inbound, if one was written. */
  nack: string | null;
}

/** Route the DISPATCHER reply path and report the full obligation outcome. */
async function routeViaDispatcher(sender: string, bound: string[] = []): Promise<DispatchOutcome> {
  mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
    createMailVerifyClient: async () => ({
      async getAgent(name: string) {
        if (name === sender) return { publicKey: pubkeyFromSeed(FLINT_SEED) };
        if (name === bound[0]) return { publicKey: pubkeyFromSeed(ANVIL_SEED) };
        return null;
      },
    }),
  }));

  const agentId = bound[0]!;
  const keysDir = join(root, "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${agentId}.key`), ANVIL_SEED);
  const origKeys = process.env.TPS_TEST_KEYS_DIR;
  process.env.TPS_TEST_KEYS_DIR = keysDir;

  try {
    const newDir = join(mailDir, agentId, "new");
    mkdirSync(newDir, { recursive: true });
    const inboundId = `msg-${Math.random().toString(36).slice(2, 10)}`;
    const inbound = {
      id: inboundId,
      from: sender,
      to: agentId,
      body: buildSignedBody(sender, agentId, "inbound"),
      timestamp: new Date().toISOString(),
      headers: { "X-TPS-Trust": "agent", "X-TPS-Surface": "tps-mail" },
      deliveryAttempts: 0,
    };
    writeFileSync(join(newDir, `2026-05-26T00-00-00-${inboundId}.json`), JSON.stringify(inbound, null, 2), "utf-8");

    let dispatched: any = null;
    let settleFn: (() => void) | null = null;
    const channelRuntime = {
      routing: { buildAgentSessionKey: (p: any) => `agent:${p.agentId}:tps-mail:default:${p.peer.id}` },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }: any) => {
          dispatched = dispatcherOptions;
          await new Promise<void>((res) => {
            settleFn = res;
          });
        },
      },
    };
    const cfg = {
      channels: { "tps-mail": { accounts: { default: { mailDir, enabled: true } } } },
      bindings: bound.map((id) => ({ agentId: id, match: { channel: "tps-mail", accountId: "default" } })),
    };
    const abort = new AbortController();
    const ctx = {
      account: { accountId: "default", mailDir, enabled: true },
      cfg,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abort.signal,
    };
    const startPromise = capturedPlugin.gateway.startAccount(ctx);
    await waitFor(() => dispatched !== null || existsSync(join(mailDir, agentId, "dlq")));

    if (dispatched) {
      await dispatched.deliver({ text: "final verdict" }, { kind: "final" });
      settleFn?.();
    }

    const obligationPath = join(mailDir, agentId, ".obligations", `${inboundId}.json`);
    await waitFor(() => !!readJsonSafe(obligationPath), 2000);
    const obligation = readJsonSafe(obligationPath);
    // A terminal obligation means the post + receipt scan have finished.
    await waitFor(() => ["acked", "failed"].includes(readJsonSafe(obligationPath)?.state), 2500);

    const senderNew = join(mailDir, sender, "new");
    const senderCur = join(mailDir, sender, "cur");
    const outboxDirs = [join(root, ".tps", "outbox", "new"), join(root, ".tps", "outbox", "sent")];
    const receiptDirsAll = [join(root, ".tps", "receipts")];
    const bridgeDirs = [join(root, ".tps", "branch-office", sender, "mail", "new")];
    const isReply = (rec: any) => rec?.headers?.["X-TPS-InReplyTo"] === inboundId;
    // cli#389 round 3: a metadata receipt carries NO headers and NO body, so it
    // is found by the ids it names — the reply, and the inbound it answers.
    const isReceipt = (rec: any) => typeof rec?.replyId === "string" && rec?.replyToId === inboundId;

    const local = scanFor([senderNew, senderCur], isReply);
    const outbox = scanFor(outboxDirs, isReply);
    const receipt = scanFor(receiptDirsAll, isReceipt);
    // Read the receipt's BYTES and MODE here: inFreshHome removes this root.
    let receiptRaw: string | null = null;
    let receiptMode: number | null = null;
    if (receipt[0]) {
      try {
        receiptRaw = readFileSync(receipt[0].path, "utf-8");
        receiptMode = statSync(receipt[0].path).mode & 0o777;
      } catch {
        /* unreadable → leave both null */
      }
    }
    const nack = scanFor([senderNew, senderCur, ...outboxDirs, ...receiptDirsAll, ...bridgeDirs], (r) =>
      typeof r?.headers?.["X-TPS-Nack"] === "string",
    );

    let route: DispatchOutcome["route"] = "failure";
    let replyId: string | null = null;
    let replyRecord: any | null = null;
    if (local.length > 0) {
      route = "local";
      replyRecord = local[0]!.rec;
      replyId = local[0]!.rec.id ?? null;
    } else if (outbox.length > 0) {
      route = "outbox";
      replyRecord = outbox[0]!.rec;
      replyId = outbox[0]!.rec.id ?? null;
    } else if (relay.deliver.length > 0) {
      route = "remote-branch";
      replyRecord = receipt[0]?.rec ?? null;
      replyId = receipt[0]?.rec.replyId ?? null;
    } else if (relay.bridge.length > 0) {
      route = "bridge";
      replyRecord = receipt[0]?.rec ?? null;
      replyId = receipt[0]?.rec.replyId ?? null;
    }

    abort.abort();
    try {
      await startPromise;
    } catch {
      /* expected */
    }

    return {
      route,
      replyId,
      replyRecord,
      receiptRecord: receipt[0]?.rec ?? null,
      receiptRaw,
      receiptMode,
      obligation: readJsonSafe(obligationPath) ?? obligation,
      nack: nack[0]?.path ?? null,
    };
  } finally {
    if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR;
    else process.env.TPS_TEST_KEYS_DIR = origKeys;
  }
}

// ── cases ────────────────────────────────────────────────────────────────────

interface Case {
  label: string;
  expectRoute: "local" | "outbox" | "remote-branch" | "bridge" | "unknown" | "failed";
  expectFailure?: string;
  recipient: string;
  bound: string[];
  setup: () => void;
}

const CASES: Case[] = [
  {
    label: "(a) branch, flint NOT bound, maildir EXISTS → outbox",
    expectRoute: "outbox",
    recipient: "flint",
    bound: ["anvil"],
    setup: () => {
      branchHost();
      maildirFor("flint");
    },
  },
  {
    label: "(b) branch, bound local agent → local maildir (the REPLY file, by id)",
    expectRoute: "local",
    recipient: "anvil",
    bound: ["anvil"],
    setup: () => {
      branchHost();
    },
  },
  {
    label: "(c) office, flint unbound with a maildir, no GAL → local",
    expectRoute: "local",
    recipient: "flint",
    bound: ["anvil"],
    setup: () => {
      maildirFor("flint");
    },
  },
  {
    label: "(d) office, recipient with a GAL entry + remote.json → remote-branch",
    expectRoute: "remote-branch",
    recipient: "rockit",
    bound: ["anvil"],
    setup: () => {
      galEntry("rockit", "tps-rockit");
      remoteBranch("tps-rockit");
    },
  },
  {
    label: "(e) office, unknown recipient → named failure (no-route)",
    expectRoute: "unknown",
    expectFailure: "no-route:stranger",
    recipient: "stranger",
    bound: ["anvil"],
    setup: () => {},
  },
  {
    label: "(f) office, GAL entry with NO remote.json → failed (gal-without-remote)",
    expectRoute: "failed",
    expectFailure: "gal-without-remote",
    recipient: "sherlock",
    bound: ["anvil"],
    setup: () => {
      galEntry("sherlock", "tps-sherlock");
    },
  },
  {
    label: "(g) office, branch-office inbox with no remote.json → bridge",
    expectRoute: "bridge",
    recipient: "ember",
    bound: ["anvil"],
    setup: () => {
      branchInbox("ember");
    },
  },
  {
    label: "(h) office, remote.json under the recipient's OWN name (no GAL) → remote-branch",
    expectRoute: "remote-branch",
    recipient: "tps-rockit",
    bound: ["anvil"],
    setup: () => {
      remoteBranch("tps-rockit");
    },
  },
];

describe("cli#389 — ONE locality decision (shared with `tps mail send`)", () => {
  for (const c of CASES) {
    it(`${c.label} [resolver]`, async () => {
      expect(await inFreshHome(c.setup, () => routeViaDecision(c.recipient, c.bound))).toBe(c.expectRoute);
    });
  }

  // (f) both plugin paths give the SAME answer for every case.
  for (const c of CASES) {
    it(`(f) outbound adapter and the dispatcher reply AGREE — ${c.expectRoute}`, async () => {
      const outbound = await inFreshHome(c.setup, () => routeViaOutbound(c.recipient, c.bound));
      const dispatcher = await inFreshHome(c.setup, () => routeViaDispatcher(c.recipient, c.bound));

      const isFailure = c.expectRoute === "unknown" || c.expectRoute === "failed";
      if (isFailure) {
        // A named failure, never a write, on BOTH paths.
        expect(outbound.ok).toBe(false);
        expect(outbound.error).toContain(c.expectFailure === "gal-without-remote" ? "gal-without-remote" : "no delivery route");
        expect(dispatcher.route).toBe("failure");
        expect(dispatcher.obligation?.failure).toBe(c.expectFailure);
      } else {
        expect(outbound.ok).toBe(true);
        expect(outbound.route).toBe(c.expectRoute);
        expect(dispatcher.route).toBe(c.expectRoute);
      }
    }, 15000);
  }

  it("(b) the dispatcher writes the REPLY itself — a file with the reply id and X-TPS-InReplyTo, not the inbound", async () => {
    const c = CASES.find((x) => x.expectRoute === "local" && x.recipient === "anvil")!;
    const outcome = await inFreshHome(c.setup, () => routeViaDispatcher(c.recipient, c.bound));
    expect(outcome.route).toBe("local");
    expect(outcome.replyId).toBeTruthy();
    // It is the REPLY record (found by scanning the recipient's maildir), a
    // distinct record from the inbound, carrying the reply marker.
    expect(outcome.replyRecord).toBeTruthy();
    expect(outcome.replyRecord.id).toBe(outcome.replyId);
    expect(outcome.replyRecord.headers["X-TPS-InReplyTo"]).toBeDefined();
    expect(String(outcome.replyId).startsWith("msg-")).toBe(false); // NOT the inbound
  }, 20000);
});

// ── item 1: the remote-branch receipt closes the obligation loop ──────────────

describe("cli#389 item 1 — a remote-branch reply persists a local receipt", () => {
  it("posted → receipt found → acked, with NO nack", async () => {
    const setup = () => {
      galEntry("rockit", "tps-rockit");
      remoteBranch("tps-rockit");
    };
    const outcome = await inFreshHome(setup, () => routeViaDispatcher("rockit", ["anvil"]));
    expect(outcome.route).toBe("remote-branch");
    expect(relay.deliver.length).toBeGreaterThan(0);
    // The wire payload keeps the reply's OWN identity (id + timestamp).
    expect(relay.deliver[0]!.msg.id).toBe(outcome.replyId);
    expect(typeof relay.deliver[0]!.msg.timestamp).toBe("string");
    // The receipt is persisted (route + branch) and the obligation scan found it.
    expect(outcome.receiptRecord).toBeTruthy();
    expect(outcome.receiptRecord.route).toBe("remote-branch");
    expect(outcome.receiptRecord.branchId).toBe("tps-rockit");
    expect(outcome.obligation?.state).toBe("acked");
    expect(outcome.nack).toBeNull();
    // The receipt is METADATA-ONLY (cli#389 round 3, item 2): the ids, the route
    // and the timestamp — never the body, never the signed envelope.
    expect(outcome.receiptRaw).toBeTruthy();
    expect(Object.keys(JSON.parse(outcome.receiptRaw!)).sort()).toEqual([
      "branchId",
      "obligationId",
      "replyId",
      "replyToId",
      "route",
      "ts",
    ]);
    expect(outcome.receiptRaw!.includes("final verdict"), "the fixture BODY text must not be in the receipt").toBe(
      false,
    );
    expect(outcome.receiptRaw!.includes("delegationChain"), "nor the signed envelope").toBe(false);
    expect(outcome.receiptMode, "0600 at creation").toBe(0o600);
  }, 20000);

  it("relay fails → a named failure, no receipt", async () => {
    const setup = () => {
      galEntry("rockit", "tps-rockit");
      remoteBranch("tps-rockit");
      relay.failDeliver = true;
    };
    const outcome = await inFreshHome(setup, () => routeViaDispatcher("rockit", ["anvil"]));
    expect(outcome.route).toBe("failure");
    expect(outcome.receiptRecord).toBeNull();
    expect(outcome.obligation?.state).toBe("failed");
    // The failure is named (the wire error is carried, not a silent yield).
    expect(String(outcome.obligation?.failure)).toMatch(/^write-failed:/);
  }, 20000);
});

// ── item 1 (round 3): a BRIDGE reply closes the obligation the same way ───────

describe("cli#389 item 1 (round 3) — a bridge reply persists the same receipt", () => {
  it("bridge reply → posted → receipt → acked, with NO nack", async () => {
    // "ember" has a local branch-office inbox with no remote.json → the bridge.
    const setup = () => branchInbox("ember");
    const outcome = await inFreshHome(setup, () => routeViaDispatcher("ember", ["anvil"]));
    expect(outcome.route).toBe("bridge");
    // The CLI's own bridge got the reply (mocked so the write is observable)…
    expect(relay.bridge.length).toBeGreaterThan(0);
    expect(relay.bridge[0]!.branchId).toBe("ember");
    // …and the receipt the bridge owed: the SAME metadata record the wire writes.
    expect(outcome.receiptRecord).toBeTruthy();
    expect(outcome.receiptRecord.route).toBe("bridge");
    expect(outcome.receiptRecord.branchId).toBe("ember");
    expect(outcome.receiptRecord.obligationId).toBe(outcome.obligation?.obligationId);
    expect(typeof outcome.receiptRecord.replyId).toBe("string");
    expect(outcome.receiptRecord.replyToId).toBe(outcome.obligation?.inboundId);
    // The obligation is DISCHARGED: acked at the receipt, never nacked.
    expect(outcome.obligation?.state).toBe("acked");
    expect(outcome.nack).toBeNull();
  }, 20000);
});
