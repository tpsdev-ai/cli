import { beforeEach, describe, expect, it } from "bun:test";
import { getHooks, resetHooks } from "../../src/plugins/hooks.js";
import { applyRole } from "../../src/plugins/roles.js";

describe("applyRole", () => {
  beforeEach(() => resetHooks());

  it("registers review filter hook for reviewer role", () => {
    applyRole({ role: "reviewer" }, "sherlock");
    expect(getHooks("mail.received").length).toBe(1);
    expect(getHooks("mail.received")[0]?.name).toBe("sherlock-review-filter");
  });

  it("registers task cleanup hook for implementer role", () => {
    applyRole({ role: "implementer" }, "ember");
    expect(getHooks("task.after").length).toBe(1);
  });

  it("no hooks for strategist role", () => {
    applyRole({ role: "strategist" }, "flint");
    expect(getHooks("mail.received").length).toBe(0);
    expect(getHooks("task.after").length).toBe(0);
  });
});
