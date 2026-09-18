/**
 * stub-flair.ts — a hermetic stub Flair HTTP server + signing helpers for the
 * mail-promotion tests.
 *
 * promote() constructs its Flair client UNCONDITIONALLY (there is no client
 * parameter to inject), so these tests exercise the real path: they point
 * FLAIR_URL at this stub and FLAIR_KEY_PATH at a key file, and let the real
 * CLI FlairClient sign its requests and read agent public keys back.
 *
 * The stub ignores Authorization (it only needs to hand back public keys); any
 * 32-byte key file satisfies the client's request signing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
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

/** Start a stub Flair that serves `<base>/Agent/<name>` → { publicKey: base64 }. */
export function startStubFlair(seeds: Record<string, Buffer>): StubFlair {
  const pubs: Record<string, string> = {};
  for (const [name, seed] of Object.entries(seeds)) {
    pubs[name] = pubkeyFromSeed(seed).toString("base64");
  }
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/Health") return new Response("ok");
      const m = url.pathname.match(/^\/Agent\/(.+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]!);
        const pk = pubs[name];
        if (!pk) return new Response("not found", { status: 404 });
        return Response.json({ id: name, name, publicKey: pk });
      }
      return new Response("not found", { status: 404 });
    },
  });
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
  opts: { messageId?: string; chain?: ChainEntry[] } = {},
): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = opts.chain ?? [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: from, kind: "agent", timestamp: now, rationale: `agent ${from} dispatches`, signature: null },
  ];
  return signEnvelope(
    {
      v: 1,
      from,
      to,
      body,
      messageId: opts.messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      delegationChain: chain,
    },
    seeds,
  );
}
