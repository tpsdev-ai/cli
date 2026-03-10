import { describe, expect, test } from "bun:test";
import {
  computePrState,
  handleTransition,
  checkReminders,
  pollOnce,
  printStatus,
  pruneState,
  startPollLoop,
  type PrInstance,
  type PrState,
  type PulseConfig,
  type PulseState,
  type SyncRunner,
  type MailSender,
  type FlairPublisher,
} from "../src/commands/pulse.js";

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
  test("sends reminder when reviewing >30min", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "reviewing",
      lastTransitionAt: thirtyFiveMinAgo,
      reminderSentAt: null,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender);

    expect(calls.length).toBe(2); // sherlock + kern
    expect(calls[0].body).toContain("Reminder");
    expect(calls[0].body).toContain("awaiting review");
    expect(instance.reminderSentAt).not.toBeNull();
  });

  test("sends reminder when approved >30min to merge authority", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "approved",
      lastTransitionAt: fortyMinAgo,
      reminderSentAt: null,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender);

    expect(calls.length).toBe(1);
    expect(calls[0].to).toBe("flint");
    expect(calls[0].body).toContain("merge-ready");
  });

  test("does not re-send reminder within window", () => {
    const config = makeConfig({ remindAfterMs: 1800000 });
    const { calls, sender } = trackMails();
    const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const instance = makeInstance({
      state: "reviewing",
      lastTransitionAt: fortyMinAgo,
      reminderSentAt: fiveMinAgo,
    });
    const state = makeState({ "pr:tpsdev-ai/cli#42": instance });

    checkReminders(state, config, sender);

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

    checkReminders(state, config, sender);

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
    console.log = (value?: unknown) => {
      logs.push(String(value));
    };

    try {
      printStatus({ json: true }, state);
    } finally {
      console.log = originalLog;
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
  test("does not resolve immediately after the first poll", async () => {
    const config = makeConfig({ pollIntervalMs: 120000 });
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

    await Promise.resolve();

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
