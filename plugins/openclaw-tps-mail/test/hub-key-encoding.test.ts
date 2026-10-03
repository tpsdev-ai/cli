import { beforeEach, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

// Wire sha512 for the sync signing operations.
hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

import pluginModule from "../src/index.js";

// The REAL client, loaded through a distinct specifier so a mock of the resolved
// module (other suites replace the verification seam) cannot shadow it.
const { createMailVerifyClient: realCreateMailVerifyClient } = await import(
  "../../../packages/cli/dist/src/utils/mail-verify.js?cli-493-real"
);

const SENDER = "flint";
const AGENT = "anvil";

/** A 32-byte seed whose public key's base64url carries a '-' or '_'. */
function seedWithUrlChar(): Buffer {
  for (let i = 0; i < 256; i++) {
    const candidate = Buffer.alloc(32, i);
    const encoded = Buffer.from(ed.getPublicKey(new Uint8Array(candidate))).toString("base64url");
    if (encoded.includes("-") || encoded.includes("_")) return candidate;
  }
  throw new Error("no single-byte seed produced a base64url key with '-' or '_'");
}

const FLINT_SEED = seedWithUrlChar();
const FLINT_PUB_BASE64URL = Buffer.from(ed.getPublicKey(new Uint8Array(FLINT_SEED))).toString("base64url");
// The mailbox's own request-signing key (a raw 32-byte seed).
const READER_SEED = Buffer.alloc(32, 0x22);

let capturedPlugin: any;
const mockPluginApi: any = {
  registerChannel: ({ plugin }: { plugin: any }) => {
    capturedPlugin = plugin;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
pluginModule.register(mockPluginApi);

function buildSignedEnvelope(from: string, to: string, body: string): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  return signEnvelope(
    {
      v: 1,
      from,
      to,
      body,
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      delegationChain: chain,
    },
    { [from]: FLINT_SEED },
  );
}

function readDlqReason(mailDir: string, agentId: string): string | null {
  const dlqDir = resolve(mailDir, agentId, "dlq");
  try {
    const files = readdirSync(dlqDir).filter((f) => f.endsWith(".reason"));
    if (files.length === 0) return null;
    return readFileSync(join(dlqDir, files[0]!), "utf-8").trim();
  } catch {
    return null;
  }
}

describe("hub key encoding (cli#493)", () => {
  let tempMailDir: string;
  let abortController: AbortController;
  let dispatchResolve: (val: any) => void;
  let dispatchPromise: Promise<any>;
  let dispatchCount: number;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempMailDir = mkdtempSync(join(tmpdir(), "tps-hub-key-"));
    abortController = new AbortController();
    dispatchCount = 0;
    dispatchPromise = new Promise<any>((res) => {
      dispatchResolve = res;
    });

    // Point the REAL verify client at a stubbed hub. It reads these at call time.
    const keyPath = join(tempMailDir, "reader.key");
    writeFileSync(keyPath, READER_SEED);
    process.env.FLAIR_URL = "http://flair.test";
    process.env.FLAIR_KEY_PATH = keyPath;

    // The plugin imports createMailVerifyClient from this specifier; other suites
    // replace it with a seam. Restore the REAL implementation for this drill.
    mock.module("@tpsdev-ai/cli/utils/mail-verify", () => ({
      createMailVerifyClient: realCreateMailVerifyClient,
    }));

    // The stub hub: /Health is up and /Agent/flint carries the base64url key.
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input: any) => {
      const url = new URL(String(input));
      if (url.origin !== "http://flair.test") throw new Error(`unexpected hub: ${url.origin}`);
      if (url.pathname === "/Health") return new Response("ok");
      if (url.pathname === `/Agent/${SENDER}`) {
        return Response.json({ id: SENDER, name: SENDER, publicKey: FLINT_PUB_BASE64URL });
      }
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    abortController.abort();
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_KEY_PATH;
    try {
      rmSync(tempMailDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("delivers an envelope whose sender key the hub returns as unpadded base64url", async () => {
    expect(FLINT_PUB_BASE64URL).toHaveLength(43);
    expect(FLINT_PUB_BASE64URL).toMatch(/[-_]/);

    const envelope = buildSignedEnvelope(SENDER, AGENT, "Hello from a hub-encoded key");

    const newDir = resolve(tempMailDir, AGENT, "new");
    mkdirSync(newDir, { recursive: true });
    const msg = {
      id: `msg-${Date.now()}`,
      from: SENDER,
      to: AGENT,
      body: JSON.stringify(envelope),
      timestamp: new Date().toISOString(),
      deliveryAttempts: 0,
    };
    writeFileSync(resolve(newDir, `2026-10-03T00-00-00-${msg.id}.json`), JSON.stringify(msg, null, 2), "utf-8");

    const channelRuntime = {
      routing: {
        buildAgentSessionKey: (params: any) =>
          `agent:${params.agentId}:tps-mail:default:${params.peer.id}`,
      },
      reply: {
        finalizeInboundContext: async (ctx: any) => ({ ...ctx, CommandAuthorized: false }),
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }: any) => {
          dispatchCount++;
          dispatchResolve({ ctx });
        },
      },
    };

    const ctx = {
      account: { accountId: "default", mailDir: tempMailDir, enabled: true },
      cfg: { bindings: [{ agentId: AGENT, match: { channel: "tps-mail", accountId: "default" } }] },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      channelRuntime,
      abortSignal: abortController.signal,
    };

    const startPromise = capturedPlugin.gateway.startAccount(ctx);

    let dispatched: any = null;
    try {
      dispatched = await Promise.race([
        dispatchPromise,
        new Promise<null>((res) => setTimeout(() => res(null), 3000)),
      ]);
    } catch {
      /* timeout */
    }

    abortController.abort();
    try {
      await startPromise;
    } catch {
      /* expected on abort */
    }

    const dlqReason = readDlqReason(tempMailDir, AGENT);
    expect(dlqReason).toBeNull();
    expect(dispatched).not.toBeNull();
    expect(dispatched.ctx.Body).toBe("Hello from a hub-encoded key");
    expect(dispatched.ctx.From).toBe(SENDER);
    expect(dispatchCount).toBe(1);
  });
});
