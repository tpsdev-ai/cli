import { beforeEach, describe, expect, it } from "bun:test";
import { getSlot, registerSlot, resetRegistry } from "../../src/plugins/registry.js";
import type { MemoryProvider } from "../../src/plugins/registry.js";

const mockMemory: MemoryProvider = {
  search: async () => [],
  write: async () => ({ id: "test-1" }),
  read: async () => null,
  bootstrap: async () => "context",
  ping: async () => true,
};

describe("SlotRegistry", () => {
  beforeEach(() => resetRegistry());

  it("starts with null slots", () => {
    expect(getSlot("memory")).toBeNull();
  });

  it("registers and retrieves a provider", () => {
    registerSlot("memory", mockMemory);
    expect(getSlot("memory")).toBe(mockMemory);
  });

  it("replaces existing provider", () => {
    registerSlot("memory", mockMemory);
    const other: MemoryProvider = { ...mockMemory, ping: async () => false };
    registerSlot("memory", other);
    expect(getSlot("memory")).toBe(other);
  });
});
