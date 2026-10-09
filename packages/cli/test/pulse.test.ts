import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadConfig,
  computePrState,
  handleTransition,
  checkReminders,
  pollOnce,
  printStatus,
  pruneState,
  startPollLoop,
  setSendTimeoutMs,
  type PrInstance,
  type PrState,
  type PulseConfig,
  type PulseState,
  type SyncRunner,
  type MailSender,
  type FlairPublisher,
} from "../src/commands/pulse.js";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startUnverifiedFetchFlair } from "./helpers/fetch-flair.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<PulseConfig> = {}): PulseConfig {
  return {
    repos: ["tpsdev-ai/cli"],
    reviewers: ["sherlock", "kern"],
    mergeAuthority: "flint",
    author: "anvil",
    human: "nathan",
    pollIntervalMs: 120000,
    remindAfterMs: 1800000,
    ghAgent: "flint",
    ...overrides,
  };
}

function makeInstance(overrides: Partial<PrInstance> = {}): PrInstance {
  return {
    state: "opened",
    prNumber: 42,
    repo: "tpsdev-ai/cli",
    title: "Test PR",
    author: "tps-anvil",
    reviewers: ["tps-sherlock", "tps-kern"],
    lastTransitionAt: new Date().toISOString(),
    reminderSentAt: null,
    history: [{ at: new Date().toISOString(), from: null, to: "opened" }],
    ...overrides,
  };
}

function makeState(instances: Record<string, PrInstance> = {}): PulseState {
  return { version: 1, lastPollAt: new Date().toISOString(), instances };
}

interface MailCall {
  to: string;
  body: string;
  agentId: string;
}

function trackMails(): { calls: MailCall[]; sender: MailSender } {
  const calls: MailCall[] = [];
  const sender: MailSender = (to, body, agentId) => {
    calls.push({ to, body, agentId });
  };
  return { calls, sender };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computePrState", () => {
  test("returns opened when no reviews exist", () => {
    const pr = { number: 1, title: "t", state: "open", merged_at: null };
    expect(computePrState(pr, [])).toBe("opened");
  });

  test("returns merged when PR has merged_at", () => {
    const pr = { number: 1, title: "t", state: "closed", merged_at: "2026-01-01T00:00:00Z" };
    expect(computePrState(pr, [])).toBe("merged");
  });

  test("returns approved when all reviews are APPROVED", () => {
    const pr = { number: 1, title: "t", state: "open", merged_at: null };
    const reviews = [
      { state: "APPROVED", user: { login: "sherlock" } },
      { state: "APPROVED", user: { login: "kern" } },
    ];
    expect(computePrState(pr, reviews)).toBe("approved");
  });

  test("returns changes-requested when any review is CHANGES_REQUESTED", () => {
    const pr = { number: 1, title: "t", state: "open", merged_at: null };
    const reviews = [
      { state: "APPROVED", user: { login: "sherlock" } },
      { state: "CHANGES_REQUESTED", user: { login: "kern" } },
    ];
    expect(computePrState(pr, reviews)).toBe("changes-requested");
  });

  test("returns reviewing for COMMENTED reviews", () => {
    const pr = { number: 1, title: "t", state: "open", merged_at: null };
    const reviews = [{ state: "COMMENTED", user: { login: "sherlock" } }];
    expect(computePrState(pr, reviews)).toBe("reviewing");
  });
});

