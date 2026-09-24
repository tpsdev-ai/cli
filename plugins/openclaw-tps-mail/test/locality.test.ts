/**
 * locality.test.ts — cli#389: ONE locality decision for outbound mail.
 *
 * The defect: the plugin's `isLocalRecipient` returned true when a directory
 * `~/.tps/mail/<to>/` existed, so a maildir for a REMOTE peer (archiving,
 * inspection, accident) silently reclassified it as local and the reply was
 * written where nothing would ever read it — while `tps mail send` used a
 * different rule and `deliverOutboundMail` a third.
 *
 * The fix routes BOTH plugin paths (the dispatcher reply and the outbound
 * adapter) through `resolveMailRoute` from
 * `@tpsdev-ai/cli/utils/mail-routing`, the SAME decision `tps mail send` makes:
 *   (1) a BRANCH relays every non-bound recipient to ~/.tps/outbox/new/ — a
 *       directory never matters there;
 *   (2) the OFFICE sends a recipient registered remotely (GAL + remote.json)
 *       over the wire and delivers everything else into a local maildir;
 *   (3) an OFFICE recipient with no GAL, no binding and no maildir is a NAMED
 *       failure — never a silent write.
 *
 * Cases (a)–(e) mirror the dispatch table; (f) asserts both paths agree per
 * case. The relay transport is mocked (no network, no Noise handshake), so a
 * `remote-branch` decision is observable.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

// ── mock the wire transport so a remote-branch decision is observable ─────────
// MUST run before the plugin (which imports deliverToRemoteBranch) is loaded.
const relayCalls: Array<{ branchId: string; msg: any }> = [];
mock.module("@tpsdev-ai/cli/utils/relay", () => ({
  deliverToRemoteBranch: async (branchId: string, msg: any) => {
    relayCalls.push({ branchId, msg });
  },
  deliverToSandbox: () => {},
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

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Run `fn` against a FRESH HOME. Each path gets its own root so one path's
 * probe mail can never perturb the other's observation (a stray file in a bound
 * agent's new/ is delivered/DLQ'd by the watcher).
 */
async function inFreshHome<T>(setup: () => void, fn: () => Promise<T>): Promise<T> {
  const prevRoot = root;
  const prevMail = mailDir;
  const prevHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), "tps-locality-"));
  mailDir = join(root, ".tps", "mail");
  mkdirSync(mailDir, { recursive: true });
  process.env.HOME = root;
  relayCalls.length = 0;
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
  relayCalls.length = 0;
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

// ── fixture builders ─────────────────────────────────────────────────────────

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

/** The shared decision, read directly (both plugin paths call exactly this). */
async function routeViaDecision(to: string, bound: string[] = []): Promise<string> {
  const mod = await import("@tpsdev-ai/cli/utils/mail-routing");
  return mod.resolveMailRoute({ to, mailDir, localAgents: bound }).kind;
}

/** Route the OUTBOUND adapter path and report the route (or "failure"). */
async function routeViaOutbound(to: string, bound: string[] = []): Promise<string> {
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
  return res?.ok ? res.details.route : "failure";
}

/** Route the DISPATCHER reply path and report where the reply landed. */
async function routeViaDispatcher(sender: string, bound: string[] = []): Promise<string> {
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
  // A signing key for the replying agent (a receipt requires a signed reply).
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

    await dispatched!.deliver({ text: "final verdict" }, { kind: "final" });
    settleFn?.();

    // Observe the destination. A BOUND recipient's maildir is WATCHED, so the
    // reply may be promoted new/ → cur/ by the time we look — check both.
    const localDirs = [join(mailDir, sender, "new"), join(mailDir, sender, "cur")];
    const localHas = () => localDirs.some((d) => readdirSafe(d).filter((f) => f.endsWith(".json")).length > 0);
    const outbox = join(root, ".tps", "outbox", "new");
    const outboxHas = () => readdirSafe(outbox).filter((f) => f.endsWith(".json")).length > 0;
    await waitFor(() => localHas() || outboxHas() || relayCalls.length > 0, 2000);

    let route = "failure";
    if (localHas()) route = "local";
    else if (outboxHas()) route = "outbox";
    else if (relayCalls.length > 0) route = "remote-branch";

    abort.abort();
    try {
      await startPromise;
    } catch {
      /* expected */
    }
    return route;
  } finally {
    if (origKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR;
    else process.env.TPS_TEST_KEYS_DIR = origKeys;
  }
}

// ── cases ────────────────────────────────────────────────────────────────────

interface Case {
  label: string;
  expectRoute: string;
  recipient: string;
  bound: string[];
  setup: () => void;
}

const CASES: Case[] = [
  {
    label: "(a) branch, flint NOT bound, maildir EXISTS → outbox (dir existence must NOT make it local)",
    expectRoute: "outbox",
    recipient: "flint",
    bound: ["anvil"],
    setup: () => {
      branchHost();
      maildirFor("flint");
    },
  },
  {
    label: "(b) branch, bound local agent → local maildir",
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
    label: "(d) office, recipient with a GAL entry + remote.json → remote",
    expectRoute: "remote-branch",
    recipient: "rockit",
    bound: ["anvil"],
    setup: () => {
      galEntry("rockit", "tps-rockit");
      remoteBranch("tps-rockit");
    },
  },
  {
    label: "(e) office, unknown recipient (no GAL, no binding, no maildir) → named failure",
    expectRoute: "unknown",
    recipient: "stranger",
    bound: ["anvil"],
    setup: () => {},
  },
];

describe("cli#389 — ONE locality decision (shared with `tps mail send`)", () => {
  for (const c of CASES) {
    it(c.label, async () => {
      expect(await inFreshHome(c.setup, () => routeViaDecision(c.recipient, c.bound))).toBe(c.expectRoute);
    });
  }

  // (f) both plugin paths give the SAME answer for every case.
  for (const c of CASES) {
    it(`(f) outbound adapter and the dispatcher reply AGREE — ${c.expectRoute}`, async () => {
      const outbound = await inFreshHome(c.setup, () => routeViaOutbound(c.recipient, c.bound));
      const dispatcher = await inFreshHome(c.setup, () => routeViaDispatcher(c.recipient, c.bound));

      const normalize = (r: string) => (r === "failure" ? "unknown" : r);
      expect(normalize(outbound)).toBe(c.expectRoute);
      expect(normalize(dispatcher)).toBe(c.expectRoute);
      expect(normalize(outbound)).toBe(normalize(dispatcher));
    }, 15000);
  }
});
