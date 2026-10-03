/**
 * tui-phase2.test.ts — Unit tests for TUI Phase 2 interactive logic
 * ops-90
 *
 * Updated for cli#397: the TUI no longer approves or merges PRs, and its
 * recipient list is configuration (the credentials manifest), not a
 * hardcoded agent list.
 */
import { describe, expect, it } from "bun:test";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Mirrors the sendMailAction logic for testing purposes. */
function sendMailAction(
  _agentId: string,
  to: string,
  body: string,
  execFn: (cmd: string) => void,
  knownAgents: string[] = [],
): { ok: boolean; err?: string } {
  if (!knownAgents.includes(to)) {
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
  const known = ["alice", "bob"];

  it("rejects an unknown agent", () => {
    const result = sendMailAction("carol", "stranger", "hello", () => {}, known);
    expect(result.ok).toBe(false);
    expect(result.err).toContain("Unknown agent");
  });

  it("rejects an empty recipient list (unconfigured)", () => {
    const result = sendMailAction("carol", "alice", "hello", () => {});
    expect(result.ok).toBe(false);
    expect(result.err).toContain("Unknown agent");
  });

  it("rejects empty body", () => {
    const result = sendMailAction("carol", "alice", "   ", () => {}, known);
    expect(result.ok).toBe(false);
    expect(result.err).toContain("empty");
  });

  it("returns ok on successful exec", () => {
    const result = sendMailAction("carol", "alice", "hello", () => {}, known);
    expect(result.ok).toBe(true);
  });

  it("returns error on exec failure", () => {
    const result = sendMailAction("carol", "bob", "test", () => {
      throw new Error("mail daemon unavailable");
    }, known);
    expect(result.ok).toBe(false);
    expect(result.err).toContain("mail daemon unavailable");
  });

  it("accepts every configured agent", () => {
    for (const agent of known) {
      const result = sendMailAction("carol", agent, "ping", () => {}, known);
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