describe("handleTransition", () => {
  test("null → opened sends mail to reviewers", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    // Simulate new PR: create instance at "opened" then transition to "opened" is no-op,
    // so we test the initial transition by going from a fresh instance with state set externally
    const instance = makeInstance({ state: "opened" as PrState });

    // handleTransition is for state *changes* — test opened → approved instead
    // For null → opened, the pollOnce function sends mails directly.
    // Let's test opened → approved:
    handleTransition("pr:tpsdev-ai/cli#42", instance, "approved", config, sender);

    expect(calls.length).toBe(1);
    expect(calls[0].to).toBe("flint");
    expect(calls[0].body).toContain("merge-ready");
    expect(instance.state).toBe("approved");
    expect(instance.history.length).toBe(2);
  });

  test("reviewing → changes-requested sends mail to author", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const instance = makeInstance({ state: "reviewing" });

    handleTransition("pr:tpsdev-ai/cli#42", instance, "changes-requested", config, sender);

    expect(calls.length).toBe(1);
    expect(calls[0].to).toBe("anvil");
    expect(calls[0].body).toContain("Changes requested");
  });

  test("changes-requested → reviewing sends mail to reviewers for re-review", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const instance = makeInstance({ state: "changes-requested" });

    handleTransition("pr:tpsdev-ai/cli#42", instance, "reviewing", config, sender);

    expect(calls.length).toBe(2);
    expect(calls[0].to).toBe("sherlock");
    expect(calls[1].to).toBe("kern");
    expect(calls[0].body).toContain("re-review");
  });

  test("any → merged sends mail to author", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const instance = makeInstance({ state: "approved" });

    handleTransition("pr:tpsdev-ai/cli#42", instance, "merged", config, sender);

    expect(calls.length).toBe(1);
    expect(calls[0].to).toBe("anvil");
    expect(calls[0].body).toContain("merged");
  });

  test("same state does not send mail", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const instance = makeInstance({ state: "reviewing" });

    handleTransition("pr:tpsdev-ai/cli#42", instance, "reviewing", config, sender);

    expect(calls.length).toBe(0);
  });
});

describe("checkReminders", () => {
  test("sends reminder to pending reviewers when review requested >30min", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "opened",
      reviewRequestedAt: thirtyFiveMinAgo,
      lastRemindedAt: undefined,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender, { "pr:tpsdev-ai/cli#42": ["sherlock", "kern"] });

    expect(calls.length).toBe(2);
    expect(calls[0].body).toContain("Reminder: PR #42 still needs your review");
    expect(instance.lastRemindedAt).toBeTruthy();
  });

  test("escalates to merge authority when no review after 60min", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const sixtyFiveMinAgo = new Date(Date.now() - 65 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "opened",
      reviewRequestedAt: sixtyFiveMinAgo,
      lastRemindedAt: undefined,
      escalatedAt: undefined,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender, { "pr:tpsdev-ai/cli#42": ["sherlock"] });

    expect(calls.some((c) => c.to === "flint" && c.body.includes("ESCALATE: PR #42"))).toBe(true);
    expect(instance.escalatedAt).toBeTruthy();
  });

  test("does not re-send reminder within window", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "opened",
      reviewRequestedAt: fortyMinAgo,
      lastRemindedAt: fiveMinAgo,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender, { "pr:tpsdev-ai/cli#42": ["sherlock"] });

    expect(calls.length).toBe(0);
  });

  test("does not send reminder for merged PRs", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "merged",
      lastTransitionAt: longAgo,
      reminderSentAt: null,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender, {});

    expect(calls.length).toBe(0);
  });
});

describe("printStatus", () => {
  test("prints JSON status when requested", () => {
    const state = makeState({
      "pr:tpsdev-ai/cli#42": makeInstance(),
    });
    const logs: string[] = [];
    const originalLog = console.log;
    patchShared(console, "log", (value?: unknown) => {
      logs.push(String(value));
    });

    try {
      printStatus({ json: true }, state);
    } finally {
      patchShared(console, "log", originalLog);
    }

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.lastPollAt).toBe(state.lastPollAt);
    expect(parsed.activeCount).toBe(1);
    expect(Array.isArray(parsed.active)).toBe(true);
    expect(parsed.active[0].prNumber).toBe(42);
  });
});

