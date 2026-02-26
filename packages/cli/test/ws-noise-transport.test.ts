import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, registerBranch } from "../src/utils/identity.js";
import { WsNoiseTransport } from "../src/utils/ws-noise-transport.js";

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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-ws-noise-"));
    process.env.HOME = root;
    process.env.TPS_VAULT_KEY = "test-passphrase";
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
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
    (await import("ws")).WebSocket.prototype.send = function (data: any, ...args: any[]) {
      try { captured.push(Buffer.from(data)); } catch {}
      // @ts-ignore
      return origSend.call(this, data, ...args);
    };

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

    (await import("ws")).WebSocket.prototype.send = origSend;
    await ch.close();
    await server.close();
  });
});
