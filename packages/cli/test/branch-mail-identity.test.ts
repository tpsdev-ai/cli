/**
 * Tests for branch daemon mail identity resolution (fix for #240; cli#499 removed
 * the hostname fallback). The branch daemon stores incoming mail under its own
 * local identity (TPS_AGENT_ID, or the id persisted by `tps branch init --agent`),
 * not the wire 'to' field (which may be a GAL alias), and refuses by name when
 * neither is configured.
 */
import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { branchAgentId } from "../src/commands/branch.js";

const savedAgentId = process.env.TPS_AGENT_ID;
beforeEach(() => { delete process.env.TPS_AGENT_ID; });
afterEach(() => {
  if (savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
  else process.env.TPS_AGENT_ID = savedAgentId;
});

describe("branch mail identity (fix #240, cli#499)", () => {
  it("uses TPS_AGENT_ID when set", () => {
    process.env.TPS_AGENT_ID = "host-a";
    expect(branchAgentId(undefined)).toBe("host-a");
  });

  it("uses the persisted conf id when TPS_AGENT_ID is not set", () => {
    expect(branchAgentId("host-b")).toBe("host-b");
  });

  it("TPS_AGENT_ID takes precedence over the persisted conf id", () => {
    process.env.TPS_AGENT_ID = "host-a";
    expect(branchAgentId("host-b")).toBe("host-a");
  });

  it("refuses by name when neither env nor conf is set", () => {
    expect(() => branchAgentId(undefined)).toThrow(/no branch agent id/);
  });

  it("does not use the wire 'to' field (e.g. GAL alias 'anvil') for storage", () => {
    // When TPS_AGENT_ID is set to 'host-a', a message sent to GAL alias 'anvil'
    // should still be stored under 'host-a', not 'anvil'.
    process.env.TPS_AGENT_ID = "host-a";
    expect(branchAgentId(undefined)).toBe("host-a");
    expect(branchAgentId(undefined)).not.toBe("anvil");
  });
});
