import { createServer, type Server as HttpServer } from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
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
import { handleGithubWebhook } from "./github-webhook.js";

const PROLOGUE = Buffer.from("tps-v1");
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 1024 * 1024 + 64;
const WS_PATH = "/tps/wire";

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => Buffer.from(d)));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as any);
}

function waitForMessage(ws: WebSocket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off("close", onClose);
      ws.off("error", onErr);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket message timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onClose = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("WebSocket closed before message received"));
    };
    const onErr = (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    };

    ws.once("message", (data) => {
      clearTimeout(timer);
      cleanup();
      resolve(toBuffer(data));
    });
    ws.once("close", onClose);
    ws.once("error", onErr);
  });
}

class WsNoiseChannel implements TransportChannel {
  private alive = true;
  private emitter = new EventEmitter();

  constructor(
    private readonly ws: WebSocket,
    private readonly sendCipher: Cipher,
    private readonly recvCipher: Cipher,
    private readonly peerFp: string
  ) {
    ws.on("close", () => {
      this.alive = false;
    });

    ws.on("message", (data) => {
      try {
        const raw = toBuffer(data);
        if (raw.length > MAX_MESSAGE_BYTES) {
          ws.close(1008, "rejected");
          return;
        }
        const decrypted = Buffer.from(this.recvCipher.decrypt(raw));
        const msg = decodeWireMessage(decrypted);
        this.emitter.emit("message", msg);
      } catch {
        ws.close(1008, "rejected");
      }
    });
  }

