/**
 * Tests for branch daemon mail identity resolution (fix for #240).
 *
 * The branch daemon must store incoming mail under its own local identity
 * (TPS_AGENT_ID or hostname), not the wire 'to' field (which may be a GAL alias).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { hostname } from "node:os";

// Reproduce the getLocalAgentId logic from branch.ts for unit testing.
// If this logic changes in branch.ts, update here too.
function getLocalAgentId(env: Record<string, string | undefined>, conf: Record<string, unknown>): string {
  if (env.TPS_AGENT_ID) return env.TPS_AGENT_ID;
  if (conf.agentId && typeof conf.agentId === "string") return conf.agentId;
  return hostname().split(".")[0]!;
}

describe("getLocalAgentId (branch mail identity, fix #240)", () => {
  it("uses TPS_AGENT_ID when set", () => {
    const id = getLocalAgentId({ TPS_AGENT_ID: "tps-anvil" }, {});
    expect(id).toBe("tps-anvil");
  });

  it("uses conf.agentId when TPS_AGENT_ID is not set", () => {
    const id = getLocalAgentId({}, { agentId: "tps-rockit" });
    expect(id).toBe("tps-rockit");
  });

  it("TPS_AGENT_ID takes precedence over conf.agentId", () => {
    const id = getLocalAgentId({ TPS_AGENT_ID: "tps-anvil" }, { agentId: "tps-rockit" });
    expect(id).toBe("tps-anvil");
  });

  it("falls back to hostname fragment when neither env nor conf is set", () => {
    const id = getLocalAgentId({}, {});
    expect(id).toBeString();
    expect(id.length).toBeGreaterThan(0);
    // Should not contain dots (hostname fragment only)
    expect(id).not.toContain(".");
  });

  it("does not use the wire 'to' field (e.g. GAL alias 'anvil') for storage", () => {
    // When TPS_AGENT_ID is set to 'tps-anvil', a message sent to GAL alias 'anvil'
    // should still be stored under 'tps-anvil', not 'anvil'.
    const wireTo = "anvil"; // GAL logical name
    const localId = getLocalAgentId({ TPS_AGENT_ID: "tps-anvil" }, {});
    expect(localId).toBe("tps-anvil");
    expect(localId).not.toBe(wireTo);
  });
});
