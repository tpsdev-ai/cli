/**
 * ops-36 Phase 2 — OpenClaw Mail Bridge tests
 * Security: path traversal, bearer auth, trust headers
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function makeTmpMailDir(): string {
  const dir = join(tmpdir(), `tps-bridge-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Unit: agentId validation ─────────────────────────────────────────────────

describe("ops-36p2: validateAgentId", () => {
  test("accepts valid slugs", async () => {
    const { validateAgentId } = await import("../src/utils/mail-bridge.js");
    expect(validateAgentId("anvil")).toBe(true);
    expect(validateAgentId("openclaw-bridge")).toBe(true);
    expect(validateAgentId("agent_1")).toBe(true);
    expect(validateAgentId("Agent123")).toBe(true);
  });

  test("rejects path traversal and special chars", async () => {
    const { validateAgentId } = await import("../src/utils/mail-bridge.js");
    expect(validateAgentId("../etc/passwd")).toBe(false);
    expect(validateAgentId("../../secrets")).toBe(false);
    expect(validateAgentId("agent/bad")).toBe(false);
    expect(validateAgentId("agent bad")).toBe(false);
    expect(validateAgentId("agent!")).toBe(false);
    expect(validateAgentId("")).toBe(false);
    expect(validateAgentId("a".repeat(65))).toBe(false);
  });
});

// ─── Unit: sendMail ───────────────────────────────────────────────────────────

describe("ops-36p2: sendMail utility", () => {
  let mailDir: string;
  beforeEach(() => { mailDir = makeTmpMailDir(); });
  afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

  test("writes JSON message with trust headers to agent new/ inbox", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "anvil", "openclaw-bridge", '{"content":"hello"}', {
      "X-TPS-Trust": "external",
      "X-TPS-Sender": "284437008405757953",
      "X-TPS-Channel": "discord:123",
    });

    const newDir = join(mailDir, "anvil", "new");
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
    expect(msg.from).toBe("openclaw-bridge");
    expect(msg.to).toBe("anvil");
    expect(msg.body).toBe('{"content":"hello"}');
    expect(msg.headers["X-TPS-Trust"]).toBe("external");
    expect(msg.headers["X-TPS-Sender"]).toBe("284437008405757953");
    expect(msg.headers["X-TPS-Channel"]).toBe("discord:123");
  });

  test("creates inbox directory if it doesn't exist", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    const agentDir = join(mailDir, "new-agent", "new");
    expect(existsSync(agentDir)).toBe(false);
    sendMail(mailDir, "new-agent", "bridge", "payload");
    expect(existsSync(agentDir)).toBe(true);
  });

  test("multiple messages get unique filenames", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "anvil", "bridge", "msg1");
    sendMail(mailDir, "anvil", "bridge", "msg2");
    const files = readdirSync(join(mailDir, "anvil", "new")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);
  });
});

// ─── Integration: inbound HTTP server ────────────────────────────────────────

const TOKEN = "test-secret-token-abc123";

describe("ops-36p2: inbound HTTP security", () => {
  let mailDir: string;
  beforeEach(() => { mailDir = makeTmpMailDir(); });
  afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

  test("health endpoint returns ok without auth", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17891;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", inboundToken: TOKEN });

    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.ok).toBe(true);
      const body = await res.json() as any;
      expect(body.status).toBe("ok");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound rejected without Bearer token (401)", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17892;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", inboundToken: TOKEN });

    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "discord", channelId: "1", senderId: "2", senderName: "X", content: "hi", timestamp: new Date().toISOString() }),
      });
      expect(res.status).toBe(401);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound rejected with wrong token (401)", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17893;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", inboundToken: TOKEN });

    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer wrong-token" },
        body: JSON.stringify({ channel: "discord", channelId: "1", senderId: "2", senderName: "X", content: "hi", timestamp: new Date().toISOString() }),
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
    const port = 17894;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", inboundToken: TOKEN });

    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify({
          channel: "discord", channelId: "1", senderId: "2", senderName: "X",
          content: "hi", timestamp: new Date().toISOString(),
          agentId: "../../../etc/passwd",
        }),
      });
      expect(res.status).toBe(422);
      const body = await res.json() as any;
      expect(body.error).toContain("Invalid agentId");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound with valid token delivers mail and writes trust headers", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17895;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "test-anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", inboundToken: TOKEN });

    await new Promise((r) => setTimeout(r, 50));
    try {
      const envelope = {
        channel: "discord", channelId: "123", senderId: "456", senderName: "Nathan",
        content: "Hello agent", timestamp: new Date().toISOString(),
      };

      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify(envelope),
      });

      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.deliveredTo).toBe("test-anvil");

      // Verify trust headers in mail
      const newDir = join(mailDir, "test-anvil", "new");
      const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);

      const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
      expect(msg.headers["X-TPS-Trust"]).toBe("external");
      expect(msg.headers["X-TPS-Sender"]).toBe("456");
      expect(msg.headers["X-TPS-Channel"]).toBe("discord:123");
      expect(msg.from).toBe("test-bridge");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound disabled (503) when no inbound token configured", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17896;
    const origExit = process.exit;
    (process as any).exit = () => {};
    const origEnv = process.env.BRIDGE_TOKEN;
    delete process.env.BRIDGE_TOKEN;

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope" }); // no token

    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "discord", channelId: "1", senderId: "2", senderName: "X", content: "hi", timestamp: new Date().toISOString() }),
      });
      expect(res.status).toBe(503);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      if (origEnv !== undefined) process.env.BRIDGE_TOKEN = origEnv;
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound routes to agentId in envelope if valid", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");
    const port = 17897;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({ port, mailDir, bridgeAgentId: "test-bridge", defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", inboundToken: TOKEN });

    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
        body: JSON.stringify({
          channel: "discord", channelId: "1", senderId: "2", senderName: "X",
          content: "Hey Kern", agentId: "kern", timestamp: new Date().toISOString(),
        }),
      });
      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.deliveredTo).toBe("kern");
      expect(existsSync(join(mailDir, "kern", "new"))).toBe(true);
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
    if (st.running) {
      expect(typeof st.pid).toBe("number");
      expect(typeof st.port).toBe("number");
    }
  });
});
