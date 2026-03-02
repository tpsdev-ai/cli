/**
 * ops-36 Phase 2 — OpenClaw Mail Bridge tests (Ed25519 auth)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto, { randomUUID } from "node:crypto";

function setupTestKeys(homeDir: string): { sign: (method: string, urlPath: string) => string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const identDir = join(homeDir, ".tps", "identity");
  mkdirSync(identDir, { recursive: true });
  writeFileSync(join(identDir, "test-sender.pub"), pubRaw.toString("base64"), "utf-8");
  return {
    sign(method: string, urlPath: string): string {
      const ts = Date.now().toString();
      const nonce = randomUUID();
      const payload = `test-sender:${ts}:${nonce}:${method}:${urlPath}`;
      const sig = crypto.sign(null, Buffer.from(payload), privateKey);
      return `TPS-Ed25519 test-sender:${ts}:${nonce}:${sig.toString("base64")}`;
    },
  };
}

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tps-bridge-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ops-36p2: sendMail utility", () => {
  let mailDir: string;
  beforeEach(() => { mailDir = makeTmpDir(); });
  afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

  test("writes JSON message to agent new/ inbox", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "anvil", "openclaw-bridge", '{"content":"hello"}');
    const newDir = join(mailDir, "anvil", "new");
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
    expect(msg.from).toBe("openclaw-bridge");
    expect(msg.to).toBe("anvil");
    expect(msg.body).toBe('{"content":"hello"}');
  });

  test("writes trust headers when provided", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "anvil", "openclaw-bridge", '{"content":"hello"}', {
      "X-TPS-Trust": "external",
      "X-TPS-Sender": "284437008405757953",
      "X-TPS-Channel": "discord:123",
    });
    const newDir = join(mailDir, "anvil", "new");
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
    expect(msg.headers["X-TPS-Trust"]).toBe("external");
    expect(msg.headers["X-TPS-Sender"]).toBe("284437008405757953");
    expect(msg.headers["X-TPS-Channel"]).toBe("discord:123");
  });

  test("creates inbox directory if missing", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "new-agent", "bridge", "payload");
    expect(existsSync(join(mailDir, "new-agent", "new"))).toBe(true);
  });

  test("unique filenames for multiple messages", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "anvil", "bridge", "msg1");
    sendMail(mailDir, "anvil", "bridge", "msg2");
    const files = readdirSync(join(mailDir, "anvil", "new")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);
  });
});

describe("ops-36p2: inbound HTTP security", () => {
  let mailDir: string;
  let testHome: string;
  let origHome: string | undefined;
  let keys: ReturnType<typeof setupTestKeys>;

  beforeEach(() => {
    mailDir = makeTmpDir();
    testHome = makeTmpDir();
    origHome = process.env.HOME;
    process.env.HOME = testHome;
    keys = setupTestKeys(testHome);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(mailDir, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
  });

  test("health endpoint returns ok (no auth)", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17891;
    const origExit = process.exit;
    (process as any).exit = () => {};
    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil" });
    await new Promise((r) => setTimeout(r, 80));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.ok).toBe(true);
      expect((await res.json() as any).status).toBe("ok");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound without auth returns 401", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17892;
    const origExit = process.exit;
    (process as any).exit = () => {};
    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil" });
    await new Promise((r) => setTimeout(r, 80));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test", channel: "discord" }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound with path traversal agentId returns 422", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17893;
    const origExit = process.exit;
    (process as any).exit = () => {};
    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil" });
    await new Promise((r) => setTimeout(r, 80));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: keys.sign("POST", "/inbound") },
        body: JSON.stringify({
          channel: "discord", channelId: "123", senderId: "1",
          senderName: "Evil", content: "pwn", agentId: "../../../etc/passwd",
          timestamp: new Date().toISOString(),
        }),
      });
      expect(res.status).toBe(422);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound with valid auth delivers mail with trust headers", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17894;
    const origExit = process.exit;
    (process as any).exit = () => {};
    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "test-anvil" });
    await new Promise((r) => setTimeout(r, 80));
    try {
      const envelope = {
        channel: "discord", channelId: "123", senderId: "456",
        senderName: "Test", content: "Hello agent",
        timestamp: new Date().toISOString(),
      };
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: keys.sign("POST", "/inbound") },
        body: JSON.stringify(envelope),
      });
      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.deliveredTo).toBe("test-anvil");
      const newDir = join(mailDir, "test-anvil", "new");
      const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
      const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
      expect(msg.headers["X-TPS-Trust"]).toBe("external");
      expect(msg.headers["X-TPS-Sender"]).toBe("456");
      expect(msg.headers["X-TPS-Channel"]).toBe("discord:123");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound routes to agentId in envelope", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17895;
    const origExit = process.exit;
    (process as any).exit = () => {};
    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil" });
    await new Promise((r) => setTimeout(r, 80));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: keys.sign("POST", "/inbound") },
        body: JSON.stringify({
          channel: "discord", channelId: "123", senderId: "2",
          senderName: "Test", content: "Hey Kern", agentId: "kern",
          timestamp: new Date().toISOString(),
        }),
      });
      expect(res.status).toBe(202);
      expect((await res.json() as any).deliveredTo).toBe("kern");
      const files = readdirSync(join(mailDir, "kern", "new")).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound returns 422 for missing content", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17896;
    const origExit = process.exit;
    (process as any).exit = () => {};
    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil" });
    await new Promise((r) => setTimeout(r, 80));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: keys.sign("POST", "/inbound") },
        body: JSON.stringify({ senderId: "123" }),
      });
      expect(res.status).toBe(422);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });
});

describe("ops-36p2: bridgeStatus", () => {
  test("returns correct shape", async () => {
    const { bridgeStatus } = await import("../src/utils/mail-bridge.js");
    const st = bridgeStatus();
    expect(typeof st.running).toBe("boolean");
  });
});
