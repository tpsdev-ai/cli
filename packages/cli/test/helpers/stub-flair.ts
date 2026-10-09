/**
 * stub-flair.ts — the ONE shared stub Flair HTTP endpoint for the cli tests,
 * plus the signing helpers the mail tests use.
 *
 * The production Flair client signs every request:
 *   Authorization: TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signature>
 *   signature payload: <agentId>:<timestamp>:<nonce>:<METHOD>:<path?query>
 * Real Flair refuses an unverified caller, so a stub that ignores the
 * Authorization header lets a test keep passing after the client's signing
 * breaks (cli#554). `stubFlairHandler` verifies the caller before it answers:
 *   - no or malformed header        -> 403 { type: "error:AccessViolation", ... }
 *   - timestamp outside the window  -> 401 { error: "timestamp_out_of_window" }
 *   - a nonce seen before           -> 401 { error: "nonce_replay_detected" }
 *   - a caller with no registered key -> 401 { error: "unknown_agent" }
 *   - a bad signature               -> 401 { error: "invalid_signature" }
 *
 * Built in it answers `GET /Health` (unauth, a liveness probe) and
 * `GET /Agent/<name>` (the public-key read the production client makes). A test
 * that needs other Flair routes passes a `routes` callback, which runs only
 * after the caller is verified.
 *
 * A test that drives a production signer must reach Flair through this helper
 * (`startStubFlair`, `installStubFlairFetch` or `stubFlairHandler`); the signer
 * inventory in flair-signer-inventory.test.ts maps each production Flair
 * signing path to such a test.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { createHash, createPublicKey, verify } from "node:crypto";
import { signEnvelope, type Envelope, type ChainEntry } from "@tpsdev-ai/agent";

// Wire sha512 for sync sign operations (same pattern as the other mail tests).
import { hashes } from "@noble/ed25519";
hashes.sha512 = (message: Uint8Array) => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

export function pubkeyFromSeed(seed: Buffer): Buffer {
  return Buffer.from(ed.getPublicKey(new Uint8Array(seed)));
}

/** A registered caller: a raw 32-byte seed, or the base64 SPKI public key itself. */
export type StubFlairCaller = Buffer | string;

/**
 * Routes a stub serves AFTER the caller is verified. Return a Response to
 * answer, or undefined to fall through to the built-in `/Agent/<name>` route.
 */
export type FlairRoutes = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

export interface StubFlair {
  url: string;
  stop(): void;
}

function publicKeyBase64(caller: StubFlairCaller): string {
  return typeof caller === "string" ? caller : pubkeyFromSeed(caller).toString("base64");
}

/** The response Flair returns to an unauthenticated caller. */
function accessViolation(url: URL): Response {
  return Response.json(
    {
      type: "error:AccessViolation",
      code: "AccessViolation",
      title: "Unauthorized access to resource",
      status: 403,
      instance: url.pathname + url.search,
    },
    { status: 403 },
  );
}

/**
 * A handler that verifies the TPS-Ed25519 callers' credentials before answering
 * a Flair route. `seeds` registers each caller the tests may sign as.
 */
export function stubFlairHandler(
  seeds: Record<string, StubFlairCaller>,
  routes?: FlairRoutes,
): (req: Request) => Response | Promise<Response> {
  const pubs: Record<string, string> = {};
  for (const [name, caller] of Object.entries(seeds)) {
    pubs[name] = publicKeyBase64(caller);
  }
  const nonces = new Set<string>();
  const builtin = (url: URL): Response => {
    const m = url.pathname.match(/^\/Agent\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      const pk = Object.hasOwn(pubs, name) ? pubs[name] : undefined;
      if (!pk) return new Response("not found", { status: 404 });
      return Response.json({ id: name, name, publicKey: pk });
    }
    return new Response("not found", { status: 404 });
  };
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/Health") return new Response("ok");
    const header = req.headers.get("Authorization") ?? "";
    const auth = header.length <= 4096 ? /^TPS-Ed25519\s+([^:\s]+):(\d+):([^:\s]+):(.+)$/.exec(header) : null;
    if (!auth) return accessViolation(url);
    const [, caller, timestamp, nonce, signature] = auth;
    const refuse = (error: string) => Response.json({ error }, { status: 401 });
    const now = Date.now();
    if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > 30_000)
      return refuse("timestamp_out_of_window");
    const replayKey = `${caller}:${nonce}`;
    if (nonces.has(replayKey)) return refuse("nonce_replay_detected");
    if (!caller || !Object.hasOwn(pubs, caller)) return refuse("unknown_agent");
    try {
      const payload = `${caller}:${timestamp}:${nonce}:${req.method}:${url.pathname}${url.search}`;
      const key = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubs[caller]!, "base64")]),
        format: "der", type: "spki",
      });
      if (!verify(null, Buffer.from(payload), key, Buffer.from(signature!, "base64")))
        return refuse("invalid_signature");
    } catch {
      return refuse("signature_verification_failed");
    }
    nonces.add(replayKey);
    if (routes) {
      const routed = routes(req, url);
      return routed instanceof Promise ? routed.then((r) => r ?? builtin(url)) : (routed ?? builtin(url));
    }
    return builtin(url);
  };
}

/** Start a stub Flair HTTP server: the production client can be pointed at `url`. */
export function startStubFlair(seeds: Record<string, StubFlairCaller>, routes?: FlairRoutes): StubFlair {
  const server = Bun.serve({ port: 0, fetch: stubFlairHandler(seeds, routes) });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Point `globalThis.fetch` at a stub Flair, restoring the previous fetch on
 * `stop()`. The test file itself constructs no fetch stub.
 */
export function installStubFlairFetch(
  seeds: Record<string, StubFlairCaller>,
  routes?: FlairRoutes,
): StubFlair {
  const previous = globalThis.fetch;
  const handler = stubFlairHandler(seeds, routes);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  return { url: "http://flair.test", stop: () => { globalThis.fetch = previous; } };
}

/** Write a raw 32-byte key file usable for both request signing and FLAIR_KEY_PATH. */
export function writeKeyFile(dir: string, agent: string, seed: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}.key`);
  writeFileSync(p, seed);
  return p;
}

export function buildSignedEnvelope(
  from: string,
  to: string,
  body: string,
  seeds: Record<string, Buffer>,
  opts: { messageId?: string; chain?: ChainEntry[]; trust?: string } = {},
): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = opts.chain ?? [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  const envelope: Envelope = {
    v: 1,
    from,
    to,
    body,
    messageId: opts.messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    delegationChain: chain,
  };
  // `trust` is a signed envelope field. The cast lets a test plant an
  // out-of-union value (the unknown-trust-refused case).
  if (opts.trust !== undefined) (envelope as { trust?: unknown }).trust = opts.trust;
  return signEnvelope(envelope, seeds);
}
