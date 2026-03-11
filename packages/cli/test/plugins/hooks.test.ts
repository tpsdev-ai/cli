import { beforeEach, describe, expect, it } from "bun:test";
import { getHooks, registerHook, resetHooks, runHooks } from "../../src/plugins/hooks.js";

describe("HookRegistry", () => {
  beforeEach(() => resetHooks());

  it("runs hooks in priority order", async () => {
    const order: string[] = [];

    registerHook("agent.boot", {
      name: "second",
      priority: 20,
      fn: async () => {
        order.push("second");
      },
    });

    registerHook("agent.boot", {
      name: "first",
      priority: 10,
      fn: async () => {
        order.push("first");
      },
    });

    await runHooks("agent.boot", { agentId: "test" });
    expect(order).toEqual(["first", "second"]);
  });

  it("returns results from each hook", async () => {
    registerHook("task.before", {
      name: "inject",
      priority: 10,
      fn: async () => ({ prepend: "context" }),
    });

    const results = await runHooks("task.before", { agentId: "test" });
    expect(results).toEqual([{ prepend: "context" }]);
  });

  it("runs empty hook list without error", async () => {
    const results = await runHooks("agent.ready", { agentId: "test" });
    expect(results).toEqual([]);
    expect(getHooks("agent.ready")).toEqual([]);
  });
});
