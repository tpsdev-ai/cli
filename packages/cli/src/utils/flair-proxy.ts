import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { TransportChannel, TpsMessage } from "./transport.js";
import { MSG_HTTP_REQUEST, MSG_HTTP_RESPONSE, type HttpRequestBody, type HttpResponseBody } from "./wire-mail.js";

const PROXY_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function startFlairProxy(port: number, channel: TransportChannel): { close: () => void } {
  const pending = new Map<string, {
    resolve: (res: HttpResponseBody) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const handler = (msg: TpsMessage): void => {
    if (msg.type !== MSG_HTTP_RESPONSE) return;
    const body = msg.body as HttpResponseBody;
    const entry = pending.get(body.reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(body.reqId);
    entry.resolve(body);
  };

  channel.onMessage(handler);

  const server = createServer(async (req, res) => {
    const reqId = randomUUID();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        return;
      }
      chunks.push(buffer);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");
    const path = req.url ?? "/";

    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid proxy path" }));
      return;
    }

    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) => {
        if (typeof value === "string") return [[key, value] as const];
        return [];
      }),
    );

    const proxyReq: HttpRequestBody = {
      reqId,
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
        }, PROXY_TIMEOUT_MS);

        pending.set(reqId, { resolve, reject, timer });
        void channel.send({
          type: MSG_HTTP_REQUEST,
          seq: 0,
          ts: new Date().toISOString(),
          body: proxyReq,
        }).catch((error) => {
          clearTimeout(timer);
          pending.delete(reqId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });

      res.writeHead(response.status, response.headers);
      res.end(response.body ?? "");
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "flair proxy timeout" }));
    }
  });

  server.listen(port, "127.0.0.1");

  return {
    close: () => {
      channel.offMessage(handler);
      for (const [reqId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("proxy closed"));
        pending.delete(reqId);
      }
      server.close();
    },
  };
}
