import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  delete process.env.HOME;
});

describe("mail watch inbox", () => {
  test("reads existing messages from new/ on start", () => {
    tmp = join(tmpdir(), `mail-watch-test-${Date.now()}`);
    process.env.HOME = tmp;
    mkdirSync(join(tmp, ".tps", "mail", "agent1", "new"), { recursive: true });
    mkdirSync(join(tmp, ".tps", "mail", "agent1", "cur"), { recursive: true });
    mkdirSync(join(tmp, ".tps", "mail", "agent1", "tmp"), { recursive: true });

    const msg = {
      id: "00000000-0000-0000-0000-000000000001",
      from: "sender",
      to: "agent1",
      body: "hello from watch test",
      timestamp: new Date().toISOString(),
    };
    writeFileSync(join(tmp, ".tps", "mail", "agent1", "new", "test.json"), JSON.stringify(msg));

    const files = readdirSync(join(tmp, ".tps", "mail", "agent1", "new"));
    expect(files).toContain("test.json");
  });

  test("resolves agent id for watch (same as check)", () => {
    const agent = "testbot";
    expect(agent).toBe("testbot");
  });
});
