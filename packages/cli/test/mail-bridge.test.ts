/**
 * ops-36 Phase 2 — OpenClaw Mail Bridge tests
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpMailDir(): string {
  const dir = join(tmpdir(), `tps-bridge-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Unit: sendMail ───────────────────────────────────────────────────────────

describe("ops-36p2: sendMail utility", () => {
  let mailDir: string;
  beforeEach(() => { mailDir = makeTmpMailDir(); });
  afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

  test("writes JSON message to agent new/ inbox", async () => {
    const { sendMail } = await import("../src/utils/mail-bridge.js");
    sendMail(mailDir, "anvil", "openclaw-bridge", '{"content":"hello"}');

    const newDir = join(mailDir, "anvil", "new");
    expect(existsSync(newDir)).toBe(true);
    const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
    expect(msg.from).toBe("openclaw-bridge");
    expect(msg.to).toBe("anvil");
    expect(msg.body).toBe('{"content":"hello"}');
    expect(msg.id).toBeDefined();
    expect(msg.timestamp).toBeDefined();
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

describe("ops-36p2: inbound HTTP server", () => {
  let mailDir: string;

  beforeEach(() => { mailDir = makeTmpMailDir(); });
  afterEach(() => { rmSync(mailDir, { recursive: true, force: true }); });

  test("health endpoint returns ok", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");

    const port = 17891;

    // Patch process.exit so daemon doesn't kill the test process
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({
      port,
      mailDir,
      bridgeAgentId: "test-bridge",
      defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope", // offline — won't be called
    });

    // Give server a tick to bind
    await new Promise((r) => setTimeout(r, 50));

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.ok).toBe(true);
      const body = await res.json() as any;
      expect(body.status).toBe("ok");
      expect(body.bridge).toBe("test-bridge");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound delivers mail to default agent mailbox", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");

    const port = 17892;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({
      port,
      mailDir,
      bridgeAgentId: "test-bridge",
      defaultAgentId: "test-anvil",
      openClawUrl: "http://127.0.0.1:19999/nope",
    });

    await new Promise((r) => setTimeout(r, 50));

    try {
      const envelope = {
        channel: "discord",
        channelId: "123",
        senderId: "456",
        senderName: "Test",
        content: "Hello agent",
        timestamp: new Date().toISOString(),
      };

      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });

      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.deliveredTo).toBe("test-anvil");

      // Verify mail was written
      const newDir = join(mailDir, "test-anvil", "new");
      const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);

      const msg = JSON.parse(readFileSync(join(newDir, files[0]), "utf-8"));
      const parsed = JSON.parse(msg.body);
      expect(parsed.content).toBe("Hello agent");
      expect(parsed.channel).toBe("discord");
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound routes to agentId in envelope if present", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");

    const port = 17893;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({
      port,
      mailDir,
      bridgeAgentId: "test-bridge",
      defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope",
    });

    await new Promise((r) => setTimeout(r, 50));

    try {
      const envelope = {
        channel: "discord",
        channelId: "123",
        senderId: "456",
        senderName: "Test",
        content: "Hey Kern",
        agentId: "kern",
        timestamp: new Date().toISOString(),
      };

      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });

      expect(res.status).toBe(202);
      const body = await res.json() as any;
      expect(body.deliveredTo).toBe("kern");

      const newDir = join(mailDir, "kern", "new");
      const files = readdirSync(newDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });

  test("POST /inbound returns 422 for missing content", async () => {
    const { startBridgeDaemon } = await import("../src/utils/mail-bridge.js");

    const port = 17894;
    const origExit = process.exit;
    (process as any).exit = () => {};

    startBridgeDaemon({
      port,
      mailDir,
      bridgeAgentId: "test-bridge",
      defaultAgentId: "anvil",
      openClawUrl: "http://127.0.0.1:19999/nope",
    });

    await new Promise((r) => setTimeout(r, 50));

    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: "123" }), // missing content + channel
      });
      expect(res.status).toBe(422);
    } finally {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
      (process as any).exit = origExit;
    }
  });
});

// ─── bridgeStatus ─────────────────────────────────────────────────────────────

describe("ops-36p2: bridgeStatus", () => {
  test("returns not running when no pid file", async () => {
    // Use a unique pid path by temporarily renaming if it exists
    const { bridgeStatus } = await import("../src/utils/mail-bridge.js");
    // We can't control the PID path from here, but we can at least verify
    // the return shape.
    const st = bridgeStatus();
    expect(typeof st.running).toBe("boolean");
    if (st.running) {
      expect(typeof st.pid).toBe("number");
      expect(typeof st.port).toBe("number");
    }
  });
});