describe("pollOnce", () => {
  test("new PR triggers opened mail to reviewers", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const state = makeState();

    const runner: SyncRunner = (cmd, args) => {
      const endpoint = args[2];
      if (endpoint?.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 10, title: "Add feature", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
          ]),
          stderr: "",
        } as ReturnType<SyncRunner>;
      }
      if (endpoint?.includes("/reviews")) {
        return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
      }
      return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
    };

    pollOnce(config, state, runner, sender);

    // Should have created instance and sent mail to reviewers
    expect(state.instances["pr:tpsdev-ai/cli#10"]).toBeDefined();
    expect(state.instances["pr:tpsdev-ai/cli#10"].state).toBe("opened");
    expect(calls.length).toBe(2);
    expect(calls[0].to).toBe("sherlock");
    expect(calls[1].to).toBe("kern");
    expect(calls[0].body).toContain("New PR #10");
  });

  test("existing PR with new approval triggers approved mail", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const instance = makeInstance({
      state: "reviewing",
      prNumber: 10,
      repo: "tpsdev-ai/cli",
      title: "Add feature",
    });
    const state = makeState({ "pr:tpsdev-ai/cli#10": instance });

    const runner: SyncRunner = (cmd, args) => {
      const endpoint = args[2];
      if (endpoint?.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 10, title: "Add feature", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
          ]),
          stderr: "",
        } as ReturnType<SyncRunner>;
      }
      if (endpoint?.includes("/reviews")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { state: "APPROVED", user: { login: "sherlock" } },
            { state: "APPROVED", user: { login: "kern" } },
          ]),
          stderr: "",
        } as ReturnType<SyncRunner>;
      }
      return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
    };

    pollOnce(config, state, runner, sender);

    expect(instance.state).toBe("approved");
    expect(calls.length).toBe(1);
    expect(calls[0].to).toBe("flint");
    expect(calls[0].body).toContain("merge-ready");
  });

  test("gh api failure for one PR does not stop others", () => {
    const config = makeConfig();
    const { calls, sender } = trackMails();
    const state = makeState();

    let reviewCallCount = 0;
    const runner: SyncRunner = (cmd, args) => {
      const endpoint = args[2];
      if (endpoint?.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 10, title: "PR A", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
            { number: 11, title: "PR B", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
          ]),
          stderr: "",
        } as ReturnType<SyncRunner>;
      }
      if (endpoint?.includes("/reviews")) {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          // First PR reviews fail
          return { status: 1, stdout: "", stderr: "API error" } as ReturnType<SyncRunner>;
        }
        return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
      }
      return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
    };

    pollOnce(config, state, runner, sender);

    // PR #10 failed, but PR #11 should still be tracked
    expect(state.instances["pr:tpsdev-ai/cli#10"]).toBeUndefined();
    expect(state.instances["pr:tpsdev-ai/cli#11"]).toBeDefined();
    expect(calls.length).toBe(2); // mail for PR #11 to both reviewers
  });
});

// ---------------------------------------------------------------------------
// pruneState
// ---------------------------------------------------------------------------

