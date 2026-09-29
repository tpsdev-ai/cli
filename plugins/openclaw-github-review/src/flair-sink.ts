/**
 * flair-sink.ts — the host-side authenticated signing path for audit records.
 *
 * This is deliberately self-contained: it reuses Flair's existing
 * `TPS-Ed25519 <agentId>:<ts>:<nonce>:<sig>` request scheme and the existing
 * OrgEvent schema, with no dependency on any other plugin or package. The
 * signing key is loaded once, here, and never exported.
 */

import { createPrivateKey, randomUUID, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "./request-timeout.js";
import type { AuditSink, OrgEventDraft } from "./types.js";

/** Load an Ed25519 private key from PEM, a raw 32-byte seed, or base64 PKCS8
 *  DER — the three on-disk formats the fleet uses. */
function loadEd25519Key(path: string): KeyObject {
  const buf = readFileSync(path);
  const text = buf.toString("utf8").trim();
  if (text.startsWith("-----")) {
    return createPrivateKey(text);
  }
  if (buf.length === 32) {
    const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
    return createPrivateKey({
      key: Buffer.concat([pkcs8Header, buf]),
      format: "der",
      type: "pkcs8",
    });
  }
  return createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" });
}

export class FlairHttpAuditSink implements AuditSink {
  private readonly key: KeyObject;
  private readonly baseUrl: string;

  constructor(
    private readonly agentId: string,
    baseUrl: string,
    keyPath: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Per-request timeout; defaults to REQUEST_TIMEOUT_MS (tests shorten it). */
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.key = loadEd25519Key(keyPath);
  }

  private authHeader(method: string, path: string): string {
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const payload = `${this.agentId}:${ts}:${nonce}:${method}:${path}`;
    const sig = ed25519Sign(null, Buffer.from(payload), this.key);
    return `TPS-Ed25519 ${this.agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
  }

  async record(event: OrgEventDraft): Promise<void> {
    const path = "/OrgEvent/";
    // A timeout rejects like any failed write, so the handler retains the record.
    const res = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader("POST", path),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: event.id,
        authorId: event.authorId,
        kind: event.kind,
        scope: event.scope,
        refId: event.refId,
        targetIds: event.targetIds,
        summary: event.summary,
        detail: event.detail,
        createdAt: event.createdAt,
      }),
    }, this.timeoutMs);
    if (!res.ok) {
      // No upstream body is surfaced: only a status.
      throw new Error(`audit write failed (status ${res.status})`);
    }
  }
}
