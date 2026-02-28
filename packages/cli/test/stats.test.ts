import { describe, expect, test } from "bun:test";
import { aggregateStats } from "../src/commands/stats.js";

describe("stats aggregation", () => {
  test("aggregates llm.request events by provider:model", () => {
    const rows = aggregateStats([
      { type: "llm.request", provider: "anthropic", model: "sonnet", inputTokens: 100, outputTokens: 20 },
      { type: "llm.request", provider: "anthropic", model: "sonnet", inputTokens: 50, outputTokens: 10 },
      { type: "tool.call", tool: "read" },
    ] as any);

    const row = rows.get("anthropic:sonnet");
    expect(row).toBeDefined();
    expect(row!.requests).toBe(2);
    expect(row!.inTok).toBe(150);
    expect(row!.outTok).toBe(30);
  });

  test("filters by agent", () => {
    const rows = aggregateStats([
      { type: "llm.request", provider: "google", model: "g", inputTokens: 10, outputTokens: 1, agent: "a" },
      { type: "llm.request", provider: "google", model: "g", inputTokens: 30, outputTokens: 2, agent: "b" },
    ] as any, "a");

    const row = rows.get("google:g");
    expect(row!.inTok).toBe(10);
    expect(row!.outTok).toBe(1);
  });
});