describe("pruneState", () => {
  function makeTerminalInstance(state: PrState, daysOld: number): PrInstance {
    const ts = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    return {
      key: `pr:tpsdev-ai/cli#99`,
      repo: "tpsdev-ai/cli",
      prNumber: 99,
      title: "Old PR",
      state,
      openedAt: ts,
      lastTransitionAt: ts,
      reminderSentAt: null,
      history: [],
    };
  }

  test("removes merged instances older than pruneAfterDays", () => {
    const state: PulseState = {
      version: 1,
      lastPollAt: "",
      instances: {
        "pr:tpsdev-ai/cli#1": makeTerminalInstance("merged", 8),
        "pr:tpsdev-ai/cli#2": makeTerminalInstance("merged", 3),
      },
    };
    const pruned = pruneState(state, 7);
    expect(pruned).toBe(1);
    expect(state.instances["pr:tpsdev-ai/cli#1"]).toBeUndefined();
    expect(state.instances["pr:tpsdev-ai/cli#2"]).toBeDefined();
  });

  test("keeps non-terminal instances regardless of age", () => {
    const state: PulseState = {
      version: 1,
      lastPollAt: "",
      instances: {
        "pr:tpsdev-ai/cli#10": makeTerminalInstance("reviewing" as PrState, 30),
      },
    };
    const pruned = pruneState(state, 7);
    expect(pruned).toBe(0);
    expect(state.instances["pr:tpsdev-ai/cli#10"]).toBeDefined();
  });

  test("returns 0 when nothing to prune", () => {
    const state: PulseState = { version: 1, lastPollAt: "", instances: {} };
    expect(pruneState(state, 7)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flair publisher (handleTransition integration)
// ---------------------------------------------------------------------------

describe("startPollLoop", () => {
  let root: string;
  let saved: Record<string, string | undefined>;
  let flair: ReturnType<typeof startUnverifiedFetchFlair>;
  beforeEach(() => {
    saved = { HOME: process.env.HOME, TPS_TEST_KEYS_DIR: process.env.TPS_TEST_KEYS_DIR };
    root = mkdtempSync(join(tmpdir(), "pulse-loop-"));
    process.env.HOME = root;
    delete process.env.TPS_TEST_KEYS_DIR;
    const dir = join(root, ".tps", "identity");
    mkdirSync(dir, { recursive: true });
    const seed = Buffer.alloc(32, 0x78);
    writeFileSync(join(dir, "pulse.key"), seed);
    flair = startUnverifiedFetchFlair({ pulse: seed });
  });
  afterEach(() => {
    flair.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  });
  test("does not resolve immediately after the first poll", async () => {
    const config = makeConfig({ pollIntervalMs: 120000, flairUrl: flair.url });
    const state = makeState();

    let pollCalls = 0;
    const runner: SyncRunner = (_cmd, args) => {
      const endpoint = args[2];
      if (endpoint?.includes("/pulls?")) {
        pollCalls++;
      }
      return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
    };

    const handles: Array<{ fn: () => void }> = [];
    const setIntervalFn: typeof setInterval = ((fn: TimerHandler) => {
      handles.push({ fn: fn as () => void });
      return handles.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const clearIntervalFn: typeof clearInterval = (() => {}) as typeof clearInterval;

    let resolved = false;
    const loopPromise = startPollLoop(config, state, {
      dryRun: true,
      runner,
      setIntervalFn,
      clearIntervalFn,
    }).then(() => {
      resolved = true;
    });

    for (let i = 0; i < 20 && handles.length === 0; i++) await Promise.resolve();

    expect(pollCalls).toBe(1);
    expect(handles).toHaveLength(2);
    expect(resolved).toBe(false);

    process.emit("SIGTERM");
    await loopPromise;
    expect(resolved).toBe(true);
  });
});

describe("FlairPublisher integration", () => {
  test("publisher is called on transition", async () => {
    const calls: Array<{ key: string; from: PrState | null; to: PrState }> = [];
    const publisher: FlairPublisher = async (key, from, to) => {
      calls.push({ key, from, to });
    };

    const instance: PrInstance = {
      key: "pr:tpsdev-ai/cli#42",
      repo: "tpsdev-ai/cli",
      prNumber: 42,
      title: "Test PR",
      state: "reviewing",
      openedAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      reminderSentAt: null,
      history: [],
    };
    const config = makeConfig();
    const mailCalls: string[] = [];
    const sender: MailSender = (to) => { mailCalls.push(to); };

    handleTransition("pr:tpsdev-ai/cli#42", instance, "approved", config, sender, publisher);

    // Give microtask queue a tick
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe("reviewing");
    expect(calls[0].to).toBe("approved");
  });

  test("publisher errors are swallowed (non-fatal)", async () => {
    const publisher: FlairPublisher = async () => {
      throw new Error("Flair unavailable");
    };

    const instance: PrInstance = {
      key: "pr:tpsdev-ai/cli#1",
      repo: "tpsdev-ai/cli",
      prNumber: 1,
      title: "T",
      state: "reviewing",
      openedAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      reminderSentAt: null,
      history: [],
    };
    const config = makeConfig();
    const sender: MailSender = () => {};

    // Should not throw
    expect(() => {
      handleTransition("pr:tpsdev-ai/cli#1", instance, "approved", config, sender, publisher);
    }).not.toThrow();

    // Give microtask queue a tick — error is caught internally
    await Promise.resolve();
  });

  test("publisher is not called when state unchanged", async () => {
    const calls: string[] = [];
    const publisher: FlairPublisher = async (_, _from, to) => { calls.push(to); };

    const instance: PrInstance = {
      key: "pr:tpsdev-ai/cli#5",
      repo: "tpsdev-ai/cli",
      prNumber: 5,
      title: "T",
      state: "approved",
      openedAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      reminderSentAt: null,
      history: [],
    };
    const config = makeConfig();
    const sender: MailSender = () => {};

    handleTransition("pr:tpsdev-ai/cli#5", instance, "approved", config, sender, publisher);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mail send failure resilience
//
// The published PATH shim hung forever on mail send, and spawnSync had no
// timeout.  One undeliverable message wedged the pulse daemon permanently.
// These tests assert that a failed or hung sender does not block subsequent
// notifications.
// ---------------------------------------------------------------------------

describe("mail send failure resilience", () => {
  // ── Ember's tests (kept — complementary coverage) ──────────────────

  test("sendMail catches sender errors and continues the loop", () => {
    const config = makeConfig();
    const { calls } = trackMails();
    const instance = makeInstance({ state: "opened" });

    let callCount = 0;
    const failingSender: MailSender = (to, body, agentId) => {
      callCount++;
      if (callCount === 1) throw new Error("simulated send hang/failure");
      calls.push({ to, body, agentId });
    };

    // handleTransition for opened → approved sends 1 mail to mergeAuthority.
    expect(() => {
      handleTransition("pr:tpsdev-ai/cli#42", instance, "approved", config, failingSender);
    }).not.toThrow();

    expect(instance.state).toBe("approved");

    // Second transition should succeed
    expect(() => {
      handleTransition("pr:tpsdev-ai/cli#42", instance, "merged", config, failingSender);
    }).not.toThrow();

    expect(instance.state).toBe("merged");
    expect(calls.length).toBe(1);
    expect(calls[0].to).toBe("anvil");
  });

  test("pollOnce continues processing PRs when mail send fails for one PR", () => {
    const config = makeConfig();
    const { calls } = trackMails();
    const state = makeState();

    let callCount = 0;
    const failingSender: MailSender = (to, body, agentId) => {
      callCount++;
      if (callCount <= 2) throw new Error("simulated send failure for first PR");
      calls.push({ to, body, agentId });
    };

    const runner: SyncRunner = (_cmd, args) => {
      const endpoint = args[2];
      if (endpoint?.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 10, title: "PR A", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
            { number: 11, title: "PR B", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
          ]),
          stderr: "",
        } as ReturnType<SyncRunner>;
      }
      if (endpoint?.includes("/reviews")) {
        return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
      }
      return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
    };

    expect(() => {
      pollOnce(config, state, runner, failingSender);
    }).not.toThrow();

    expect(state.instances["pr:tpsdev-ai/cli#10"]).toBeDefined();
    expect(state.instances["pr:tpsdev-ai/cli#11"]).toBeDefined();
    expect(calls.length).toBe(2);
    expect(calls[0].body).toContain("PR #11");
    expect(calls[1].body).toContain("PR #11");
  });

  // ── Hang + timeout tests (anvil) ───────────────────────────────────

  test("hung sender does not block subsequent notifications", () => {
    const config = makeConfig();
    const state = makeState();

    const mailLog: string[] = [];
    let hangCount = 0;

    const sender: MailSender = (to, _body, _agentId) => {
      if (hangCount === 0) {
        hangCount++;
        return new Promise<void>(() => {}); // never resolves
      }
      mailLog.push(to);
    };

    const runner: SyncRunner = (_cmd, args) => {
      const endpoint = args[2];
      if (endpoint?.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 10, title: "PR A", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
            { number: 11, title: "PR B", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
          ]),
          stderr: "",
        } as ReturnType<SyncRunner>;
      }
      if (endpoint?.includes("/reviews")) {
        return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
      }
      return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
    };

    pollOnce(config, state, runner, sender);

    expect(state.instances["pr:tpsdev-ai/cli#10"]).toBeDefined();
    expect(state.instances["pr:tpsdev-ai/cli#11"]).toBeDefined();
    // First PR's first mail hung; 3 mails succeed (kern for PR #10,
    // sherlock + kern for PR #11).
    expect(mailLog.length).toBe(3);
    expect(mailLog[0]).toBe("kern");
    expect(mailLog[1]).toBe("sherlock");
    expect(mailLog[2]).toBe("kern");
  });

  test("slow async sender is timed out, subsequent notifications still delivered", async () => {
    setSendTimeoutMs(100);
    const config = makeConfig();
    const state = makeState();

    const errors: string[] = [];
    const originalError = console.error;
    patchShared(console, "error", (msg: string) => { errors.push(msg); });

    const mailLog: string[] = [];
    let slowResolved = false;

    try {
      const sender: MailSender = (to, _body, _agentId) => {
        if (to === "sherlock") {
          return new Promise<void>((resolve) => {
            setTimeout(() => { slowResolved = true; resolve(); }, 500);
          });
        }
        mailLog.push(to);
      };

      const runner: SyncRunner = (_cmd, args) => {
        const endpoint = args[2];
        if (endpoint?.includes("/pulls?")) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { number: 10, title: "PR A", state: "open", merged_at: null, user: { login: "anvil" }, requested_reviewers: [] },
            ]),
            stderr: "",
          } as ReturnType<SyncRunner>;
        }
        if (endpoint?.includes("/reviews")) {
          return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
        }
        return { status: 0, stdout: "[]", stderr: "" } as ReturnType<SyncRunner>;
      };

      pollOnce(config, state, runner, sender);

      await new Promise((r) => setTimeout(r, 200));

      expect(errors.some((e) => e.includes("timed out after 100ms"))).toBe(true);
      expect(slowResolved).toBe(false);
      expect(mailLog).toContain("kern");
    } finally {
      patchShared(console, "error", originalError);
      setSendTimeoutMs(5_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Pulse notification mail uses its own principal.

describe("pulse identity (cli#397)", () => {
  test("notification sender receives pulse rather than the gh agent", () => {
    const config = makeConfig({ ghAgent: "some-gh-agent" });
    const { calls, sender } = trackMails();
    const instance = makeInstance({ state: "reviewing" });

    handleTransition("pr:tpsdev-ai/cli#42", instance, "approved", config, sender);

    expect(calls.length).toBe(1);
    expect(calls[0].agentId).toBe("pulse");
  });

  for (const [newState, missing, message] of [
    ["approved", "mergeAuthority", /merge authority/],
    ["changes-requested", "author", /author/],
    ["merged", "author", /author/],
  ] as const) {
    test(`handleTransition refuses ${newState} without ${missing} before state or publish`, () => {
      const config = makeConfig();
      delete config[missing];
      const { calls, sender } = trackMails();
      const instance = makeInstance({ state: "reviewing" });
      const before = structuredClone(instance);
      let publishes = 0;
      const publisher = async () => { publishes++; };
      expect(() => handleTransition("pr:tpsdev-ai/cli#42", instance, newState, config, sender, publisher)).toThrow(message);
      expect(instance).toEqual(before);
      expect(publishes).toBe(0);
      expect(calls).toEqual([]);
    });
  }

  test("pollOnce refuses to poll with no ghAgent", () => {
    const config = makeConfig();
    delete config.ghAgent;
    const state = makeState();
    const runner: SyncRunner = () =>
      ({ status: 0, stdout: "[]", stderr: "" }) as ReturnType<SyncRunner>;

    expect(() => pollOnce(config, state, runner, () => {})).toThrow(/gh agent/);
  });
});


describe("polling recipient refusal", () => {
  for (const path of ["new", "pre-existing", "existing"] as const) {
    for (const [computed, review, missing, message] of [
      ["approved", "APPROVED", "mergeAuthority", /merge authority/],
      ["changes-requested", "CHANGES_REQUESTED", "author", /author/],
      ["merged", "APPROVED", "author", /author/],
    ] as const) {
      test(`${path} ${computed} leaves state unchanged without ${missing}`, () => {
        const config = makeConfig();
        delete config[missing];
        const key = "pr:tpsdev-ai/cli#42";
        const state = makeState(path === "existing" ? { [key]: makeInstance({ state: "reviewing" }) } : {});
        const before = structuredClone(state);
        const { calls, sender } = trackMails();
        let publishes = 0;
        const runner: SyncRunner = (_cmd, args) => ({
          status: 0,
          stdout: JSON.stringify(args[2].includes("/reviews")
            ? [{ state: review, user: { login: "tps-sherlock" } }]
            : [{ number: 42, title: "Changed title", state: "open",
                merged_at: computed === "merged" ? new Date().toISOString() : null,
                created_at: new Date(Date.now() + (path === "pre-existing" ? -60000 : 60000)).toISOString() }]),
          stderr: "",
        }) as ReturnType<SyncRunner>;
        expect(() => pollOnce(config, state, runner, sender, async () => { publishes++; })).toThrow(message);
        expect(state).toEqual(before);
        expect(calls).toEqual([]);
        expect(publishes).toBe(0);
      });
    }
  }

  test("tracked closed PR refuses missing author before changing state", () => {
    const config = makeConfig({ author: undefined });
    const state = makeState({ "pr:tpsdev-ai/cli#42": makeInstance({ state: "approved" }) });
    const before = structuredClone(state);
    const { calls, sender } = trackMails();
    let publishes = 0;
    const runner: SyncRunner = (_cmd, args) => ({ status: 0, stderr: "",
      stdout: JSON.stringify(args[2].includes("/pulls?") ? [] : { merged_at: new Date().toISOString() }),
    }) as ReturnType<SyncRunner>;
    expect(() => pollOnce(config, state, runner, sender, async () => { publishes++; })).toThrow(/author/);
    expect(state).toEqual(before);
    expect(calls).toEqual([]);
    expect(publishes).toBe(0);
  });

  test("unchanged approved PR refuses missing merge recipient before changing title", () => {
    const config = makeConfig({ mergeAuthority: undefined });
    const state = makeState({ "pr:tpsdev-ai/cli#42": makeInstance({ state: "approved" }) });
    const before = structuredClone(state);
    const { calls, sender } = trackMails();
    const runner: SyncRunner = (_cmd, args) => ({ status: 0, stderr: "", stdout: JSON.stringify(
      args[2].includes("/reviews") ? [{ state: "APPROVED", user: { login: "tps-sherlock" } }]
      : args[2].includes("/status") ? { state: "success" }
      : [{ number: 42, title: "Changed title", state: "open", merged_at: null, head: { sha: "test" } }]),
    }) as ReturnType<SyncRunner>;
    expect(() => pollOnce(config, state, runner, sender)).toThrow(/merge authority/);
    expect(state).toEqual(before);
    expect(calls).toEqual([]);
  });

  test("poll reminder escalation refuses before an existing title changes", () => {
    const config = makeConfig({ mergeAuthority: undefined });
    const key = "pr:tpsdev-ai/cli#42";
    const state = makeState({ [key]: makeInstance({ reviewRequestedAt: new Date(0).toISOString() }) });
    const before = structuredClone(state);
    const { calls, sender } = trackMails();
    const runner: SyncRunner = (_cmd, args) => ({ status: 0, stderr: "", stdout: JSON.stringify(
      args[2].includes("/reviews") ? [] : [{ number: 42, title: "Changed title", state: "open", merged_at: null }]),
    }) as ReturnType<SyncRunner>;
    expect(() => pollOnce(config, state, runner, sender)).toThrow(/merge authority/);
    expect(state).toEqual(before);
    expect(calls).toEqual([]);
  });

  test("missing escalation recipient prevents reminders for earlier instances", () => {
    const config = makeConfig({ mergeAuthority: undefined });
    const state = makeState({
      first: makeInstance({ reviewRequestedAt: "2026-01-01T00:30:00Z" }),
      second: makeInstance({ reviewRequestedAt: "2026-01-01T00:00:00Z" }),
    });
    const before = structuredClone(state);
    const { calls, sender } = trackMails();
    expect(() => checkReminders(state, config, sender, { first: ["sherlock"], second: ["kern"] }, new Date("2026-01-01T01:05:00Z"))).toThrow(/merge authority/);
    expect(state).toEqual(before);
    expect(calls).toEqual([]);
  });

  for (const lastRemindedAt of [undefined, "2026-01-01T00:01:00Z"]) {
    test(`escalation refuses before reminder mail or state (${lastRemindedAt ?? "first reminder"})`, () => {
      const config = makeConfig({ mergeAuthority: undefined });
      const key = "pr:tpsdev-ai/cli#42";
      const state = makeState({ [key]: makeInstance({
        reviewRequestedAt: "2026-01-01T00:00:00Z", lastRemindedAt,
      }) });
      const before = structuredClone(state);
      const { calls, sender } = trackMails();
      expect(() => checkReminders(state, config, sender, { [key]: ["sherlock"] }, new Date("2026-01-01T01:05:00Z"))).toThrow(/merge authority/);
      expect(state).toEqual(before);
      expect(calls).toEqual([]);
    });
  }
});


describe("identity shape preflight", () => {
  let root: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    root = mkdtempSync(join(tmpdir(), "pulse-config-"));
    process.env.HOME = root;
    mkdirSync(join(root, ".tps", "pulse"), { recursive: true });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });
  for (const field of ["mergeAuthority", "ghAgent", "author"] as const) {
    for (const value of [undefined, null, false, 42, {}, [], "", "   "]) {
      test(`${field} refuses ${JSON.stringify(value)} at load and every preflight`, async () => {
        const config = makeConfig({ [field]: value } as Partial<PulseConfig>);
        const path = join(root, ".tps", "pulse", "config.json");
        writeFileSync(path, JSON.stringify(config));
        const originalFile = readFileSync(path, "utf8");
        const error = new RegExp(field);
        expect(() => loadConfig()).toThrow(error);
        const instance = makeInstance({ state: "reviewing" });
        const state = makeState({ pr: instance });
        const original = structuredClone(state);
        let calls = 0;
        const sender: MailSender = () => { calls++; };
        const publisher: FlairPublisher = async () => { calls++; };
        const runner: SyncRunner = () => { calls++; throw new Error("must not poll"); };
        expect(() => handleTransition("pr", instance, "approved", config, sender, publisher)).toThrow(error);
        expect(() => checkReminders(state, config, sender, { pr: ["reviewer"] })).toThrow(error);
        expect(() => pollOnce(config, state, runner, sender, publisher)).toThrow(error);
        await expect(startPollLoop(config, state, { dryRun: true, runner, sender, publisher,
          setIntervalFn: (() => { calls++; }) as typeof setInterval })).rejects.toThrow(error);
        expect(calls).toBe(0);
        expect(state).toEqual(original);
        expect(readFileSync(path, "utf8")).toBe(originalFile);
        expect(existsSync(join(root, ".tps", "pulse", "state.json"))).toBe(false);
      });
    }
  }
  test("valid configured identities load unchanged", () => {
    const config = makeConfig({ ghAgent: " github ", author: " author ", mergeAuthority: " merger " });
    writeFileSync(join(root, ".tps", "pulse", "config.json"), JSON.stringify(config));
    expect(loadConfig()).toMatchObject(config);
  });
});
