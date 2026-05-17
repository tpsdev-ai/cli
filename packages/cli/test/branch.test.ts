import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { buildJoinToken, isAlreadyJoined, writeBranchConf } from "../src/commands/branch.js";

describe("tps branch init", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-branch-test-"));
    process.env.TPS_IDENTITY_DIR = join(tmpDir, "identity");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TPS_IDENTITY_DIR;
  });

  test("generates branch keypair files", async () => {
    const { generateKeyPair, saveKeyPair } = await import("../src/utils/identity.js");
    const kp = generateKeyPair();
    saveKeyPair(kp, join(tmpDir, "identity"), "branch");

    expect(existsSync(join(tmpDir, "identity", "branch.seed"))).toBe(true);
    expect(existsSync(join(tmpDir, "identity", "branch.pub"))).toBe(true);
    expect(existsSync(join(tmpDir, "identity", "branch.key"))).toBe(true);
    expect(existsSync(join(tmpDir, "identity", "branch.x25519.pub"))).toBe(true);
    expect(existsSync(join(tmpDir, "identity", "branch.x25519.key"))).toBe(true);
    expect(existsSync(join(tmpDir, "identity", "branch.meta.json"))).toBe(true);
  });

  test("join token URL contains required parameters", async () => {
    const { generateKeyPair } = await import("../src/utils/identity.js");
    const kp = generateKeyPair();
    const token = buildJoinToken("test.example.com", 6458, kp.encryption.publicKey, kp.signing.publicKey, kp.fingerprint);
    const url = new URL(token);
    expect(url.protocol).toBe("tps:");
    expect(url.searchParams.get("host")).toBe("test.example.com");
    expect(url.searchParams.get("port")).toBe("6458");
    expect(url.searchParams.get("pubkey")).toBeTruthy();
    expect(url.searchParams.get("fp")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("idempotent: reuses existing identity", async () => {
    const { generateKeyPair, saveKeyPair, loadKeyPair } = await import("../src/utils/identity.js");
    const dir = join(tmpDir, "identity");
    const kp1 = generateKeyPair();
    saveKeyPair(kp1, dir, "branch");
    const kp2 = loadKeyPair(dir, "branch");
    expect(kp2.fingerprint).toBe(kp1.fingerprint);
  });

  test("refuses re-join guard when host.json exists", () => {
    const dir = join(tmpDir, "identity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "host.json"), JSON.stringify({ hostId: "existing" }));
    expect(isAlreadyJoined(dir)).toBe(true);
  });

  test("writeBranchConf persists agentId when --agent supplied (ops-hs19)", () => {
    process.env.TPS_ROOT = tmpDir;
    try {
      writeBranchConf(33744, "localhost", "ws", undefined, "reed");
      const conf = JSON.parse(readFileSync(join(tmpDir, "branch.conf.json"), "utf-8"));
      expect(conf.agentId).toBe("reed");
      expect(conf.port).toBe(33744);
      expect(conf.host).toBe("localhost");
      expect(conf.transport).toBe("ws");
    } finally {
      delete process.env.TPS_ROOT;
    }
  });

  test("writeBranchConf omits agentId when not supplied (back-compat)", () => {
    process.env.TPS_ROOT = tmpDir;
    try {
      writeBranchConf(6458, "tps-host", "ws");
      const conf = JSON.parse(readFileSync(join(tmpDir, "branch.conf.json"), "utf-8"));
      expect(conf.agentId).toBeUndefined();
      expect(conf.port).toBe(6458);
    } finally {
      delete process.env.TPS_ROOT;
    }
  });
});

describe("MSG_JOIN_COMPLETE", () => {
  test("schema validates correct body", async () => {
    const { JoinCompleteBodySchema } = await import("../src/utils/wire-mail.js");
    const valid = {
      hostPubkey: "dGVzdA",
      hostFingerprint: "sha256:abc123",
      hostId: "host",
    };
    expect(JoinCompleteBodySchema.safeParse(valid).success).toBe(true);
  });

  test("schema rejects missing fields", async () => {
    const { JoinCompleteBodySchema } = await import("../src/utils/wire-mail.js");
    expect(JoinCompleteBodySchema.safeParse({}).success).toBe(false);
    expect(JoinCompleteBodySchema.safeParse({ hostPubkey: "x" }).success).toBe(false);
  });
});
