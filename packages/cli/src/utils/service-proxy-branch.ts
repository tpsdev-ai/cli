/**
 * service-proxy-branch.ts — OPS-122 branch-side service proxy
 *
 * Starts a local HTTP server for each advertised service.
 * Incoming HTTP requests are wrapped as MSG_SERVICE_REQUEST and sent
 * through the branch tunnel. Responses are correlated by reqId.
 *
 * From the agent's perspective (e.g., OpenClaw memory-flair plugin),
 * the service is localhost:<port> — it has no knowledge of the tunnel.
 *
 * On tunnel disconnect, all in-flight requests are failed immediately
 * with 502. Callers should retry.
 *
 * Security:
 * - Path validated before forwarding: must start with /, no .., no //
 * - Request body capped at 1MB
 * - 30s timeout per request
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { TransportChannel, TpsMessage } from "./transport.js";
import { MSG_SERVICE_REQUEST, MSG_SERVICE_RESPONSE } from "./wire-mail.js";
import type { HttpRequestBody, HttpResponseBody } from "./wire-mail.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

export interface ServiceProxyHandle {
  name: string;
  port: number;
  close: () => void;
}

export interface ServiceProxySet {
  handles: ServiceProxyHandle[];
  /** Fail all in-flight requests — call on tunnel disconnect */
  failAll: () => void;
  /** Close all local HTTP servers */
  close: () => void;
}

/**
 * Start local HTTP proxy servers for each service.
 * @param services - list of services advertised by the host
 * @param channel - active tunnel channel
 */
export function startServiceProxies(
  services: Array<{ name: string; localPort: number; description?: string }>,
  channel: TransportChannel,
): ServiceProxySet {
  type PendingEntry = {
    resolve: (r: HttpResponseBody) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  // Shared pending map across all service proxies (keyed by reqId)
  const pending = new Map<string, PendingEntry>();

  // Wire up the response handler once for the channel
  const responseHandler = (msg: TpsMessage): void => {
    if (msg.type !== MSG_SERVICE_RESPONSE) return;
    const body = msg.body as HttpResponseBody;
    const entry = pending.get(body.reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(body.reqId);
    entry.resolve(body);
  };
  channel.onMessage(responseHandler);

  const servers: Server[] = [];
  const handles: ServiceProxyHandle[] = [];

  for (const svc of services) {
    const serviceName = svc.name;

    const server = createServer(async (req, res) => {
      const reqId = randomUUID();

      // Read and cap request body
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_BODY_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "request body too large" }));
          return;
        }
        chunks.push(buf);
      }
      const bodyStr = Buffer.concat(chunks).toString("utf-8");
      const path = req.url ?? "/";

      // Validate path
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid proxy path" }));
        return;
      }

      // Forward headers (flat string values only)
      const headers = Object.fromEntries(
        Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, v] as const] : [],
        ),
      );

      const proxyReq: HttpRequestBody = {
        reqId,
        service: serviceName,
        method: req.method ?? "GET",
        path,
        headers,
        body: bodyStr || undefined,
      };

      try {
        const response = await new Promise<HttpResponseBody>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(reqId);
            reject(new Error("proxy timeout"));
          }, DEFAULT_TIMEOUT_MS);

          pending.set(reqId, { resolve, reject, timer });
          void channel.send({
            type: MSG_SERVICE_REQUEST,
            seq: 0,
            ts: new Date().toISOString(),
            body: proxyReq,
          }).catch((err) => {
            clearTimeout(timer);
            pending.delete(reqId);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        });

        res.writeHead(response.status, response.headers);
        res.end(response.body ?? "");
      } catch {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `proxy error: ${serviceName}` }));
      }
    });

    server.listen(svc.localPort, "127.0.0.1");
    servers.push(server);
    handles.push({
      name: serviceName,
      port: svc.localPort,
      close: () => server.close(),
    });
  }

  const failAll = () => {
    for (const [reqId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("tunnel disconnected"));
      pending.delete(reqId);
    }
  };

  const close = () => {
    channel.offMessage(responseHandler);
    failAll();
    for (const server of servers) {
      try { server.close(); } catch {}
    }
  };

  return { handles, failAll, close };
}
