import type { TransportChannel, TpsMessage } from "./transport.js";
import { MSG_HTTP_REQUEST, MSG_HTTP_RESPONSE, type HttpRequestBody, type HttpResponseBody } from "./wire-mail.js";

const FLAIR_URL = (process.env.FLAIR_URL || "http://127.0.0.1:9926").replace(/\/$/, "");

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

    if (!req.path.startsWith("/") || req.path.startsWith("//") || /^https?:/i.test(req.path)) {
      await sendResponse({
        reqId: req.reqId,
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "invalid proxy path" }),
      });
      return;
    }

    try {
      const response = await fetch(`${FLAIR_URL}${req.path}`, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? undefined,
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
