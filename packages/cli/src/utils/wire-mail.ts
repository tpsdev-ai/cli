import { z } from "zod";

export const MSG_MAIL_DELIVER = 0x01;
export const MSG_MAIL_ACK = 0x02;
export const MSG_JOIN_COMPLETE = 0x0f;
export const MSG_HEARTBEAT = 0x10;
export const MSG_HTTP_REQUEST = 0x20;
export const MSG_HTTP_RESPONSE = 0x21;

const SAFE_ID = /^[a-zA-Z0-9._-]{1,64}$/;

// Zod 3's datetime grammar, kept here because Zod 4's z.iso.datetime rejects a
// timestamp with the seconds omitted or an offset written without its colon.
const Zod3Datetime = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const IsoInstantSchema = z.union([
  z
    .string()
    .regex(Zod3Datetime)
    .refine((value) => Number.isFinite(Date.parse(value))),
  z.string().regex(/^[+-]\d{6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }),
]);

/** A relayed delivery id: a UUID, or the 64-hex id of a GitHub-webhook outbox record (outbox.ts). */
const DeliveryIdSchema = z.union([z.guid(), z.string().regex(/^[a-f0-9]{64}$/)]);

export const MailDeliverBodySchema = z.object({
  id: DeliveryIdSchema,
  from: z.string().regex(SAFE_ID, "Invalid sender identifier"),
  to: z.string().regex(SAFE_ID, "Invalid recipient identifier"),
  content: z.string(),
  timestamp: z.string().max(35, "Invalid relay timestamp").refine((value) => IsoInstantSchema.safeParse(value).success, "Invalid relay timestamp"),
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
  reqId: z.guid(),
  service: z.string().min(1).optional(), // OPS-122: target service name
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});
export type HttpRequestBody = z.infer<typeof HttpRequestBodySchema>;

export const HttpResponseBodySchema = z.object({
  reqId: z.guid(),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});
export type HttpResponseBody = z.infer<typeof HttpResponseBodySchema>;
