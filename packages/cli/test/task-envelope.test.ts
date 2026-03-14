import { describe, it, expect } from "bun:test";
import { parseTaskEnvelope, formatTaskEnvelope, createTaskEnvelope } from "../src/utils/task-envelope.js";

describe("parseTaskEnvelope", () => {
  it("parses a valid task.assign envelope", () => {
    const body = JSON.stringify({
      type: "task.assign",
      taskId: "ops-119",
      title: "Global Address List",
      priority: "P0",
    });
    const result = parseTaskEnvelope(body);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("task.assign");
    expect(result!.taskId).toBe("ops-119");
    expect(result!.title).toBe("Global Address List");
  });

  it("parses task.done envelope", () => {
    const body = JSON.stringify({
      type: "task.done",
      taskId: "ops-117",
      pr: "https://github.com/tpsdev-ai/cli/pull/240",
      message: "All tests passing.",
    });
    const result = parseTaskEnvelope(body);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("task.done");
  });

  it("returns null for plain text", () => {
    expect(parseTaskEnvelope("hello there")).toBeNull();
    expect(parseTaskEnvelope("Mail delivered to remote branch 'anvil'.")).toBeNull();
  });

  it("returns null for non-task JSON", () => {
    expect(parseTaskEnvelope(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseTaskEnvelope(JSON.stringify({ type: "other.thing", taskId: "x" }))).toBeNull();
  });

  it("returns null for JSON array", () => {
    expect(parseTaskEnvelope(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  it("returns null for empty or missing taskId", () => {
    expect(parseTaskEnvelope(JSON.stringify({ type: "task.assign" }))).toBeNull();
    expect(parseTaskEnvelope(JSON.stringify({ type: "task.assign", taskId: "" }))).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseTaskEnvelope("{ not valid json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTaskEnvelope("")).toBeNull();
  });
});

describe("formatTaskEnvelope", () => {
  it("formats task.assign with title and priority", () => {
    const result = formatTaskEnvelope({
      type: "task.assign",
      taskId: "ops-119",
      title: "Global Address List",
      priority: "P0",
    });
    expect(result).toBe("[task.assign] ops-119: Global Address List (P0)");
  });

  it("formats task.assign without priority", () => {
    const result = formatTaskEnvelope({
      type: "task.assign",
      taskId: "ops-117",
      title: "Task Delivery Format",
    });
    expect(result).toBe("[task.assign] ops-117: Task Delivery Format");
  });

  it("formats task.done with pr", () => {
    const result = formatTaskEnvelope({
      type: "task.done",
      taskId: "ops-119",
      pr: "https://github.com/tpsdev-ai/cli/pull/238",
    });
    expect(result).toContain("[task.done] ops-119");
    expect(result).toContain("https://github.com");
  });

  it("formats task.blocked with reason", () => {
    const result = formatTaskEnvelope({
      type: "task.blocked",
      taskId: "ops-117",
      reason: "Can't access ops repo",
    });
    expect(result).toContain("[task.blocked] ops-117");
    expect(result).toContain("Can't access ops repo");
  });

  it("formats task.review.done with verdict", () => {
    const result = formatTaskEnvelope({
      type: "task.review.done",
      taskId: "ops-119",
      pr: "https://github.com/tpsdev-ai/cli/pull/238",
      verdict: "approved",
    });
    expect(result).toContain("approved");
  });

  it("formats minimal envelope (type + taskId only)", () => {
    const result = formatTaskEnvelope({ type: "task.ack", taskId: "ops-100" });
    expect(result).toBe("[task.ack] ops-100");
  });
});

describe("createTaskEnvelope", () => {
  it("creates valid task.assign JSON", () => {
    const body = createTaskEnvelope("task.assign", {
      taskId: "ops-120",
      title: "Bootstrap script",
      priority: "P1",
    });
    const parsed = JSON.parse(body);
    expect(parsed.type).toBe("task.assign");
    expect(parsed.taskId).toBe("ops-120");
    expect(parsed.title).toBe("Bootstrap script");
  });

  it("round-trips through parseTaskEnvelope", () => {
    const body = createTaskEnvelope("task.assign", { taskId: "ops-120", title: "Test" });
    const envelope = parseTaskEnvelope(body);
    expect(envelope).not.toBeNull();
    expect(envelope!.taskId).toBe("ops-120");
  });

  it("throws for invalid type", () => {
    expect(() => createTaskEnvelope("not-a-task", { taskId: "x" })).toThrow();
    expect(() => createTaskEnvelope("", { taskId: "x" })).toThrow();
  });

  it("throws for missing taskId", () => {
    expect(() => createTaskEnvelope("task.assign", {})).toThrow();
    expect(() => createTaskEnvelope("task.assign", { taskId: "" })).toThrow();
  });

  it("strips undefined fields from output", () => {
    const body = createTaskEnvelope("task.assign", {
      taskId: "ops-120",
      title: "Test",
      spec: undefined,
      branch: undefined,
    });
    const parsed = JSON.parse(body);
    expect(parsed.spec).toBeUndefined();
    expect(parsed.branch).toBeUndefined();
  });
});
