/**
 * WARNING: No encryption. Plain TCP with pubkey identity check.
 * Messages are transmitted in cleartext. Do NOT use over untrusted networks.
 * Real Noise_IK encryption will replace this before remote branch support ships.
 */
import net, { type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type {
  BranchTarget,
  TransportChannel,
  TransportServer,
  TpsMessage,
  WireTransport,
} from "./transport.js";
import { HEADER_BYTES, MAX_PAYLOAD_BYTES, extractWireFrames, encodeWireMessage } from "./wire-frame.js";
import { fingerprint, loadHostIdentity, lookupBranch, type TpsKeyPair } from "./identity.js";

interface HandshakeInit {
  kind: "noise_ik_init"; // TODO: replace with actual Noise_IK handshake
  branchId: string;
  branchPub: string;
}

interface HandshakeResp {
  kind: "noise_ik_resp"; // TODO: replace with actual Noise_IK handshake
  hostPub: string;
  peerFingerprint: string;
}

function readJsonLine(socket: Socket): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const MAX_HANDSHAKE_BYTES = 65536;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("close", onClose);
      socket.off("end", onClose);
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before complete frame"));
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (buf.length > MAX_HANDSHAKE_BYTES) {
        cleanup();
        socket.destroy();
        reject(new Error("Handshake message too large"));
        return;
      }
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        cleanup();
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch (e) {
          reject(e);
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
    socket.once("end", onClose);
  });
}

function writeJsonLine(socket: Socket, obj: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(obj)}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

class PlainTcpChannel implements TransportChannel {
  private alive = true;
  private emitter = new EventEmitter();
  private rxBuffer: Buffer = Buffer.alloc(0);

  constructor(private readonly socket: Socket, private readonly peerFp: string) {
    this.socket.on("close", () => {
      this.alive = false;
    });

    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.rxBuffer = Buffer.from(Buffer.concat([this.rxBuffer, chunk]));
        if (this.rxBuffer.length > MAX_PAYLOAD_BYTES + HEADER_BYTES) {
          this.socket.destroy();
          return;
        }
        const { messages, rest } = extractWireFrames(this.rxBuffer);
        this.rxBuffer = rest;
        for (const msg of messages) {
          this.emitter.emit("message", msg);
        }
      } catch {
        this.socket.destroy();
      }
    });
  }

  async send(msg: TpsMessage): Promise<void> {
    const frame = encodeWireMessage(msg);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: (msg: TpsMessage) => void): void {
    this.emitter.on("message", handler);
  }

  offMessage(handler: (msg: TpsMessage) => void): void {
    this.emitter.off("message", handler);
  }

  async close(): Promise<void> {
    this.socket.end();
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive && !this.socket.destroyed;
  }

  peerFingerprint(): string {
    return this.peerFp;
  }
}

class PlainTcpServer implements TransportServer {
  private onConn: ((channel: TransportChannel) => void) | null = null;

  constructor(private readonly server: Server) {}

  port(): number {
    const addr = this.server.address();
    if (!addr || typeof addr === "string") return 0;
    return addr.port;
  }

  onConnection(handler: (channel: TransportChannel) => void): void {
    this.onConn = handler;
  }

  dispatch(channel: TransportChannel): void {
    this.onConn?.(channel);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export class PlainTcpTransport implements WireTransport {
  constructor(
    private readonly branchKeyPair: TpsKeyPair,
    private readonly hostKeyPair?: TpsKeyPair
  ) {}

  async listen(port: number): Promise<TransportServer> {
    const host = this.hostKeyPair ?? await loadHostIdentity();
    const server = net.createServer();
    const wrapper = new PlainTcpServer(server);

    server.on("connection", async (socket) => {
      try {
        const init = (await readJsonLine(socket)) as HandshakeInit;
        if (init?.kind !== "noise_ik_init") {
          socket.destroy();
          return;
        }

        // WARNING: connection is NOT authenticated until Noise_IK handshake completes.
        // Do not trust branchId until post-handshake.
        const known = lookupBranch(init.branchId);
        const expectedPub = known?.publicKey ? Buffer.from(known.publicKey).toString("hex") : null;
        if (!expectedPub || expectedPub !== init.branchPub) {
          socket.destroy();
          return;
        }

        const branchFp = fingerprint(Buffer.from(init.branchPub, "hex"));
        await writeJsonLine(socket, {
          kind: "noise_ik_resp",
          hostPub: Buffer.from(host.signing.publicKey).toString("hex"),
          peerFingerprint: branchFp,
        } as HandshakeResp);

        wrapper.dispatch(new PlainTcpChannel(socket, branchFp));
      } catch {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    return wrapper;
  }

  async connect(target: BranchTarget): Promise<TransportChannel> {
    const socket = net.createConnection({ host: target.host, port: target.port });

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    await writeJsonLine(socket, {
      kind: "noise_ik_init",
      branchId: target.branchId,
      branchPub: Buffer.from(this.branchKeyPair.signing.publicKey).toString("hex"),
    } as HandshakeInit);

    const resp = (await readJsonLine(socket)) as HandshakeResp;
    if (resp?.kind !== "noise_ik_resp") {
      socket.destroy();
      throw new Error("Invalid handshake response message");
    }

    const expectedHostPub = Buffer.from(target.hostPublicKey).toString("hex");
    if (resp.hostPub !== expectedHostPub) {
      socket.destroy();
      throw new Error("Host key mismatch");
    }

    const hostFp = fingerprint(Buffer.from(resp.hostPub, "hex"));
    return new PlainTcpChannel(socket, hostFp);
  }
}
