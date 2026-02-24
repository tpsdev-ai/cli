import { randomUUID } from "node:crypto";
import type {
  DeliveryResult,
  DeliveryTransport,
  MailEnvelope,
  TpsMessage,
  TransportChannel,
} from "./transport.js";
import { MSG_MAIL_ACK, MSG_MAIL_DELIVER, MailAckBodySchema } from "./wire-mail.js";

export class WireDeliveryTransport implements DeliveryTransport {
  private seq = 0;

  constructor(
    private readonly channel: TransportChannel,
    private readonly timeoutMs: number = 5000
  ) {}

  name(): string {
    return "wire";
  }

  async deliver(envelope: MailEnvelope): Promise<DeliveryResult> {
    const id = envelope.headers["x-tps-id"] || randomUUID();

    const msg: TpsMessage = {
      type: MSG_MAIL_DELIVER,
      seq: this.seq++,
      ts: new Date().toISOString(),
      body: {
        id,
        from: envelope.from,
        to: envelope.to,
        content: envelope.body.toString("utf-8"),
        timestamp: envelope.headers["x-tps-timestamp"] || new Date().toISOString(),
      },
    };

    await this.channel.send(msg);

    return new Promise<DeliveryResult>((resolve) => {
      const handler = (ack: TpsMessage) => {
        if (ack.type !== MSG_MAIL_ACK) return;
        const parsed = MailAckBodySchema.safeParse(ack.body);
        if (!parsed.success || parsed.data.id !== id) return;

        clearTimeout(timer);
        this.channel.offMessage(handler);
        if (parsed.data.accepted) {
          resolve({ delivered: true, transport: this.name() });
        } else {
          resolve({
            delivered: false,
            transport: this.name(),
            error: parsed.data.reason || "rejected",
          });
        }
      };

      const timer = setTimeout(() => {
        this.channel.offMessage(handler);
        resolve({ delivered: false, transport: this.name(), error: "timeout" });
      }, this.timeoutMs);

      this.channel.onMessage(handler);
    });
  }
}
