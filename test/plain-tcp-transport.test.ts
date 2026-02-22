import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import {
  generateKeyPair,
  initHostIdentity,
  registerBranch,
  loadHostIdentity,
  fingerprint,
} from "../src/utils/identity.js";
import { PlainTcpTransport } from "../src/utils/plain-tcp-transport.js";

describe("plain tcp transport", () => {
  let root: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-plain-tcp-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = root;
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("connect/listen handshake establishes channel with verified peer fingerprint", async () => {
    const host = initHostIdentity();
    const branch = generateKeyPair();
    registerBranch("brancha", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const serverTransport = new PlainTcpTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const serverChannelPromise = new Promise<{ fp: string; got: any }>((resolve) => {
      server.onConnection((ch) => {
        ch.onMessage((msg) => {
          resolve({ fp: ch.peerFingerprint(), got: msg });
        });
      });
    });

    const clientTransport = new PlainTcpTransport(branch);
    const ch = await clientTransport.connect({
      host: "127.0.0.1",
      port,
      branchId: "brancha",
      hostPublicKey: loadHostIdentity().signing.publicKey,
    });

    expect(ch.isAlive()).toBe(true);
    expect(ch.peerFingerprint()).toBe(fingerprint(host.signing.publicKey));

    await ch.send({ type: 0x01, seq: 1, ts: new Date().toISOString(), body: { text: "ping" } });

    const serverRecv = await serverChannelPromise;
    expect(serverRecv.fp).toBe(fingerprint(branch.signing.publicKey));
    expect(serverRecv.got.type).toBe(0x01);
    expect(serverRecv.got.seq).toBe(1);
    expect(serverRecv.got.body.text).toBe("ping");

    await ch.close();
    await server.close();
  });

  test("rejects unknown branch during handshake", async () => {
    const host = initHostIdentity();
    const branch = generateKeyPair();
    const serverTransport = new PlainTcpTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const clientTransport = new PlainTcpTransport(branch);
    await expect(
      clientTransport.connect({
        host: "127.0.0.1",
        port,
        branchId: "unknown-branch",
        hostPublicKey: host.signing.publicKey,
      })
    ).rejects.toThrow();

    await server.close();
  });

  test("rejects oversized handshake payload without newline", async () => {
    const host = initHostIdentity();
    const branch = generateKeyPair();
    registerBranch("brancha", branch.signing.publicKey, undefined, branch.encryption.publicKey);
    const serverTransport = new PlainTcpTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const sock = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });

    const oversized = "x".repeat(70000);
    sock.write(oversized);

    const closed = await new Promise<boolean>((resolve) => {
      sock.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });

    expect(closed).toBe(true);
    await server.close();
  });

  test("drops connection when rxBuffer grows beyond frame cap", async () => {
    const host = initHostIdentity();
    const branch = generateKeyPair();
    registerBranch("brancha", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const serverTransport = new PlainTcpTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const clientTransport = new PlainTcpTransport(branch);
    const ch = await clientTransport.connect({
      host: "127.0.0.1",
      port,
      branchId: "brancha",
      hostPublicKey: host.signing.publicKey,
    });

    const raw = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => resolve());
      raw.once("error", reject);
    });

    // valid handshake first for the raw socket
    raw.write(
      `${JSON.stringify({
        kind: "noise_ik_init",
        branchId: "brancha",
        branchPub: Buffer.from(branch.signing.publicKey).toString("hex"),
      })}\n`
    );
    await new Promise((resolve) => raw.once("data", resolve));

    // frame header claims max payload, send enough bytes to exceed max+header in rxBuffer
    const header = Buffer.alloc(6);
    header.writeUInt16BE(1, 0);
    header.writeUInt32BE(1024 * 1024, 2);
    raw.write(header);
    raw.write(Buffer.alloc(1024 * 1024 + 8));

    const closed = await new Promise<boolean>((resolve) => {
      raw.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 700);
    });

    expect(closed).toBe(true);
    await ch.close();
    await server.close();
  });
});
