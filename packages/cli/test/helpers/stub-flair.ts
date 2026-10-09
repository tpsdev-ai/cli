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

export interface StubFlair {
  url: string;
  stop(): void;
}

export function stubFlairHandler(seeds: Record<string, Buffer>): (req: Request) => Response {
  const pubs: Record<string, string> = {};
  for (const [name, seed] of Object.entries(seeds)) {
    pubs[name] = pubkeyFromSeed(seed).toString("base64");
  }
  const nonces = new Set<string>();
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/Health") return new Response("ok");
    const header = req.headers.get("Authorization") ?? "";
    const auth = header.length <= 4096 ? /^TPS-Ed25519\s+([^:\s]+):(\d+):([^:\s]+):(.+)$/.exec(header) : null;
    if (!auth) return Response.json({
      type: "error:AccessViolation", code: "AccessViolation", title: "Unauthorized access to resource",
      status: 403, instance: url.pathname + url.search,
    }, { status: 403 });
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
    const m = url.pathname.match(/^\/Agent\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      const pk = Object.hasOwn(pubs, name) ? pubs[name] : undefined;
      if (!pk) return new Response("not found", { status: 404 });
      return Response.json({ id: name, name, publicKey: pk });
    }
    return new Response("not found", { status: 404 });
  };
}

export function startStubFlair(seeds: Record<string, Buffer>): StubFlair {
  const server = Bun.serve({ port: 0, fetch: stubFlairHandler(seeds) });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
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
