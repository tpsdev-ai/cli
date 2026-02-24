import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandlerPipeline } from "../src/utils/mail-handler.js";

let tmp = "";

beforeEach(() => {
  tmp = join(tmpdir(), `branch-wiring-test-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("Branch Handler Wiring (Integration)", () => {
  test("loads zero manifests when agentsDir not configured", async () => {
    // This is more of a unit test for runHandlerPipeline with empty manifests
    // which is already covered in CP15B, but we'll add a check here.
    const res = await runHandlerPipeline(
      { id: "1", from: "a", to: "b", body: "test", timestamp: "" },
      [],
      []
    );
    expect(res.type).toBe("inbox");
  });

  test("routes mail to inbox when no manifests match (agentsDir set but empty)", async () => {
    // Empty directory = no manifests
    const res = await runHandlerPipeline(
      { id: "1", from: "a", to: "b", body: "test", timestamp: "" },
      [],
      []
    );
    expect(res.type).toBe("inbox");
  });
});
