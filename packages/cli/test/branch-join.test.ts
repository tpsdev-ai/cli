import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, registerBranch, fingerprint } from "../src/utils/identity.js";
import { listenForJoin, NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { MSG_JOIN_COMPLETE } from "../src/utils/wire-mail.js";
import { runBranch } from "../src/commands/branch.js";
import { withPortRetry } from "./helpers/port.js";

/** Wait (bounded) for a join listener to report the port it bound. */
async function waitForBoundPort(port: () => number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (port() === 0) {
    if (Date.now() >= deadline) throw new Error("join listener did not report its bound port");
    await Bun.sleep(5);
  }
  return port();
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
    // Override TPS_ROOT so branch init writes conf to temp dir, not ~/.tps
    process.env.TPS_ROOT = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
    delete process.env.TPS_ROOT;
  });

  test("listenForJoin accepts JOIN_COMPLETE and exposes host identity", async () => {
    const branchKp = generateKeyPair();
    const hostKp = generateKeyPair();

    // Host knows branch pubkey from token
    process.env.TPS_REGISTRY_DIR = hostRegistryDir;
    registerBranch("test-branch", branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);

    let bound = 0;
    const joinP = listenForJoin(branchKp, 0, 10_000, (port) => { bound = port; });
    const port = await waitForBoundPort(() => bound);

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

    const { port } = await withPortRetry(async (port) => {
      // run branch in background
      process.env.TPS_IDENTITY_DIR = branchIdentityDir;
      const runP = runBranch({ action: "init", port, host: "127.0.0.1", transport: "tcp" });
      // A taken port rejects runP before it can accept the join; surface that
      // rejection so withPortRetry tries a new port instead of connecting.
      const early = await Promise.race([
        runP.then(() => null, (error: unknown) => error),
        Bun.sleep(200).then(() => null),
      ]);
      if (early) throw early;

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
      return port;
    });
    expect(port).toBeGreaterThan(0);
  });
});