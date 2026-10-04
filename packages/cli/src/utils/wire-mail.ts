import { z } from "zod";

export const MSG_MAIL_DELIVER = 0x01;
export const MSG_MAIL_ACK = 0x02;
export const MSG_JOIN_COMPLETE = 0x0f;
export const MSG_HEARTBEAT = 0x10;
export const MSG_HTTP_REQUEST = 0x20;
export const MSG_HTTP_RESPONSE = 0x21;

const SAFE_ID = /^[a-zA-Z0-9._-]{1,64}$/;

/** A relayed delivery id: a UUID, or the 64-hex id of a GitHub-webhook outbox record (outbox.ts). */
const DeliveryIdSchema = z.union([z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/)]);

export const MailDeliverBodySchema = z.object({
  id: DeliveryIdSchema,
  from: z.string().regex(SAFE_ID, "Invalid sender identifier"),
  to: z.string().regex(SAFE_ID, "Invalid recipient identifier"),
  content: z.string(),
  timestamp: z.string().min(1),
});
export type MailDeliverBody = z.infer<typeof MailDeliverBodySchema>;

export const MailAckBodySchema = z.object({
  id: DeliveryIdSchema,
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type MailAckBody = z.infer<typeof MailAckBodySchema>;

// Re-export as canonical spec names (same wire codes)
export const MSG_SERVICE_REQUEST = MSG_HTTP_REQUEST;
export const MSG_SERVICE_RESPONSE = MSG_HTTP_RESPONSE;

export const JoinCompleteBodySchema = z.object({
  hostPubkey: z.string(),
  hostFingerprint: z.string(),
  hostId: z.string(),
  // OPS-122: advertised services — branch starts a local proxy for each
  services: z.array(z.object({
    name: z.string().min(1),
    localPort: z.number().int().positive(),
    description: z.string().optional(),
  })).optional(),
});
export type JoinCompleteBody = z.infer<typeof JoinCompleteBodySchema>;

export const HttpRequestBodySchema = z.object({
  reqId: z.string().uuid(),
  service: z.string().min(1).optional(), // OPS-122: target service name
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});
export type HttpRequestBody = z.infer<typeof HttpRequestBodySchema>;

export const HttpResponseBodySchema = z.object({
  reqId: z.string().uuid(),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});
export type HttpResponseBody = z.infer<typeof HttpResponseBodySchema>;
