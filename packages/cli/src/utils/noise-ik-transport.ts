/**
 * Noise_IK encrypted transport — mutual authentication + encrypted channel.
 * Uses X25519 static keys from TPS identity for IK pattern.
 */
import net, { type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import Noise from "noise-handshake/noise.js";
import Cipher from "noise-handshake/cipher.js";
import {
  type BranchTarget,
  type TransportChannel,
  type TransportServer,
  type TpsMessage,
  type WireTransport,
} from "./transport.js";
import { decodeWireMessage, encodeWireMessage } from "./wire-frame.js";
import { fingerprint, loadHostIdentity, lookupBranch, type TpsKeyPair } from "./identity.js";
import { JoinCompleteBodySchema, MSG_JOIN_COMPLETE } from "./wire-mail.js";

const PROLOGUE = Buffer.from("tps-v1");
const MAX_HANDSHAKE_BYTES = 512;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_ENCRYPTED_FRAME = 1024 * 1024 + 64;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        onTimeout();
      } catch {}
      reject(new Error(`Handshake timeout after ${ms}ms`));
    }, ms);

    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// 2-byte BE length prefix + payload
async function writeFrame(socket: Socket, data: Buffer): Promise<void> {
  if (data.length > 0xffff) {
    throw new Error(`Frame too large for 2-byte length prefix: ${data.length}`);
  }
  const header = Buffer.alloc(2);
  header.writeUInt16BE(data.length, 0);
  await new Promise<void>((resolve, reject) => {
    socket.write(Buffer.concat([header, data]), (err) => (err ? reject(err) : resolve()));
  });
}

async function readFrame(socket: Socket, maxBytes = MAX_HANDSHAKE_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buf = Buffer.alloc(0);

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
      buf = Buffer.concat([buf, chunk]);

      if (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (len > maxBytes) {
          cleanup();
          socket.destroy();
          reject(new Error(`Frame too large: ${len} > ${maxBytes}`));
          return;
        }

        if (buf.length >= 2 + len) {
          const frame = buf.subarray(2, 2 + len);
          cleanup();
          resolve(frame);
        }
      }
    };

    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
    socket.once("end", onClose);
  });
}

