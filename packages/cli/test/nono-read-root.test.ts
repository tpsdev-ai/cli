/**
 * cli#341 S1b — the old blanket `--read /` must be gone (fails-first).
 *
 * A root grant is refused by nono 0.70+ (exit 1), and it was the whole-sandbox
 * read root the SPEC replaces with the explicit, validated toolchain set. This
 * file deliberately imports NOTHING from the changed modules so it fails on
 * `main` (where `read: [identityDir, bunDir, "/"]` and the TOML profiles are
 * still present) as a real assertion failure, not a module-load error.
 */
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PKG = join(import.meta.dir, ".."); // packages/cli
const PROFILES = join(PKG, "nono-profiles");

test("no launch line grants --read / (cli#341 S1b)", () => {
  const agentSrc = readFileSync(join(PKG, "src/commands/agent.ts"), "utf-8");
  // `read: [ ... "/" ]` — a bare filesystem-root read grant.
  expect(agentSrc).not.toMatch(/read:\s*\[[^\]]*["']\/["']/);
  expect(agentSrc).not.toContain("--read /");
});

test("no generated profile grants the filesystem root", () => {
  expect(existsSync(PROFILES)).toBe(true);
  const json = readdirSync(PROFILES).filter((f) => f.endsWith(".json"));
  expect(json.length).toBeGreaterThan(0);
  for (const f of json) {
    const p = JSON.parse(readFileSync(join(PROFILES, f), "utf-8"));
    const entries = [
      ...(p.filesystem?.read ?? []),
      ...(p.filesystem?.allow ?? []),
      ...(p.filesystem?.readwrite ?? []),
      ...(p.filesystem?.writable ?? []),
    ];
    expect(entries, `${f} grants the filesystem root`).not.toContain("/");
  }
});

test("profiles are the v2 shape: JSON with `extends`", () => {
  const json = readdirSync(PROFILES).filter((f) => f.endsWith(".json"));
  expect(json.length).toBeGreaterThan(0);
  for (const f of json) {
    const p = JSON.parse(readFileSync(join(PROFILES, f), "utf-8"));
    expect(typeof p.extends, `${f} has no extends`).toBe("string");
    expect(typeof p.meta?.name, `${f} has no meta.name`).toBe("string");
  }
});

test("no pre-2.0 TOML profiles remain bundled", () => {
  const toml = readdirSync(PROFILES).filter((f) => f.endsWith(".toml"));
  expect(toml).toEqual([]);
});
