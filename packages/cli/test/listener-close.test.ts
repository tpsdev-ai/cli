import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import Noise from "noise-handshake/noise.js";
import Cipher from "noise-handshake/cipher.js";
import { fingerprint, generateKeyPair, registerBranch, type TpsKeyPair } from "../src/utils/identity.js";
import { listenForHost, NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { listenForJoinWs, WsNoiseTransport } from "../src/utils/ws-noise-transport.js";
import { encodeWireMessage } from "../src/utils/wire-frame.js";
import { MSG_JOIN_COMPLETE } from "../src/utils/wire-mail.js";

const PROLOGUE = Buffer.from("tps-v1");
const WS_PATH = "/tps/wire";

const CLOSE_BOUND_MS = 3000;
const REPEAT_BOUND_MS = 1000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** Resolve `promise`, or reject with a named error if it does not settle in `ms`. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not resolve within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A best-effort teardown that never hangs the test process. */
async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await within(promise, REPEAT_BOUND_MS, "cleanup");
  } catch {
    /* the assertion under test already reported the state */
  }
}

/** The port is free to listen on again after the listener closed. */
async function expectPortReusable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close((err) => (err ? reject(err) : resolve())));
  });
}

/** Wait until the listener accepts TCP connections (it is listening), bounded. */
async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = net.createConnection({ host: "127.0.0.1", port });
        probe.once("connect", () => {
          probe.destroy();
          resolve();
        });
        probe.once("error", reject);
      });
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("listener never accepted a connection");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("transport listener close()", () => {
  let root: string;
  let cleanups: Array<() => Promise<void> | void>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-listener-close-"));
    process.env.HOME = root;
    process.env.TPS_VAULT_KEY = "listener-close-test";
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
    cleanups = [];
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    }
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.TPS_VAULT_KEY;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
  });

  test("TCP branch listener (listenForHost) close settles with a peer, is idempotent, frees the port", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    const port = await freePort();
    const server = await listenForHost(branch, host.encryption.publicKey, port, () => {});
    cleanups.push(() => settle(server.close()));

    const client = new NoiseIkTransport(host);
    const channel = await client.connect({
      host: "127.0.0.1",
      port,
      branchId: "local",
      hostPublicKey: branch.encryption.publicKey,
    });
    cleanups.push(() => settle(channel.close()));
    expect(channel.isAlive()).toBe(true);

    await within(server.close(), CLOSE_BOUND_MS, "close with a peer connected");
    await within(server.close(), REPEAT_BOUND_MS, "second close");
    await expectPortReusable(port);
  }, 20_000);

  test("TCP host listener (NoiseIkTransport.listen) close settles with a peer, is idempotent, frees the port", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch-a", branch.signing.publicKey, undefined, branch.encryption.publicKey);
    const port = await freePort();
    const server = await new NoiseIkTransport(branch, host).listen(port);
    cleanups.push(() => settle(server.close()));

    const channel = await new NoiseIkTransport(branch).connect({
      host: "127.0.0.1",
      port,
      branchId: "branch-a",
      hostPublicKey: host.encryption.publicKey,
    });
    cleanups.push(() => settle(channel.close()));
    expect(channel.isAlive()).toBe(true);

    await within(server.close(), CLOSE_BOUND_MS, "close with a peer connected");
    await within(server.close(), REPEAT_BOUND_MS, "second close");
    await expectPortReusable(port);
  }, 20_000);

  test("WS host listener (WsNoiseServer) close settles with a peer, is idempotent, frees the port", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch-b", branch.signing.publicKey, undefined, branch.encryption.publicKey);
    const port = await freePort();
    const server = await new WsNoiseTransport(host, host).listen(port);
    cleanups.push(() => settle(server.close()));

    const channel = await new WsNoiseTransport(branch).connect({
      host: "127.0.0.1",
      port,
      branchId: "branch-b",
      hostPublicKey: host.encryption.publicKey,
    });
    cleanups.push(() => settle(channel.close()));
    expect(channel.isAlive()).toBe(true);

    await within(server.close(), CLOSE_BOUND_MS, "close with a peer connected");
    await within(server.close(), REPEAT_BOUND_MS, "second close");
    await expectPortReusable(port);
  }, 20_000);

  test("WS host listener close settles after a rejected handshake, is idempotent, frees the port", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    const port = await freePort();
    const server = await new WsNoiseTransport(host, host).listen(port);
    cleanups.push(() => settle(server.close()));

    // Not registered: the listener rejects the handshake and closes the socket.
    await expect(
      new WsNoiseTransport(branch).connect({
        host: "127.0.0.1",
        port,
        branchId: "unknown-branch",
        hostPublicKey: host.encryption.publicKey,
      })
    ).rejects.toThrow();

    await within(server.close(), CLOSE_BOUND_MS, "close after a rejected handshake");
    await within(server.close(), REPEAT_BOUND_MS, "second close");
    await expectPortReusable(port);
  }, 20_000);

  test("join WS listener (listenForJoinWs) close settles with a peer, is idempotent, frees the port", async () => {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    const port = await freePort();
    const joined = await (async () => {
      const joining = listenForJoinWs(branch, port, 10_000);
      await waitForPort(port);
      const socket = await joinAsHost(port, branch, host);
      cleanups.push(() => {
        try {
          socket.terminate();
        } catch {
          /* best effort */
        }
      });
      return joining;
    })();
    cleanups.push(() => settle(joined.server.close()));
    expect(joined.hostId).toBe("host");

    await within(joined.server.close(), CLOSE_BOUND_MS, "close with a peer connected");
    await within(joined.server.close(), REPEAT_BOUND_MS, "second close");
    await expectPortReusable(port);
  }, 20_000);
});

interface RawJoinSocket {
  terminate: () => void;
}

/**
 * Complete the join-mode Noise_IK handshake as the host, then send
 * JOIN_COMPLETE. This is the real peer on the wire: a genuine Noise handshake
 * and an encrypted wire frame.
 *
 * The listener registers its `once("connection")` handler only after its
 * `listen` callback fires, which under bun can lag the port accepting
 * connections; a WebSocket frame that arrives before the listener reads is not
 * buffered. Each attempt opens a fresh socket and runs the handshake, retrying
 * within a bound until the listener handles it.
 */
async function joinAsHost(port: number, branch: TpsKeyPair, host: TpsKeyPair): Promise<RawJoinSocket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const initiator = new Noise("IK", true, {
        publicKey: Buffer.from(host.encryption.publicKey),
        secretKey: Buffer.from(host.encryption.privateKey),
      });
      initiator.initialise(PROLOGUE, Buffer.from(branch.encryption.publicKey));
      socket.send(Buffer.from(initiator.send(Buffer.from("local"))));

      const msg2 = await within(
        new Promise<Buffer>((resolve, reject) => {
          socket.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer)));
          socket.once("error", reject);
        }),
        REPEAT_BOUND_MS,
        "join handshake msg2"
      );
      initiator.recv(msg2);

      const cipher = new Cipher(initiator.tx);
      socket.send(
        Buffer.from(
          cipher.encrypt(
            encodeWireMessage({
              type: MSG_JOIN_COMPLETE,
              seq: 1,
              ts: new Date().toISOString(),
              body: {
                hostPubkey: Buffer.from(host.encryption.publicKey).toString("base64url"),
                hostFingerprint: fingerprint(host.encryption.publicKey),
                hostId: "host",
              },
            })
          )
        )
      );

      return { terminate: () => socket.terminate() };
    } catch (error) {
      lastError = error;
      try {
        socket.terminate();
      } catch {
        /* best effort */
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("join handshake never completed");
}
