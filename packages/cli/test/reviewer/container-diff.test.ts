import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const filter = resolve(here, "../../../../scripts/reviewer/filter-container-diff.mjs");

function unexpected(diff: string): string {
  const result = spawnSync("node", [filter], { input: diff, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("A3 container diff filter", () => {
  test("accepts only Docker's init injection", () => {
    expect(unexpected("C /usr\nC /usr/sbin\nA /usr/sbin/docker-init\n")).toBe("");
  });

  test("rejects another file under /usr even with docker-init present", () => {
    const result = unexpected("C /usr\nC /usr/sbin\nA /usr/sbin/docker-init\nA /usr/sbin/evil\n");
    expect(result).toContain("A /usr/sbin/evil\n");
  });

  test("rejects a change under /etc", () => {
    expect(unexpected("C /etc/shadow\n")).toBe("C /etc/shadow\n");
  });

  test("accepts an empty diff", () => {
    expect(unexpected("")).toBe("");
  });

  test("parent directory changes require the init file", () => {
    expect(unexpected("C /usr\nC /usr/sbin\n")).toBe("C /usr\nC /usr/sbin\n");
  });
});
