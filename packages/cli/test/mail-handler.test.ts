import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandlerPipeline } from "../src/utils/mail-handler.js";
import type { AgentManifest, MailMessage } from "../src/utils/mail-handler.js";

let tmp = "";

beforeEach(() => {
  tmp = join(tmpdir(), `mail-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const msg: MailMessage = {
  id: "123",
  from: "rockit",
  to: "tester",
  body: "hello world",
  timestamp: "2024-01-01T00:00:00Z"
};

function createHandler(name: string, content: string) {
  const scriptPath = join(tmp, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${content}`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("runHandlerPipeline", () => {
  test("returns inbox when no manifests", async () => {
    const res = await runHandlerPipeline(msg, [], []);
    expect(res.type).toBe("inbox");
  });

  test("returns inbox when no handlers match filter", async () => {
    const manifest: any = {
      name: "test",
      capabilities: {
        mail_handler: {
          enabled: true,
          match: { from: ["other"] }
        }
      }
    };
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res.type).toBe("inbox");
  });

  test("executes handler and returns plain text reply", async () => {
    const script = createHandler("reply.sh", "echo 'got it'");
    const manifest: any = {
      name: "replier",
      agentDir: tmp,
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script
        }
      }
    };
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res).toEqual({ type: "reply", body: "got it", to: "rockit" });
  });

  test("executes handler and parses JSON reply envelope", async () => {
    const script = createHandler("json.sh", "echo '{\"action\":\"forward\",\"to\":\"other\",\"body\":\"new body\"}'");
    const manifest: any = {
      name: "json-agent",
      agentDir: tmp,
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script
        }
      }
    };
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res).toEqual({ type: "forward", to: "other", body: "new body" });
  });

  test("handles exit 1 (not handled) — tries next handler", async () => {
    const script1 = createHandler("pass.sh", "exit 1");
    const script2 = createHandler("reply2.sh", "echo 'handled'");
    const m1: any = {
      name: "m1",
      agentDir: tmp,
      capabilities: { mail_handler: { enabled: true, exec: script1 } }
    };
    const m2: any = {
      name: "m2",
      agentDir: tmp,
      capabilities: { mail_handler: { enabled: true, exec: script2 } }
    };
    const res = await runHandlerPipeline(msg, [m1, m2], []);
    expect(res).toEqual({ type: "reply", body: "handled", to: "rockit" });
  });

  test("handles exit 2 (error) — falls through to next", async () => {
    const script1 = createHandler("error.sh", "exit 2");
    const script2 = createHandler("reply2.sh", "echo 'handled'");
    const m1: any = {
      name: "m1",
      agentDir: tmp,
      capabilities: { mail_handler: { enabled: true, exec: script1 } }
    };
    const m2: any = {
      name: "m2",
      agentDir: tmp,
      capabilities: { mail_handler: { enabled: true, exec: script2 } }
    };
    const res = await runHandlerPipeline(msg, [m1, m2], []);
    expect(res).toEqual({ type: "reply", body: "handled", to: "rockit" });
  });

  test("follows routing rules before exec", async () => {
    const script = createHandler("should-not-run.sh", "echo 'should not run'; exit 0");
    const manifest: any = {
      name: "router",
      agentDir: tmp,
      routing: [{ pattern: "hello", to: "forwarded" }],
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script
        }
      }
    };
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res).toEqual({ type: "forward", to: "forwarded", body: "hello world" });
  });

  test("returns drop action on empty stdout exit 0", async () => {
    const script = createHandler("drop.sh", "exit 0");
    const manifest: any = {
      name: "dropper",
      agentDir: tmp,
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script
        }
      }
    };
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res.type).toBe("drop");
  });

  test("passes TPS_REGISTERED_AGENTS when needs_roster=true", async () => {
    const script = createHandler("roster.sh", "echo $TPS_REGISTERED_AGENTS");
    const manifest: any = {
      name: "roster-agent",
      agentDir: tmp,
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script,
          needs_roster: true
        }
      }
    };
    const roster = ["agent1", "agent2"];
    const res = await runHandlerPipeline(msg, [manifest], roster);
    expect(res.body).toBe(JSON.stringify(roster));
  });

  test("does not pass MAIL_BODY in environment", async () => {
    const script = createHandler("env.sh", "echo \"-MAIL_BODY=${MAIL_BODY}-\"");
    const manifest: any = {
      name: "env-agent",
      agentDir: tmp,
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script
        }
      }
    };
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res.body).toBe("-MAIL_BODY=-");
  });

  test("truncates body for regex matching", async () => {
    const longBody = "a".repeat(1024) + "MATCH_ME";
    const manifest: any = {
      name: "regex-trunc",
      agentDir: tmp,
      routing: [{ pattern: "MATCH_ME", to: "forwarded" }],
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: createHandler("noop.sh", "exit 1")
        }
      }
    };
    const res = await runHandlerPipeline({ ...msg, body: longBody }, [manifest], []);
    expect(res.type).toBe("inbox"); // Should not match because it's truncated at 1024
  });

  test("skips handler when matchesFilter returns false", async () => {
    const script = createHandler("match.sh", "echo 'matched'");
    const manifest: any = {
      name: "matcher",
      agentDir: tmp,
      capabilities: {
        mail_handler: {
          enabled: true,
          exec: script,
          match: { from: ["not-rockit"] }
        }
      }
    };
    // Import matchesFilter in the test context if needed, but it's used inside runHandlerPipeline
    const res = await runHandlerPipeline(msg, [manifest], []);
    expect(res.type).toBe("inbox");
  });
});
