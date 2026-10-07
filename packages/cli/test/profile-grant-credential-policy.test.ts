import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as nono from "../src/utils/nono.js";
import { cliEnv, makeSandbox } from "./helpers/runtime-launch-fixture.js";

const profileGrantRefusal = (
  nono as unknown as {
    sandboxProfileGrantRefusal?: (profile: string, env: NodeJS.ProcessEnv, runtime?: string) => string | null;
  }
).sandboxProfileGrantRefusal;

const homes: string[] = [];

/** A throwaway HOME with the credential roots and a nono profile directory. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tps-518-"));
  for (const d of ["auth", "identity", "secrets"]) {
    mkdirSync(join(home, ".tps", d), { recursive: true });
  }
  mkdirSync(join(home, ".config", "nono", "profiles"), { recursive: true });
  homes.push(home);
  return home;
}

function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...extra };
}

/** Write the profile the claude-code launch resolves, in the fixture HOME. */
function writeProfile(home: string, body: unknown, name = "tps-agent-run-claude-code"): string {
  const path = join(home, ".config", "nono", "profiles", `${name}.json`);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("cli#518 — a sandbox profile's filesystem grants are checked against the credential policy", () => {
  test.skipIf(!profileGrantRefusal)("a profile granting the credential store names the grant and the root", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { allow: ["~/.tps/secrets"] } });
    const reason = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code");
    expect(reason).toContain(join(home, ".tps", "secrets"));
    expect(reason).toContain("~/.tps/secrets");
    expect(reason).toContain("filesystem.allow");
  });

  test.skipIf(!profileGrantRefusal)("a profile grant resolved through a symlink into a credential root is refused", () => {
    const home = makeHome();
    const link = join(home, "grant-link");
    symlinkSync(join(home, ".tps", "auth"), link);
    writeProfile(home, { filesystem: { read: [link] } });
    const reason = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code");
    expect(reason).toContain(link);
    expect(reason).toContain("~/.tps/auth");
  });

  test.skipIf(!profileGrantRefusal)("a profile with no protected grant is not refused", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { read: ["/usr", "/bin"], allow_file: ["/dev/null"] } });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code")).toBeNull();
  });

  test.skipIf(!profileGrantRefusal)("a credential grant in a profile the sandbox profile extends is refused", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { allow: ["~/.tps/identity"] } }, "tps-base-fixture");
    writeProfile(home, { extends: "tps-base-fixture" });
    const reason = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code");
    expect(reason).toContain("~/.tps/identity");
  });

  test.skipIf(!profileGrantRefusal)("a profile that cannot be read is refused, not treated as granting nothing", () => {
    const home = makeHome();
    writeProfile(home, "{ this is not json");
    const reason = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code");
    expect(reason).toContain("cannot read the sandbox profile");
  });

  test.skipIf(!profileGrantRefusal)("a profile that is not found yields no refusal here", () => {
    const home = makeHome();
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code")).toBeNull();
  });
});

describe("cli#518 — a runtime directory inside the sandbox profile directory is refused", () => {
  const profileDir = (home: string) => join(home, ".config", "nono", "profiles");

  test("directly, naming the variable and the profile directory", () => {
    const home = makeHome();
    const reason = nono.approveRuntimeNonoOptions(
      "claude-code",
      { cwd: join(home, "ws") },
      envFor(home, { CLAUDE_CONFIG_DIR: profileDir(home) }),
    ).refusal;
    expect(reason).toContain("CLAUDE_CONFIG_DIR");
    expect(reason).toContain(profileDir(home));
  });

  test("via a symlink into the profile directory", () => {
    const home = makeHome();
    const link = join(home, "profile-link");
    symlinkSync(profileDir(home), link);
    const reason = nono.approveRuntimeNonoOptions(
      "claude-code",
      { cwd: join(home, "ws") },
      envFor(home, { CLAUDE_CONFIG_DIR: link }),
    ).refusal;
    expect(reason).toContain("CLAUDE_CONFIG_DIR");
  });

  test("an unrelated runtime directory is not refused", () => {
    const home = makeHome();
    const reason = nono.approveRuntimeNonoOptions(
      "claude-code",
      { cwd: join(home, "ws") },
      envFor(home, { CLAUDE_CONFIG_DIR: join(home, "claude-custom") }),
    ).refusal;
    expect(reason).toBeNull();
  });
});

describe("cli#518 — the launch refuses a profile or runtime directory that reaches the credential policy", () => {
  const runLaunch = (sb: ReturnType<typeof makeSandbox>, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
      cwd: sb.ws,
      env: cliEnv(sb, { HOME: sb.home, ...extra }),
      encoding: "utf8",
      timeout: 10_000,
    });

  test("a launch whose sandbox profile grants the credential store is refused", () => {
    const sb = makeSandbox();
    try {
      writeProfile(sb.home, { filesystem: { allow: [join(sb.home, ".tps", "secrets")] } });
      const r = runLaunch(sb);
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(78);
      expect(text).toContain(join(sb.home, ".tps", "secrets"));
      expect(text).toContain("~/.tps/secrets");
      expect(text).not.toContain("HANDOFF ");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a launch whose runtime directory is the profile directory is refused", () => {
    const sb = makeSandbox();
    try {
      const r = runLaunch(sb, { CLAUDE_CONFIG_DIR: join(sb.home, ".config", "nono", "profiles") });
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(78);
      expect(text).toContain("CLAUDE_CONFIG_DIR");
      expect(text).not.toContain("HANDOFF ");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a launch whose runtime directory is a symlink into the profile directory is refused", () => {
    const sb = makeSandbox();
    try {
      const link = join(sb.root, "profile-link");
      symlinkSync(join(sb.home, ".config", "nono", "profiles"), link);
      const r = runLaunch(sb, { CLAUDE_CONFIG_DIR: link });
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(78);
      expect(text).toContain("CLAUDE_CONFIG_DIR");
      expect(text).not.toContain("HANDOFF ");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a valid launch still proceeds", () => {
    const sb = makeSandbox();
    try {
      const r = runLaunch(sb, { CLAUDE_CONFIG_DIR: join(sb.root, "claude-custom") });
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(0);
      expect(text).toContain("HANDOFF ");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
