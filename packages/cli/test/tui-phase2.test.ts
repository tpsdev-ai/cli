/**
 * tui-phase2.test.ts — Unit tests for TUI Phase 2 interactive logic
 * ops-90
 */
import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Mirrors the sendMailAction logic for testing purposes. */
function sendMailAction(
  _agentId: string,
  to: string,
  body: string,
  execFn: (cmd: string) => void,
): { ok: boolean; err?: string } {
  const KNOWN_AGENTS = ["flint", "anvil", "ember", "kern", "sherlock"];
  if (!KNOWN_AGENTS.includes(to)) {
    return { ok: false, err: `Unknown agent: ${to}` };
  }
  if (!body.trim()) {
    return { ok: false, err: "Body cannot be empty" };
  }
  try {
    execFn(`mail send ${to} ${JSON.stringify(body)}`);
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, err: (e as Error).message?.slice(0, 80) ?? "send failed" };
  }
}

/** Mirrors compose state transitions. */
type ComposeState = "idle" | "composing" | "sending" | "done" | "error";

function transitionCompose(
  state: ComposeState,
  event: "start" | "submit_ok" | "submit_err" | "cancel" | "dismiss",
): ComposeState {
  switch (state) {
    case "idle":
      return event === "start" ? "composing" : "idle";
    case "composing":
      if (event === "submit_ok") return "sending";
      if (event === "cancel") return "idle";
      return "composing";
    case "sending":
      if (event === "submit_ok") return "done";
      if (event === "submit_err") return "error";
      return "sending";
    case "done":
      return event === "dismiss" ? "idle" : "done";
    case "error":
      return event === "dismiss" || event === "cancel" ? "idle" : "error";
    default:
      return "idle";
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("sendMailAction", () => {
  it("rejects unknown agent", () => {
    const result = sendMailAction("anvil", "badbot", "hello", () => {});
    expect(result.ok).toBe(false);
    expect(result.err).toContain("Unknown agent");
  });

  it("rejects empty body", () => {
    const result = sendMailAction("anvil", "flint", "   ", () => {});
    expect(result.ok).toBe(false);
    expect(result.err).toContain("empty");
  });

  it("returns ok on successful exec", () => {
    const result = sendMailAction("anvil", "flint", "hello", () => {});
    expect(result.ok).toBe(true);
  });

  it("returns error on exec failure", () => {
    const result = sendMailAction("anvil", "kern", "test", () => {
      throw new Error("mail daemon unavailable");
    });
    expect(result.ok).toBe(false);
    expect(result.err).toContain("mail daemon unavailable");
  });

  it("accepts all known agents", () => {
    for (const agent of ["flint", "anvil", "ember", "kern", "sherlock"]) {
      const result = sendMailAction("anvil", agent, "ping", () => {});
      expect(result.ok).toBe(true);
    }
  });
});

describe("compose state machine", () => {
  it("starts idle", () => {
    expect(transitionCompose("idle", "start")).toBe("composing");
  });

  it("idle → composing → idle on cancel", () => {
    let s: ComposeState = "idle";
    s = transitionCompose(s, "start");
    expect(s).toBe("composing");
    s = transitionCompose(s, "cancel");
    expect(s).toBe("idle");
  });

  it("composing → sending → done on happy path", () => {
    let s: ComposeState = "composing";
    s = transitionCompose(s, "submit_ok"); // composing → sending
    expect(s).toBe("sending");
    s = transitionCompose(s, "submit_ok"); // sending → done
    expect(s).toBe("done");
    s = transitionCompose(s, "dismiss");   // done → idle
    expect(s).toBe("idle");
  });

  it("sending → error on failure", () => {
    let s: ComposeState = "sending";
    s = transitionCompose(s, "submit_err");
    expect(s).toBe("error");
  });

  it("error → idle on cancel", () => {
    let s: ComposeState = "error";
    s = transitionCompose(s, "cancel");
    expect(s).toBe("idle");
  });

  it("error → idle on dismiss", () => {
    let s: ComposeState = "error";
    s = transitionCompose(s, "dismiss");
    expect(s).toBe("idle");
  });

  it("ignores irrelevant events in idle", () => {
    expect(transitionCompose("idle", "submit_ok")).toBe("idle");
    expect(transitionCompose("idle", "dismiss")).toBe("idle");
  });
});

describe("PR action confirmation", () => {
  /** Mirrors PR action flow. */
  function prActionFlow(
    action: "approve" | "merge",
    userInput: "y" | "n",
    execFn: (cmd: string) => void,
  ): { confirmed: boolean; ok?: boolean; err?: string } {
    if (userInput === "n") return { confirmed: false };
    try {
      const cmd = action === "approve"
        ? `gh-as flint pr review 42 --repo tpsdev-ai/cli --approve`
        : `gh-as flint pr merge 42 --repo tpsdev-ai/cli --squash --delete-branch`;
      execFn(cmd);
      return { confirmed: true, ok: true };
    } catch (e: unknown) {
      return { confirmed: true, ok: false, err: (e as Error).message?.slice(0, 80) };
    }
  }

  it("n input skips exec", () => {
    let called = false;
    const result = prActionFlow("approve", "n", () => { called = true; });
    expect(result.confirmed).toBe(false);
    expect(called).toBe(false);
  });

  it("y input runs approve", () => {
    let cmd = "";
    const result = prActionFlow("approve", "y", (c) => { cmd = c; });
    expect(result.ok).toBe(true);
    expect(cmd).toContain("--approve");
  });

  it("y input runs merge", () => {
    let cmd = "";
    const result = prActionFlow("merge", "y", (c) => { cmd = c; });
    expect(result.ok).toBe(true);
    expect(cmd).toContain("--squash");
  });

  it("exec error returns ok=false", () => {
    const result = prActionFlow("merge", "y", () => {
      throw new Error("PR not mergeable");
    });
    expect(result.ok).toBe(false);
    expect(result.err).toContain("not mergeable");
  });
});
