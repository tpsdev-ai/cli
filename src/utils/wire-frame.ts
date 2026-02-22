import { Packr, Unpackr } from "msgpackr";
import { z } from "zod";
import type { TpsMessage } from "./transport.js";

const packr = new Packr();
const unpackr = new Unpackr();

export const HEADER_BYTES = 6;
export const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1MB

const WireMessageSchema = z.object({
  type: z.number().int().min(0).max(0xffff),
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
  body: z.unknown(),
  sig: z.string().optional(),
});

export function encodeWireMessage(msg: TpsMessage): Buffer {
  const parsed = WireMessageSchema.parse(msg);
  const payload = Buffer.from(packr.pack(parsed));
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Wire payload exceeds maximum size (${MAX_PAYLOAD_BYTES} bytes)`);
  }

  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out.writeUInt16BE(parsed.type, 0);
  out.writeUInt32BE(payload.length, 2);
  payload.copy(out, HEADER_BYTES);
  return out;
}

export function decodeWireMessage(frame: Buffer): TpsMessage {
  if (frame.length < HEADER_BYTES) {
    throw new Error("Incomplete frame header");
  }

  const type = frame.readUInt16BE(0);
  const len = frame.readUInt32BE(2);
  if (len > MAX_PAYLOAD_BYTES) {
    throw new Error(`Wire payload exceeds maximum size (${MAX_PAYLOAD_BYTES} bytes)`);
  }
  if (frame.length !== HEADER_BYTES + len) {
    throw new Error("Invalid frame length");
  }

  const payload = frame.subarray(HEADER_BYTES);
  const decoded = unpackr.unpack(payload);
  const parsed = WireMessageSchema.parse({ ...(decoded as any), type });
  return {
    type: parsed.type,
    seq: parsed.seq,
    ts: parsed.ts,
    body: parsed.body,
    sig: parsed.sig,
  };
}

export function extractWireFrames(buffer: Buffer): { messages: TpsMessage[]; rest: Buffer } {
  const messages: TpsMessage[] = [];
  let offset = 0;

  while (offset + HEADER_BYTES <= buffer.length) {
    const len = buffer.readUInt32BE(offset + 2);
    if (len > MAX_PAYLOAD_BYTES) {
      throw new Error(`Wire payload exceeds maximum size (${MAX_PAYLOAD_BYTES} bytes)`);
    }
    const frameBytes = HEADER_BYTES + len;
    if (offset + frameBytes > buffer.length) break;

    const frame = buffer.subarray(offset, offset + frameBytes);
    messages.push(decodeWireMessage(frame));
    offset += frameBytes;
  }

  return { messages, rest: buffer.subarray(offset) };
}
