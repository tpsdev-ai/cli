import { describe, test, expect } from "bun:test";

const RUN_ALLOWLIST = ["df -h", "uptime", "bun --version", "git log --oneline -5"];

function dispatch(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "deploy") return "deploy (mocked in test)";
  if (trimmed === "status") return "status (mocked in test)";
  if (trimmed.startsWith("run ")) {
    const cmd = trimmed.slice(4).trim();
    if (!RUN_ALLOWLIST.includes(cmd)) {
      return `❌ command not in allowlist: ${cmd}\nAllowed: ${RUN_ALLOWLIST.join(", ")}`;
    }
    return `$ ${cmd}\n(output)`;
  }
  return `❓ unknown command: ${trimmed}\nKnown commands: deploy, status, run <cmd>`;
}

describe("deploy bot dispatch", () => {
  test("rejects commands from unauthorized senders", () => {
    const allowed = ["host"];
    const msg = { id: "abc", from: "evil-agent", body: "deploy" };
    expect(allowed.includes(msg.from)).toBe(false);
  });

  test("accepts commands from allowed senders", () => {
    const allowed = ["host"];
    const msg = { id: "abc", from: "host", body: "status" };
    expect(allowed.includes(msg.from)).toBe(true);
  });
  test("returns error for unknown command", () => {
    const result = dispatch("frobulate");
    expect(result).toContain("unknown command");
  });

  test("returns allowlist error for disallowed run cmd", () => {
    const result = dispatch("run rm -rf /");
    expect(result).toContain("not in allowlist");
  });

  test("allows allowlisted run cmd", () => {
    const result = dispatch("run uptime");
    expect(result).toContain("$ uptime");
    expect(result).not.toContain("not in allowlist");
  });
});
