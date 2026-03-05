import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, registerBranch, fingerprint } from "../src/utils/identity.js";
import { listenForJoin, NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { MSG_JOIN_COMPLETE } from "../src/utils/wire-mail.js";
import { runBranch } from "../src/commands/branch.js";

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

describe("branch join handshake", () => {
  let tmpDir: string;
  let branchIdentityDir: string;
  let hostIdentityDir: string;
  let hostRegistryDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-join-test-"));
    branchIdentityDir = join(tmpDir, "branch-identity");
    hostIdentityDir = join(tmpDir, "host-identity");
    hostRegistryDir = join(tmpDir, "host-registry");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
  });

  test("listenForJoin accepts JOIN_COMPLETE and exposes host identity", async () => {
    const branchKp = generateKeyPair();
    const hostKp = generateKeyPair();

    // Host knows branch pubkey from token
    process.env.TPS_REGISTRY_DIR = hostRegistryDir;
    registerBranch("test-branch", branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);

    const port = await freePort();
    const joinP = listenForJoin(branchKp, port, 10_000);

    const hostTransport = new NoiseIkTransport(hostKp);
    const ch = await hostTransport.connect({
      host: "127.0.0.1",
      port,
      branchId: "test-branch",
      hostPublicKey: branchKp.encryption.publicKey,
    });

    const hostPubB64 = Buffer.from(hostKp.encryption.publicKey).toString("base64url");
    await ch.send({
      type: MSG_JOIN_COMPLETE,
      seq: 1,
      ts: new Date().toISOString(),
      body: {
        hostPubkey: hostPubB64,
        hostFingerprint: fingerprint(hostKp.encryption.publicKey),
        hostId: "host",
      },
    });

    const joined = await joinP;
    expect(joined.hostId).toBe("host");
    expect(joined.hostFingerprint).toBe(fingerprint(hostKp.encryption.publicKey));

    await ch.close();
    await joined.channel.close();
    await joined.server.close();
  });

  test("runBranch writes host.json after join", async () => {
    const branchKp = generateKeyPair();
    const hostKp = generateKeyPair();

    mkdirSync(branchIdentityDir, { recursive: true });
    mkdirSync(hostIdentityDir, { recursive: true });
    mkdirSync(hostRegistryDir, { recursive: true });

    // Pre-seed branch identity files so runBranch reuses identity
    const { saveKeyPair } = await import("../src/utils/identity.js");
    saveKeyPair(branchKp, branchIdentityDir, "branch");

    process.env.TPS_REGISTRY_DIR = hostRegistryDir;
    registerBranch("branch-run", branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);

    const port = await freePort();

    // run branch in background
    process.env.TPS_IDENTITY_DIR = branchIdentityDir;
    const runP = runBranch({ action: "init", port, host: "127.0.0.1", transport: "tcp" });

    await new Promise((r) => setTimeout(r, 200));

    const hostTransport = new NoiseIkTransport(hostKp);
    const ch = await hostTransport.connect({
      host: "127.0.0.1",
      port,
      branchId: "branch-run",
      hostPublicKey: branchKp.encryption.publicKey,
    });

    await ch.send({
      type: MSG_JOIN_COMPLETE,
      seq: 1,
      ts: new Date().toISOString(),
      body: {
        hostPubkey: Buffer.from(hostKp.encryption.publicKey).toString("base64url"),
        hostFingerprint: fingerprint(hostKp.encryption.publicKey),
        hostId: "host",
      },
    });

    await runP;

    const hostFile = join(branchIdentityDir, "host.json");
    expect(existsSync(hostFile)).toBe(true);
    const saved = JSON.parse(readFileSync(hostFile, "utf-8"));
    expect(saved.hostId).toBe("host");
    expect(saved.fingerprint).toBe(fingerprint(hostKp.encryption.publicKey));

    await ch.close();
  });
});