class NoiseIkChannel implements TransportChannel {
  private alive = true;
  private emitter = new EventEmitter();
  private rxBuffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: Socket,
    private readonly sendCipher: Cipher,
    private readonly recvCipher: Cipher,
    private readonly peerFp: string
  ) {
    this.socket.on("close", () => {
      this.alive = false;
    });

    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        if (this.rxBuffer.length > MAX_ENCRYPTED_FRAME) {
          this.socket.destroy();
          return;
        }

        let offset = 0;
        while (offset + 2 <= this.rxBuffer.length) {
          const len = this.rxBuffer.readUInt16BE(offset);
          if (len > MAX_ENCRYPTED_FRAME) {
            this.socket.destroy();
            return;
          }
          if (offset + 2 + len > this.rxBuffer.length) break;

          const encrypted = this.rxBuffer.subarray(offset + 2, offset + 2 + len);
          const decrypted = Buffer.from(this.recvCipher.decrypt(encrypted));
          const msg = decodeWireMessage(decrypted);
          this.emitter.emit("message", msg);

          offset += 2 + len;
        }

        this.rxBuffer = this.rxBuffer.subarray(offset);
      } catch {
        this.socket.destroy();
      }
    });
  }

  async send(msg: TpsMessage): Promise<void> {
    const wireFrame = encodeWireMessage(msg);
    const encrypted = Buffer.from(this.sendCipher.encrypt(wireFrame));
    await writeFrame(this.socket, encrypted);
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

class NoiseIkServer implements TransportServer {
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

export async function listenForJoin(
  branchKeyPair: TpsKeyPair,
  port: number,
  timeoutMs: number = 120_000
): Promise<{
  channel: TransportChannel;
  server: TransportServer;
  hostPubkey: Uint8Array;
  hostFingerprint: string;
  hostId: string;
}> {
  const server = net.createServer();
  const wrapper = new NoiseIkServer(server);

  const branchStatic = {
    publicKey: Buffer.from(branchKeyPair.encryption.publicKey),
    secretKey: Buffer.from(branchKeyPair.encryption.privateKey),
  };

  const joined = new Promise<{
    channel: TransportChannel;
    hostPubkey: Uint8Array;
    hostFingerprint: string;
    hostId: string;
  }>((resolve, reject) => {
    server.on("connection", async (socket) => {
      try {
        const responder = new Noise("IK", false, branchStatic);
        responder.initialise(PROLOGUE);

        const msg1 = await withTimeout(readFrame(socket), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
        responder.recv(msg1);

        const msg2 = Buffer.from(responder.send());
        await withTimeout(writeFrame(socket, msg2), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());

        const channel = new NoiseIkChannel(
          socket,
          new Cipher(responder.tx),
          new Cipher(responder.rx),
          fingerprint(Buffer.from(responder.rs))
        );

        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                socket.destroy();
                reject(new Error("JOIN_COMPLETE timeout"));
              }, timeoutMs)
            : null;

        const handler = (msg: TpsMessage) => {
          if (msg.type !== MSG_JOIN_COMPLETE) return;
          const parsed = JoinCompleteBodySchema.safeParse(msg.body);
          if (!parsed.success) return;

          const hostPub = new Uint8Array(Buffer.from(parsed.data.hostPubkey, "base64url"));
          const fp = fingerprint(hostPub);
          const claimed = parsed.data.hostFingerprint.replace(/^sha256:/, "");
          if (fp !== claimed) {
            if (timer) clearTimeout(timer);
            channel.offMessage(handler);
            socket.destroy();
            reject(new Error("Host fingerprint mismatch in JOIN_COMPLETE"));
            return;
          }

          if (timer) clearTimeout(timer);
          channel.offMessage(handler);
          resolve({
            channel,
            hostPubkey: hostPub,
            hostFingerprint: fp,
            hostId: parsed.data.hostId,
          });
        };

        channel.onMessage(handler);
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => resolve());
    server.once("error", reject);
  });

  const timeoutP =
    timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          setTimeout(() => {
            try {
              server.close();
            } catch {}
            reject(new Error("Join listener timeout"));
          }, timeoutMs);
        })
      : null;

  const result = timeoutP ? await Promise.race([joined, timeoutP]) : await joined;
  wrapper.dispatch(result.channel);
  return { ...result, server: wrapper };
}

export async function listenForHost(
  branchKeyPair: TpsKeyPair,
  expectedHostPubkey: Uint8Array,
  port: number,
  onMessage: (msg: TpsMessage, channel: TransportChannel) => void
): Promise<TransportServer> {
  const server = net.createServer();
  const wrapper = new NoiseIkServer(server);

  const branchStatic = {
    publicKey: Buffer.from(branchKeyPair.encryption.publicKey),
    secretKey: Buffer.from(branchKeyPair.encryption.privateKey),
  };

  server.on("connection", async (socket) => {
    try {
      const responder = new Noise("IK", false, branchStatic);
      responder.initialise(PROLOGUE);

      const msg1 = await withTimeout(readFrame(socket), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
      responder.recv(msg1);

      const got = Buffer.from(responder.rs);
      const expected = Buffer.from(expectedHostPubkey);
      if (!got.equals(expected)) {
        socket.destroy();
        return;
      }

      const msg2 = Buffer.from(responder.send());
      await withTimeout(writeFrame(socket, msg2), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());

      const channel = new NoiseIkChannel(
        socket,
        new Cipher(responder.tx),
        new Cipher(responder.rx),
        fingerprint(got)
      );

      channel.onMessage((msg) => onMessage(msg, channel));
      wrapper.dispatch(channel);
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => resolve());
    server.once("error", reject);
  });

  return wrapper;
}

export class NoiseIkTransport implements WireTransport {
  constructor(
    private readonly branchKeyPair: TpsKeyPair,
    private readonly hostKeyPair?: TpsKeyPair
  ) {}

  async listen(port: number): Promise<TransportServer> {
    const host = this.hostKeyPair ?? await loadHostIdentity();
    const server = net.createServer();
    const wrapper = new NoiseIkServer(server);

    const hostStatic = {
      publicKey: Buffer.from(host.encryption.publicKey),
      secretKey: Buffer.from(host.encryption.privateKey),
    };

    server.on("connection", async (socket) => {
      try {
        const responder = new Noise("IK", false, hostStatic);
        responder.initialise(PROLOGUE);

        const msg1 = await withTimeout(readFrame(socket), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
        const payload = Buffer.from(responder.recv(msg1));
        const branchId = payload.toString("utf-8");

        const known = lookupBranch(branchId);
        const expected = known?.encryptionKey ? Buffer.from(known.encryptionKey) : null;
        const got = Buffer.from(responder.rs);
        if (!expected || !got.equals(expected)) {
          socket.destroy();
          return;
        }

        const msg2 = Buffer.from(responder.send());
        await withTimeout(writeFrame(socket, msg2), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());

        const channel = new NoiseIkChannel(
          socket,
          new Cipher(responder.tx),
          new Cipher(responder.rx),
          fingerprint(got)
        );
        wrapper.dispatch(channel);
      } catch {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, "0.0.0.0", () => resolve());
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

    const branchStatic = {
      publicKey: Buffer.from(this.branchKeyPair.encryption.publicKey),
      secretKey: Buffer.from(this.branchKeyPair.encryption.privateKey),
    };

    const initiator = new Noise("IK", true, branchStatic);
    initiator.initialise(PROLOGUE, Buffer.from(target.hostPublicKey));

    const msg1 = Buffer.from(initiator.send(Buffer.from(target.branchId)));
    await withTimeout(writeFrame(socket, msg1), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());

    const msg2 = await withTimeout(readFrame(socket), HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
    initiator.recv(msg2);

    const gotHost = Buffer.from(initiator.rs);
    const expectedHost = Buffer.from(target.hostPublicKey);
    if (!gotHost.equals(expectedHost)) {
      socket.destroy();
      throw new Error("Host key mismatch after Noise_IK handshake");
    }

    return new NoiseIkChannel(
      socket,
      new Cipher(initiator.tx),
      new Cipher(initiator.rx),
      fingerprint(gotHost)
    );
  }
}
