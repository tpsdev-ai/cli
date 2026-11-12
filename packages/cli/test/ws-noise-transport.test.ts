import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, registerBranch } from "../src/utils/identity.js";
import { WsNoiseTransport, WsNoiseChannel } from "../src/utils/ws-noise-transport.js";
import { CHANNEL_CLOSE_GRACE_MS } from "../src/utils/transport.js";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { createPatchShared } from "./helpers/patch-shared.js";

const patchShared = createPatchShared();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.once("error", reject);
  });
}

describe("WsNoiseTransport", () => {
  let root: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-ws-noise-"));
    process.env.HOME = root;
    process.env.TPS_VAULT_KEY = "test-passphrase";
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.TPS_VAULT_KEY;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
  });

  test("handshake completes and encrypted messages round-trip", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("brancha", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const port = await freePort();
    const serverTransport = new WsNoiseTransport(host, host);
    const server = await serverTransport.listen(port);

    const recv = new Promise<string>((resolve) => {
      server.onConnection((ch) => {
        ch.onMessage((msg) => resolve((msg.body as any).text));
      });
    });

    const client = new WsNoiseTransport(branch);
    const ch = await client.connect({
      host: "127.0.0.1",
      port,
      branchId: "brancha",
      hostPublicKey: host.encryption.publicKey,
    });

    await ch.send({ type: 1, seq: 1, ts: new Date().toISOString(), body: { text: "hello-ws" } });
    expect(await recv).toBe("hello-ws");

    await ch.close();
    await server.close();
  });

  // NOTE: Bun test runner has issues with WebSocket close event propagation
  // from the `ws` npm package. These rejection tests work correctly when run
  // standalone (bun -e) but hang in bun test. Using subprocess to work around.
  test("unknown branch rejected", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("bun", ["-e", `
      import { generateKeyPair } from "./src/utils/identity.js";
      import { WsNoiseTransport } from "./src/utils/ws-noise-transport.js";
      import { mkdtempSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      const root = mkdtempSync(join(tmpdir(), "t-"));
      process.env.TPS_IDENTITY_DIR = join(root, "id");
      process.env.TPS_REGISTRY_DIR = join(root, "reg");
      const host = generateKeyPair();
      const branch = generateKeyPair();
      const net = await import("node:net");
      const port = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
          const addr = s.address();
          if (!addr || typeof addr === "string") return reject(new Error("no addr"));
          const p = addr.port;
          s.close(() => resolve(p));
        });
        s.once("error", reject);
      });
      const server = await new WsNoiseTransport(host, host).listen(port as number);
      try {
        await new WsNoiseTransport(branch).connect({
          host: "127.0.0.1", port, branchId: "unknown",
          hostPublicKey: host.encryption.publicKey,
        });
        process.exit(1);
      } catch { process.exit(0); }
      finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
    `], { cwd: process.cwd(), timeout: 30000, env: { ...process.env, HOME: root } });
    expect(result.status).toBe(0);
  }, 40000);

  test("wrong host key rejected", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("bun", ["-e", `
      import { generateKeyPair, registerBranch } from "./src/utils/identity.js";
      import { WsNoiseTransport } from "./src/utils/ws-noise-transport.js";
      import { mkdtempSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      const root = mkdtempSync(join(tmpdir(), "t-"));
      process.env.TPS_IDENTITY_DIR = join(root, "id");
      process.env.TPS_REGISTRY_DIR = join(root, "reg");
      const host = generateKeyPair();
      const wrongHost = generateKeyPair();
      const branch = generateKeyPair();
      registerBranch("branch2", branch.signing.publicKey, undefined, branch.encryption.publicKey);
      const net = await import("node:net");
      const port = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
          const addr = s.address();
          if (!addr || typeof addr === "string") return reject(new Error("no addr"));
          const p = addr.port;
          s.close(() => resolve(p));
        });
        s.once("error", reject);
      });
      const server = await new WsNoiseTransport(host, host).listen(port as number);
      try {
        await new WsNoiseTransport(branch).connect({
          host: "127.0.0.1", port, branchId: "branch2",
          hostPublicKey: wrongHost.encryption.publicKey,
        });
        process.exit(1);
      } catch { process.exit(0); }
      finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
    `], { cwd: process.cwd(), timeout: 30000, env: { ...process.env, HOME: root } });
    expect(result.status).toBe(0);
  }, 40000);

  test("wire data is encrypted (plaintext not visible in ws frames)", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch3", branch.signing.publicKey, undefined, branch.encryption.publicKey);
    const port = await freePort();

    const captured: Buffer[] = [];
    const origSend = (await import("ws")).WebSocket.prototype.send;
    const restoreSend = patchShared((await import("ws")).WebSocket.prototype, "send", function (this: any, data: any, ...args: any[]) {
      try { captured.push(Buffer.from(data)); } catch {}
      // @ts-ignore
      return origSend.call(this, data, ...args);
    } as typeof origSend);

    const server = await new WsNoiseTransport(host, host).listen(port);
    server.onConnection((ch) => {
      ch.onMessage(() => {});
    });

    const secret = "THIS-SHOULD-NOT-BE-PLAIN";
    const ch = await new WsNoiseTransport(branch).connect({
      host: "127.0.0.1",
      port,
      branchId: "branch3",
      hostPublicKey: host.encryption.publicKey,
    });
    await ch.send({ type: 1, seq: 1, ts: new Date().toISOString(), body: { text: secret } });

    const joined = Buffer.concat(captured).toString("utf-8");
    expect(joined).not.toContain(secret);

    restoreSend();
    await ch.close();
    await server.close();
  });

  test("a malformed msg2 fails connect and closes the ws", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch-malformed", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const sockets = new Set<net.Socket>();
    // A raw peer: completes the upgrade, answers with framed but undecryptable
    // bytes, and answers the client's close frame so the close completes.
    const peer = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("error", () => {});
      let inbound = Buffer.alloc(0);
      let upgraded = false;
      sock.on("data", (chunk) => {
        inbound = Buffer.concat([inbound, chunk]);
        if (!upgraded) {
          const end = inbound.indexOf("\r\n\r\n");
          if (end === -1) return;
          const headers = new Map<string, string>();
          for (const line of inbound.subarray(0, end).toString("latin1").split("\r\n").slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
          }
          const accept = createHash("sha1")
            .update(`${headers.get("sec-websocket-key") ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          sock.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          upgraded = true;
          inbound = inbound.subarray(end + 4);
          const garbage = Buffer.alloc(64, 0xff);
          sock.write(Buffer.concat([Buffer.from([0x82, garbage.length]), garbage]));
        }
        // Walk complete client frames looking for a close (opcode 8).
        for (;;) {
          if (inbound.length < 2) return;
          const opcode = inbound[0] & 0x0f;
          const masked = (inbound[1] & 0x80) !== 0;
          let len = inbound[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (inbound.length < 4) return;
            len = inbound.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (inbound.length < 10) return;
            len = Number(inbound.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (inbound.length < offset + maskLen + len) return;
          inbound = inbound.subarray(offset + maskLen + len);
          if (opcode === 8) {
            sock.write(Buffer.from([0x88, 0x00]));
            sock.end();
            return;
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      peer.listen(0, "127.0.0.1", () => resolve());
      peer.once("error", reject);
    });
    const port = (peer.address() as net.AddressInfo).port;
    const clientTransport = new WsNoiseTransport(branch);
    const wsAfterConnect = () => (clientTransport as any).inFlight as WebSocket | null;
    try {
      let caught: unknown;
      try {
        await clientTransport.connect({
          host: "127.0.0.1",
          port,
          branchId: "branch-malformed",
          hostPublicKey: host.encryption.publicKey,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      // The guard closes with 1008 and the ws must reach CLOSED. `inFlight`
      // clears on the ws close event, so a null there is that event having run.
      const ws = wsAfterConnect();
      const closed = await new Promise<boolean>((resolve) => {
        if (!ws || ws.readyState === WebSocket.CLOSED) return resolve(true);
        const timer = setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED), 2_000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      expect(closed).toBe(true);
      expect(wsAfterConnect()).toBeNull();
    } finally {
      wsAfterConnect()?.terminate();
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  }, 10_000);

  test("close terminates a WebSocket whose peer never answers the close frame", async () => {
    // A raw WebSocket peer that completes the HTTP upgrade and then stops
    // reading: the client's close frame is never answered.
    const sockets = new Set<net.Socket>();
    const peer = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("error", () => {});
      let request = "";
      const onData = (chunk: Buffer) => {
        request += chunk.toString("latin1");
        const end = request.indexOf("\r\n\r\n");
        if (end === -1) return;
        sock.off("data", onData);
        const headers = new Map<string, string>();
        for (const line of request.slice(0, end).split("\r\n").slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        const accept = createHash("sha1")
          .update(`${headers.get("sec-websocket-key") ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        // Stay alive and silent: never read another byte.
        sock.pause();
      };
      sock.on("data", onData);
    });
    await new Promise<void>((resolve, reject) => {
      peer.listen(0, "127.0.0.1", () => resolve());
      peer.once("error", reject);
    });
    const port = (peer.address() as net.AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const channel = new WsNoiseChannel(ws, {} as any, {} as any, "peer-fp");
    try {
      const started = Date.now();
      await channel.close();
      const elapsed = Date.now() - started;

      // terminate() destroys the socket; the `close` event that moves readyState
      // to CLOSED follows. Bound the wait so a regression fails by name.
      const closed = await new Promise<boolean>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve(true);
        const timer = setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED), 1000);
        ws.once("close", () => { clearTimeout(timer); resolve(true); });
      });

      expect(closed, "the ws readyState is CLOSED after close").toBe(true);
      expect(elapsed, "close resolves within the grace plus a margin").toBeLessThan(CHANNEL_CLOSE_GRACE_MS + 1000);
    } finally {
      ws.terminate();
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  }, 10_000);
});
