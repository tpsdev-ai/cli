import type { TransportChannel, TpsMessage } from "./transport.js";
import { MSG_HTTP_REQUEST, MSG_HTTP_RESPONSE, type HttpRequestBody, type HttpResponseBody } from "./wire-mail.js";

const FLAIR_URL = (process.env.FLAIR_URL || "http://127.0.0.1:9926").replace(/\/$/, "");
const FLAIR_ORIGIN = new URL(FLAIR_URL).origin;
const HOP_BY_HOP_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade"]);

export function registerFlairProxyHandler(channel: TransportChannel): void {
  channel.onMessage(async (msg: TpsMessage) => {
    if (msg.type !== MSG_HTTP_REQUEST) return;
    const req = msg.body as HttpRequestBody;

    const sendResponse = async (body: HttpResponseBody) => {
      await channel.send({
        type: MSG_HTTP_RESPONSE,
        seq: 0,
        ts: new Date().toISOString(),
        body,
      });
    };

    if (!req.path.startsWith("/") || req.path.startsWith("//") || req.path.includes("..")) {
      await sendResponse({
        reqId: req.reqId,
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "invalid proxy path" }),
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.path, FLAIR_URL);
    } catch {
      await sendResponse({
        reqId: req.reqId,
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "invalid proxy path" }),
      });
      return;
    }

    if (url.origin !== FLAIR_ORIGIN) {
      await sendResponse({
        reqId: req.reqId,
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "invalid proxy path" }),
      });
      return;
    }

    const sanitizedHeaders = Object.fromEntries(
      Object.entries(req.headers)
        .filter(([key]) => !HOP_BY_HOP_HEADERS.has(key.toLowerCase()))
        .map(([key, value]) => [key, value]),
    );
    sanitizedHeaders.host = "localhost:9926";

    try {
      const response = await fetch(url.toString(), {
        method: req.method,
        headers: sanitizedHeaders,
        body: req.body ?? undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      await sendResponse({
        reqId: req.reqId,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      });
    } catch (error) {
      await sendResponse({
        reqId: req.reqId,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: String(error) }),
      });
    }
  });
}
