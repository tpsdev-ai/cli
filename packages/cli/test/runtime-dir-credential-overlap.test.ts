/**
 * cli#483 — a selected runtime's custom directory must not equal, contain or sit
 * inside a TPS credential root, and no inherited launch grant (the implicit
 * current-directory grant included) may reach another runtime's credentials.
 *
 * Fails-first: the guard is new on this branch, so the refusal cases below see
 * no refusal on `main` and fail. The guard is reached through the module
 * namespace so this file still LOADS there — a named import of an export `main`
 * does not have aborts the file — which makes the failure an assertion, not a
 * load error. The allow cases guard against over-refusal on the branch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nono from "../src/utils/nono.js";

interface Grants {
  workdir?: string;
  cwd?: string;
  read?: readonly string[];
  allow?: readonly string[];
}

const guard = (
  nono as unknown as {
    runtimeDirCredentialRefusal?: (
      runtime: string | undefined,
      grants: Grants,
      env: NodeJS.ProcessEnv,
    ) => string | null;
  }
).runtimeDirCredentialRefusal;

/** The guard under test, or a null verdict on `main` (where it does not exist). */
function refusal(runtime: string | undefined, grants: Grants, env: NodeJS.ProcessEnv): string | null {
  return guard ? guard(runtime, grants, env) : null;
}

const homes: string[] = [];

/** A throwaway HOME with the three credential roots present. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tps-483-"));
  for (const d of ["auth", "identity", "secrets"]) {
    mkdirSync(join(home, ".tps", d), { recursive: true });
  }
  homes.push(home);
  return home;
}

function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...extra };
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("cli#483 — a custom runtime directory overlapping a TPS credential root is refused", () => {
  test("CLAUDE_CONFIG_DIR at ~/.tps/auth names the variable and the root", () => {
    const home = makeHome();
    const auth = join(home, ".tps", "auth");
    const reason = refusal(
      "claude-code",
      { allow: [auth], cwd: join(home, "ws") },
      envFor(home, { CLAUDE_CONFIG_DIR: auth }),
    );
    expect(reason).toContain("CLAUDE_CONFIG_DIR");
    expect(reason).toContain("~/.tps/auth");
  });

  test("CLAUDE_CONFIG_DIR at an ancestor of a credential root is refused", () => {
    const home = makeHome();
    const reason = refusal("claude-code", {}, envFor(home, { CLAUDE_CONFIG_DIR: home }));
    expect(reason).toContain("CLAUDE_CONFIG_DIR");
  });

  test("a CLAUDE_CONFIG_DIR symlink into ~/.tps/auth is refused", () => {
    const home = makeHome();
    const link = join(home, "claude-link");
    symlinkSync(join(home, ".tps", "auth"), link);
    const reason = refusal("claude-code", {}, envFor(home, { CLAUDE_CONFIG_DIR: link }));
    expect(reason).toContain("CLAUDE_CONFIG_DIR");
    expect(reason).toContain("~/.tps/auth");
  });

  test("an unrelated CLAUDE_CONFIG_DIR is not refused", () => {
    const home = makeHome();
    const custom = join(home, "claude-custom");
    const reason = refusal(
      "claude-code",
      { allow: [custom, join(home, ".claude")], cwd: join(home, "ws") },
      envFor(home, { CLAUDE_CONFIG_DIR: custom }),
    );
    expect(reason).toBeNull();
  });
});

describe("cli#483 — the codex and gemini directory variables are checked the same way", () => {
  test("CODEX_HOME at ~/.tps/identity names CODEX_HOME", () => {
    const home = makeHome();
    const reason = refusal("codex", {}, envFor(home, { CODEX_HOME: join(home, ".tps", "identity") }));
    expect(reason).toContain("CODEX_HOME");
    expect(reason).toContain("~/.tps/identity");
  });

  test("XDG_CONFIG_HOME placing the gemini dir inside ~/.tps/auth names XDG_CONFIG_HOME", () => {
    const home = makeHome();
    const reason = refusal("gemini", {}, envFor(home, { XDG_CONFIG_HOME: join(home, ".tps", "auth") }));
    expect(reason).toContain("XDG_CONFIG_HOME");
    expect(reason).toContain("~/.tps/auth");
  });

  test("an unrelated directory for each runtime is not refused", () => {
    const home = makeHome();
    const codex = join(home, "codex-custom");
    const codexReason = refusal(
      "codex",
      { allow: [codex, join(home, ".config", "codex")] },
      envFor(home, { CODEX_HOME: codex }),
    );
    expect(codexReason).toBeNull();
    const geminiReason = refusal(
      "gemini",
      { allow: [join(home, ".gemini"), join(home, ".config", "gemini")] },
      envFor(home),
    );
    expect(geminiReason).toBeNull();
  });
});

describe("cli#483 — every inherited launch grant is checked the same way", () => {
  test("a current-directory grant inside a credential root is refused", () => {
    const home = makeHome();
    const reason = refusal("claude-code", { cwd: join(home, ".tps", "auth") }, envFor(home));
    expect(reason).toContain("current-directory grant");
    expect(reason).toContain("~/.tps/auth");
  });

  test("a workdir grant inside the secrets dir is refused", () => {
    const home = makeHome();
    const reason = refusal("claude-code", { workdir: join(home, ".tps", "secrets") }, envFor(home));
    expect(reason).toContain("workdir grant");
    expect(reason).toContain("~/.tps/secrets");
  });

  test("a dir grant that covers another runtime's credential file is refused", () => {
    const home = makeHome();
    // Codex's home pointed at Claude's config dir reaches Claude's credentials.
    const reason = refusal(
      "codex",
      { allow: [join(home, ".claude")] },
      envFor(home, { CODEX_HOME: join(home, ".claude") }),
    );
    expect(reason).toContain(".credentials.json");
  });

  test("a read grant covering a credential root is refused", () => {
    const home = makeHome();
    const reason = refusal("claude-code", { read: [join(home, ".tps", "identity")] }, envFor(home));
    expect(reason).toContain("read grant");
    expect(reason).toContain("~/.tps/identity");
  });
});
