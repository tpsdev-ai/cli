import { z } from "zod";

export const MSG_MAIL_DELIVER = 0x01;
export const MSG_MAIL_ACK = 0x02;
export const MSG_JOIN_COMPLETE = 0x0f;
export const MSG_HEARTBEAT = 0x10;

const SAFE_ID = /^[a-zA-Z0-9._-]{1,64}$/;

export const MailDeliverBodySchema = z.object({
  id: z.string().uuid(),
  from: z.string().regex(SAFE_ID, "Invalid sender identifier"),
  to: z.string().regex(SAFE_ID, "Invalid recipient identifier"),
  content: z.string(),
  timestamp: z.string().min(1),
});
export type MailDeliverBody = z.infer<typeof MailDeliverBodySchema>;

export const MailAckBodySchema = z.object({
  id: z.string().uuid(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type MailAckBody = z.infer<typeof MailAckBodySchema>;

export const JoinCompleteBodySchema = z.object({
  hostPubkey: z.string(),
  hostFingerprint: z.string(),
  hostId: z.string(),
});
export type JoinCompleteBody = z.infer<typeof JoinCompleteBodySchema>;