  async send(msg: TpsMessage): Promise<void> {
    const wire = encodeWireMessage(msg);
    const encrypted = Buffer.from(this.sendCipher.encrypt(wire));
    await new Promise<void>((resolve, reject) => {
      this.ws.send(encrypted, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: (msg: TpsMessage) => void): void {
    this.emitter.on("message", handler);
  }

  offMessage(handler: (msg: TpsMessage) => void): void {
    this.emitter.off("message", handler);
  }

  async close(): Promise<void> {
    this.ws.close();
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive && this.ws.readyState === WebSocket.OPEN;
  }

  peerFingerprint(): string {
    return this.peerFp;
  }
}

class WsNoiseServer implements TransportServer {
  private onConn: ((channel: TransportChannel) => void) | null = null;

  constructor(private readonly httpServer: HttpServer, private readonly wss: WebSocketServer) {}

  port(): number {
    const addr = this.httpServer.address();
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
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export class WsNoiseTransport implements WireTransport {
  constructor(
    private readonly localKeyPair: TpsKeyPair,
    private readonly hostKeyPair?: TpsKeyPair
  ) {}

  async listen(port: number): Promise<TransportServer> {
    const host = this.hostKeyPair ?? this.localKeyPair;
    const httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
    const wrapper = new WsNoiseServer(httpServer, wss);

    const hostStatic = {
      publicKey: Buffer.from(host.encryption.publicKey),
      secretKey: Buffer.from(host.encryption.privateKey),
    };

    wss.on("connection", async (ws) => {
      try {
        const responder = new Noise("IK", false, hostStatic);
        responder.initialise(PROLOGUE);

        const msg1 = await waitForMessage(ws, HANDSHAKE_TIMEOUT_MS);
        const payload = Buffer.from(responder.recv(msg1));
        const branchId = payload.toString("utf-8");

        const known = lookupBranch(branchId);
        const expected = known?.encryptionKey ? Buffer.from(known.encryptionKey) : null;
        const got = Buffer.from(responder.rs);
        if (!expected || !got.equals(expected)) {
          ws.close(1008, "rejected");
          return;
        }

        const msg2 = Buffer.from(responder.send());
        ws.send(msg2);

        const channel = new WsNoiseChannel(
          ws,
          new Cipher(responder.tx),
          new Cipher(responder.rx),
          fingerprint(got)
        );
        wrapper.dispatch(channel);
      } catch {
        ws.close(1008, "rejected");
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(port, "0.0.0.0", () => resolve());
      httpServer.once("error", reject);
    });

    return wrapper;
  }

  async connect(target: BranchTarget): Promise<TransportChannel> {
    const isLocal = target.host === "localhost" || target.host === "127.0.0.1" || target.host === "::1";
    const scheme = isLocal ? "ws" : "wss";
    const url = `${scheme}://${target.host}:${target.port}${WS_PATH}`;
    const ws = new WebSocket(url);

    // Track early close from server (rejection before handshake completes)
    let earlyClose = false;
    let earlyCloseReject: ((err: Error) => void) | null = null;
    
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // Attach close handler IMMEDIATELY after open, before any handshake
    ws.on("close", () => {
      earlyClose = true;
      earlyCloseReject?.(new Error("Connection rejected by server"));
    });

    const localStatic = {
      publicKey: Buffer.from(this.localKeyPair.encryption.publicKey),
      secretKey: Buffer.from(this.localKeyPair.encryption.privateKey),
    };

    const initiator = new Noise("IK", true, localStatic);
    initiator.initialise(PROLOGUE, Buffer.from(target.hostPublicKey));

    const msg1 = Buffer.from(initiator.send(Buffer.from(target.branchId)));
    ws.send(msg1);

    // Wait for msg2 OR early close
    let msg2: Buffer;
    try {
      msg2 = await new Promise<Buffer>((resolve, reject) => {
        if (earlyClose) { reject(new Error("Connection rejected by server")); return; }
        earlyCloseReject = reject;
        
        const timer = setTimeout(() => {
          reject(new Error(`Handshake timeout after ${HANDSHAKE_TIMEOUT_MS}ms`));
        }, HANDSHAKE_TIMEOUT_MS);
        
        ws.once("message", (data) => {
          clearTimeout(timer);
          earlyCloseReject = null;
          resolve(toBuffer(data));
        });
      });
    } catch (e) {
      ws.close(1008, "rejected");
      throw e;
    }
    initiator.recv(msg2);

    const gotHost = Buffer.from(initiator.rs);
    const expectedHost = Buffer.from(target.hostPublicKey);
    if (!gotHost.equals(expectedHost)) {
      ws.close(1008, "rejected");
      throw new Error("Host key mismatch after Noise_IK handshake");
    }

    return new WsNoiseChannel(
      ws,
      new Cipher(initiator.tx),
      new Cipher(initiator.rx),
      fingerprint(gotHost)
    );
  }
}

export async function listenForJoinWs(
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
  // Join-mode WS server: raw Noise_IK handshake without registry lookup.
  // Analogous to listenForJoin() in noise-ik-transport.ts.
  const httpServer = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

  const branchStatic = {
    publicKey: Buffer.from(branchKeyPair.encryption.publicKey),
    secretKey: Buffer.from(branchKeyPair.encryption.privateKey),
  };

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", () => resolve());
  });

  // Wrap as a TransportServer (for close(); onConnection not used in join mode)
  const serverWrapper: TransportServer = {
    onConnection: () => {},
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  const joined = new Promise<{
    channel: TransportChannel;
    hostPubkey: Uint8Array;
    hostFingerprint: string;
    hostId: string;
  }>((resolve, reject) => {
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => reject(new Error("JOIN_COMPLETE timeout")), timeoutMs)
        : null;

    wss.once("connection", async (ws) => {
      try {
        const responder = new Noise("IK", false, branchStatic);
        responder.initialise(PROLOGUE);

        const msg1 = await waitForMessage(ws, HANDSHAKE_TIMEOUT_MS);
        responder.recv(msg1);

        const msg2 = Buffer.from(responder.send());
        ws.send(msg2);

        const channel = new WsNoiseChannel(
          ws,
          new Cipher(responder.tx),
          new Cipher(responder.rx),
          fingerprint(Buffer.from(responder.rs))
        );

        const handler = (msg: TpsMessage) => {
          if (msg.type !== MSG_JOIN_COMPLETE) return;
          const parsed = JoinCompleteBodySchema.safeParse(msg.body);
          if (!parsed.success) return;

          const hostPub = new Uint8Array(Buffer.from(parsed.data.hostPubkey, "base64url"));
          const fp = fingerprint(hostPub);
          const claimed = parsed.data.hostFingerprint.replace(/^sha256:/, "");
          if (fp !== claimed) {
            channel.offMessage(handler);
            reject(new Error("Host fingerprint mismatch in JOIN_COMPLETE"));
            return;
          }
          if (timeout) clearTimeout(timeout);
          channel.offMessage(handler);
          resolve({ channel, hostPubkey: hostPub, hostFingerprint: fp, hostId: parsed.data.hostId });
        };

        channel.onMessage(handler);
      } catch (e) {
        ws.close(1011, "handshake failed");
        reject(e);
      }
    });
  });

  const result = await joined;
  return { ...result, server: serverWrapper };
}

export async function listenForHostWs(
  branchKeyPair: TpsKeyPair,
  expectedHostPubkey: Uint8Array,
  port: number,
  onMessage: (msg: TpsMessage, channel: TransportChannel) => void | Promise<void>
): Promise<TransportServer> {
  // Branch-side persistent listener: raw Noise_IK handshake without registry lookup.
  // After handshake, verify peer is the pinned host key.
  const httpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/github/webhook") {
      handleGithubWebhook(req, res).catch((e: Error) => {
        res.statusCode = 500;
        res.end("Internal error");
        console.error("[webhook] error:", e.message);
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

  const branchStatic = {
    publicKey: Buffer.from(branchKeyPair.encryption.publicKey),
    secretKey: Buffer.from(branchKeyPair.encryption.privateKey),
  };

  wss.on("connection", async (ws) => {
    try {
      const responder = new Noise("IK", false, branchStatic);
      responder.initialise(PROLOGUE);

      const msg1 = await waitForMessage(ws, HANDSHAKE_TIMEOUT_MS);
      responder.recv(msg1); // payload = branchId sent by host (ignored here)

      const peerKey = Buffer.from(responder.rs);
      if (!peerKey.equals(Buffer.from(expectedHostPubkey))) {
        ws.close(1008, "rejected");
        return;
      }

      const msg2 = Buffer.from(responder.send());
      ws.send(msg2);

      const channel = new WsNoiseChannel(
        ws,
        new Cipher(responder.tx),
        new Cipher(responder.rx),
        fingerprint(Buffer.from(responder.rs))
      );
      channel.onMessage((msg) => onMessage(msg, channel));
    } catch {
      ws.close(1011, "handshake failed");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", () => resolve());
  });

  return {
    onConnection: () => {},
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
