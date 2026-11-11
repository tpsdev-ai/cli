import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "..", "scripts", "test-docker-bun-version.sh");

test("the Bun pin fixtures refuse a HELPER override before any helper or Docker call", () => {
  const result = spawnSync("bash", [FIXTURE], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HELPER: "/tmp/other-bun-version.sh" },
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("HELPER is not an override");
  expect(result.stderr).toContain("got: /tmp/other-bun-version.sh");
});
