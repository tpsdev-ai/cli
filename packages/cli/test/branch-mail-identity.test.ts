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

  it("resolves the configured branch id", () => {
    process.env.TPS_AGENT_ID = "host-a";
    expect(branchAgentId(undefined)).toBe("host-a");
    expect(branchAgentId(undefined)).not.toBe("anvil");
  });
});
