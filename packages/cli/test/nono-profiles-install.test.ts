/**
 * cli#341 S1b — installNonoProfiles migration clause (spec v1/v2, the window-closer).
 *
 * nono resolves `extends` BY NAME across locations, with ~/.config/nono/profiles
 * first — so a stale installed profile shadows the bundled deny list for every
 * child everywhere. installNonoProfiles must therefore overwrite a TPS profile
 * whose content differs (content-hash versioned), retire a stale TPS-named
 * *.toml, and never touch user-authored NON-TPS profiles.
 *
 * Fails-first: on `main` the copy is `if (!existsSync(dst))` — no overwrite, no
 * toml retirement — so the first two cases below fail.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { installNonoProfiles } from "../src/utils/nono.js";

let home: string;
let profilesDir: string;
let origHome: string | undefined;
let origPath: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-install-"));
  origHome = process.env.HOME;
  origPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = "/nonexistent-nono-bin"; // no nono → install skips validation, stays deterministic
  profilesDir = join(home, ".config", "nono", "profiles");
  mkdirSync(profilesDir, { recursive: true });
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origPath !== undefined) process.env.PATH = origPath;
  else delete process.env.PATH;
  rmSync(home, { recursive: true, force: true });
});

describe("installNonoProfiles migration", () => {
  test("overwrites a stale TPS profile whose content differs (bundled deny list wins)", () => {
    // A weaker installed tps-base: no TPS denies at all.
    writeFileSync(
      join(profilesDir, "tps-base.json"),
      JSON.stringify({
        extends: "default",
        meta: { name: "tps-base", version: "1.0.0" },
        filesystem: { deny: [] },
      }),
      "utf-8",
    );

    installNonoProfiles(profilesDir, true);

    const installed = JSON.parse(readFileSync(join(profilesDir, "tps-base.json"), "utf-8"));
    expect(installed.meta.version).toBe("2.0.0");
    expect(installed.filesystem.deny).toContain("~/.tps/secrets");
    expect(installed.filesystem.deny).toContain("~/.openclaw/openclaw.json");
  });

  test("retires a stale TPS-named .toml profile", () => {
    writeFileSync(join(profilesDir, "tps-agent.toml"), '[meta]\nname = "tps-agent"\n');

    installNonoProfiles(profilesDir, true);

    expect(existsSync(join(profilesDir, "tps-agent.toml"))).toBe(false);
  });

  test("leaves user-authored NON-TPS profiles untouched", () => {
    const userJson = '{"meta":{"name":"my-user-profile"}}\n';
    writeFileSync(join(profilesDir, "foo.json"), userJson, "utf-8");
    writeFileSync(join(profilesDir, "bar.toml"), "user-authored toml\n", "utf-8");

    installNonoProfiles(profilesDir, true);

    expect(readFileSync(join(profilesDir, "foo.json"), "utf-8")).toBe(userJson);
    expect(existsSync(join(profilesDir, "bar.toml"))).toBe(true);
  });

  test("is idempotent: a second install does not rewrite identical content", () => {
    installNonoProfiles(profilesDir, true);
    const before = readFileSync(join(profilesDir, "tps-base.json"), "utf-8");

    installNonoProfiles(profilesDir, true);

    expect(readFileSync(join(profilesDir, "tps-base.json"), "utf-8")).toBe(before);
  });

  test("completes when a stale child is seeded before its parent (two-pass install, cli#351 r3)", () => {
    // Stale weak child present; its parent (tps-base) is absent. Validating in
    // the same pass as copying is order-dependent (readdir is arbitrary) and
    // aborts mid-install, leaving exactly the partial shadowing state the
    // migration exists to prevent.
    writeFileSync(
      join(profilesDir, "tps-agent-run.json"),
      JSON.stringify({
        extends: "tps-base",
        meta: { name: "tps-agent-run", version: "0.0.0" },
        filesystem: { read: ["/"] },
      }),
      "utf-8",
    );
    // Fake nono on PATH so validation runs AND resolves `extends` by name.
    const fakeDir = join(import.meta.dir, "fakes/nono/bin");
    process.env.PATH = `${fakeDir}:${origPath ?? ""}`;

    installNonoProfiles(profilesDir, true);

    const names = readdirSync(profilesDir);
    expect(names.filter((f) => f.endsWith(".json")).length).toBe(13);
    expect(names).toContain("tps-base.json");
    const child = JSON.parse(readFileSync(join(profilesDir, "tps-agent-run.json"), "utf-8"));
    expect(child.meta.version).toBe("2.0.0"); // bundled wins over the stale child
    expect(child.filesystem.read).not.toContain("/");
  });
});
