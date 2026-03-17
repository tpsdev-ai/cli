/**
 * service-proxy-host.ts — OPS-122 host-side service proxy handler
 *
 * Handles MSG_SERVICE_REQUEST messages from branch offices:
 * 1. Looks up the requested service in the registry
 * 2. Validates path (no traversal, no double-slash)
 * 3. Strips hop-by-hop headers before forwarding (K&S requirement)
 * 4. Forwards to the registered local URL
 * 5. Sends back MSG_SERVICE_RESPONSE
 *
 * Security:
 * - Path validated: must start with /, no .., no //
 * - Hop-by-hop headers stripped: Host, Connection, Transfer-Encoding,
 *   Content-Length, Keep-Alive, Upgrade
 * - URL constructed from registry entry — no arbitrary host forwarding
 * - 30s timeout per request (configurable per service entry)
 * - 1MB response size limit
 */

import type { TransportChannel, TpsMessage } from "./transport.js";
import { MSG_SERVICE_REQUEST, MSG_SERVICE_RESPONSE } from "./wire-mail.js";
import type { HttpRequestBody, HttpResponseBody } from "./wire-mail.js";
import { getService } from "./service-registry.js";

const HOP_BY_HOP = new Set([
  "host", "connection", "transfer-encoding", "content-length",
  "keep-alive", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailers",
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1MB

export function registerServiceProxyHandler(channel: TransportChannel): void {
  channel.onMessage(async (msg: TpsMessage) => {
    if (msg.type !== MSG_SERVICE_REQUEST) return;
    const req = msg.body as HttpRequestBody;

    const sendResponse = async (body: HttpResponseBody) => {
      await channel.send({
        type: MSG_SERVICE_RESPONSE,
        seq: 0,
        ts: new Date().toISOString(),
        body,
      }).catch(() => {});
    };

    // Resolve service
    const serviceName = req.service ?? "flair";
    let serviceEntry;
    try {
      serviceEntry = getService(serviceName);
    } catch {
      await sendResponse({ reqId: req.reqId, status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "invalid service name" }) });
      return;
    }

    if (!serviceEntry) {
      await sendResponse({ reqId: req.reqId, status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: `unknown service: ${serviceName}` }) });
      return;
    }

    // Validate path — prevent SSRF/traversal
    const path = req.path;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
      await sendResponse({ reqId: req.reqId, status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "invalid proxy path" }) });
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(path, serviceEntry.url);
      // Verify constructed URL stays within the service's origin (no redirect escape)
      const expectedOrigin = new URL(serviceEntry.url).origin;
      if (targetUrl.origin !== expectedOrigin) {
        throw new Error("origin mismatch");
      }
    } catch {
      await sendResponse({ reqId: req.reqId, status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "invalid proxy path" }) });
      return;
    }

    // Strip hop-by-hop headers before forwarding (K&S requirement)
    const forwardHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())),
    );

    const timeoutMs = serviceEntry.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers: forwardHeaders,
        body: req.body ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const resText = await response.text();
      // Enforce 1MB response cap
      if (resText.length > MAX_RESPONSE_BYTES) {
        await sendResponse({ reqId: req.reqId, status: 502, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "response too large" }) });
        return;
      }

      await sendResponse({
        reqId: req.reqId,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: resText,
      });
    } catch (err: any) {
      const isTimeout = err?.name === "TimeoutError" || err?.message?.includes("timeout");
      await sendResponse({
        reqId: req.reqId,
        status: isTimeout ? 504 : 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: isTimeout ? "service timeout" : `service unavailable: ${serviceName}` }),
      });
    }
  });
}
