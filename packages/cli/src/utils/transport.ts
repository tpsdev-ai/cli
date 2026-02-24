import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DeliveryTransport {
  deliver(envelope: MailEnvelope): Promise<DeliveryResult>;
  name(): string;
}

export interface MailEnvelope {
  from: string;
  to: string;
  office?: string;
  body: Buffer;
  headers: Record<string, string>;
}

export interface DeliveryResult {
  delivered: boolean;
  transport: string;
  path?: string;
  error?: string;
}

// Wire transport abstractions (ops-24.3)
export interface BranchTarget {
  host: string;
  port: number;
  branchId: string;
  hostPublicKey: Uint8Array; // known host static key for IK
}

export interface TpsMessage {
  type: number;
  seq: number;
  ts: string;
  body: unknown;
  sig?: string;
}

export interface TransportChannel {
  send(msg: TpsMessage): Promise<void>;
  onMessage(handler: (msg: TpsMessage) => void): void;
  offMessage(handler: (msg: TpsMessage) => void): void;
  close(): Promise<void>;
  isAlive(): boolean;
  peerFingerprint(): string;
}

export interface TransportServer {
  onConnection(handler: (channel: TransportChannel) => void): void;
  close(): Promise<void>;
}

export interface WireTransport {
  connect(target: BranchTarget): Promise<TransportChannel>;
  listen(port: number): Promise<TransportServer>;
}

export class TransportRegistry {
  private perBranch = new Map<string, DeliveryTransport>();

  constructor(private readonly defaultTransport: DeliveryTransport) {}

  register(branchId: string, transport: DeliveryTransport): void {
    this.perBranch.set(branchId, transport);
  }

  unregister(branchId: string): void {
    this.perBranch.delete(branchId);
  }

  resolve(branchId: string): DeliveryTransport {
    return this.perBranch.get(branchId) ?? this.defaultTransport;
  }

  getDefault(): DeliveryTransport {
    return this.defaultTransport;
  }

  has(branchId: string): boolean {
    return this.perBranch.has(branchId);
  }
}

export function resolveTransport(recipientId: string, registry: TransportRegistry): DeliveryTransport {
  return registry.resolve(recipientId);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function atomicWriteJson(targetPath: string, data: unknown): void {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, targetPath);
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hostMailRoot(): string {
  return process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
}

export class FileSystemTransport implements DeliveryTransport {
  name(): string {
    return "filesystem";
  }

  async deliver(envelope: MailEnvelope): Promise<DeliveryResult> {
    try {
      const recipientNew = join(hostMailRoot(), envelope.to, "new");
      ensureDir(recipientNew);

      const payload = {
        id: envelope.headers["x-tps-id"] || randomUUID(),
        from: envelope.from,
        to: envelope.to,
        body: envelope.body.toString("utf-8"),
        timestamp: envelope.headers["x-tps-timestamp"] || new Date().toISOString(),
        read: false,
        origin: envelope.headers["x-tps-origin"] || "docker-sandbox",
      };

      const filename = `${timestampPrefix()}-${randomUUID()}.json`;
      const outPath = join(recipientNew, filename);
      atomicWriteJson(outPath, payload);
      return { delivered: true, transport: this.name(), path: outPath };
    } catch (e: any) {
      return {
        delivered: false,
        transport: this.name(),
        error: e?.message || "delivery failed",
      };
    }
  }
}
