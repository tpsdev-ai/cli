import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
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
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NONO_BIN: join(import.meta.dir, "fakes/nono/bin/nono"), NONO_FAKE_LOG: join(home, "nono.log"), ...extra };
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

describe("effective profile access query", () => {
  test("queries the relocated foreign credential with the selected binary and resolved profile", () => {
    const home = makeHome();
    const path = writeProfile(home, { extends: "default" });
    const env = envFor(home, { CODEX_HOME: join(home, ".local", "bin"), NONO_FAKE_WHY_OUTPUT: JSON.stringify({ status: "allowed", reason: "granted_path", granted_path: join(home, ".local", "bin"), access: "readwrite", source: "user_tools" }) });
    const refusal = profileGrantRefusal!("tps-agent-run-claude-code", env, "claude-code");
    expect(refusal).toContain("nono reports read access");
    expect(refusal).toContain('reason="granted_path"');
    expect(refusal).toContain(`granted_path=${JSON.stringify(join(home, ".local", "bin"))}`);
    expect(refusal).toContain('access="readwrite"');
    expect(refusal).toContain('source="user_tools"');
    expect(refusal).toContain(join(env.CODEX_HOME!, "auth.json"));
    expect(readFileSync(join(home, "nono.log"), "utf8")).toContain(`--profile ${path}`);
  });

  test("queries foreign credentials and profile directories", () => {
    const home = makeHome();
    writeProfile(home, { extends: "default" });
    const env = envFor(home, { CODEX_HOME: join(home, ".local", "bin") });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", env, "claude-code")).toBeNull();
    const log = readFileSync(join(home, "nono.log"), "utf8");
    expect(log).toContain(`--path ${join(env.CODEX_HOME!, "auth.json")} --op read`);
    expect(log).toContain(`--path ${join(env.CODEX_HOME!, "auth.json")} --op write`);
    expect(log).toContain(`--path ${join(home, ".config", "nono", "profiles")} --op write`);
    expect(log).toContain(`--path ${join(home, ".tps", "auth", "anthropic.json")}`);
    expect(log).not.toContain(`--path ${join(home, ".claude", ".credentials.json")}`);
  });

  for (const output of ['not json', '{}', '{"status":"unknown"}', '{"status":"denied"}', '[]', '{"status":false}', '{"status":"denied"} trailing', '{"status":"denied","reason":"invalid_query"}', '{"status":"denied","reason":["path_not_granted"]}']) {
    test(`refuses query output ${output}`, () => {
      const home = makeHome();
      writeProfile(home, { extends: "default" });
      expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home, { NONO_FAKE_WHY_OUTPUT: output }), "claude-code")).toContain("cannot query");
    });
  }

  test("refuses a query subprocess failure", () => {
    const home = makeHome();
    writeProfile(home, {});
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home, { NONO_FAKE_WHY_FAIL: "1" }))).toContain("cannot query");
  });

  for (const [name, script] of [["signal", "kill -TERM $$"], ["timeout", "exec sleep 10"]]) {
    test(`refuses query ${name}`, () => {
      const home = makeHome();
      writeProfile(home, {});
      const bin = join(home, "query-nono");
      writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home, { NONO_BIN: bin }))).toContain("cannot query");
    }, 7_000);
  }

  for (const bin of ["", "nono", "/missing/nono"]) {
    test(`refuses unavailable query binary ${JSON.stringify(bin)}`, () => {
      const home = makeHome();
      writeProfile(home, {});
      const refusal = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home, { NONO_BIN: bin }));
      expect(refusal).toContain("cannot query");
      if (!bin || bin === "nono") expect(refusal).toContain("Install nono >= 0.70 or set NONO_BIN");
    });
  }
});

describe("cli#518 profile grants", () => {
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

  test.skipIf(!profileGrantRefusal)("malformed JSON is refused", () => {
    const home = makeHome();
    writeProfile(home, "{ this is not json");
    const reason = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code");
    expect(reason).toContain("cannot read the sandbox profile");
  });

  test.skipIf(!profileGrantRefusal)("a missing profile is refused", () => {
    const home = makeHome();
    expect(profileGrantRefusal!("missing-fixture", envFor(home), "claude-code")).toContain("cannot resolve");
  });

  for (const key of ["read", "allow", "write", "read_file", "allow_file", "write_file"]) {
    for (const conditional of [false, true]) {
      test(`${key} ${conditional ? "conditional-path" : "string"} protected grant is refused`, () => {
        const home = makeHome();
        const path = join(home, ".tps", "secrets", "fixture");
        writeProfile(home, { filesystem: { [key]: [conditional ? { path, when: ["linux", "macos"] } : path] } });
        const reason = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home), "claude-code");
        expect(reason).toContain(`filesystem.${key}`);
        expect(reason).toContain("~/.tps/secrets");
      });
    }
    test(`${key} glob is refused by name`, () => {
      const home = makeHome();
      writeProfile(home, { filesystem: { [key]: [join(home, ".tps", "*", "**")] } });
      expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain(`filesystem.${key} glob`);
    });
  }

  test("a writable profile grant at the profile directory is refused", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { write: [join(home, ".config", "nono", "profiles")] } });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("sandbox profile directory");
  });

  test("inheritance with a different XDG_CONFIG_HOME is refused by name", () => {
    const home = makeHome();
    writeProfile(home, { extends: "default" });
    const refusal = profileGrantRefusal!("tps-agent-run-claude-code", envFor(home, { XDG_CONFIG_HOME: join(home, "xdg") }));
    expect(refusal).toContain("XDG_CONFIG_HOME");
    expect(refusal).toContain("unset XDG_CONFIG_HOME for launches or set it to HOME/.config");
  });

  test("inheritance by path is refused by name", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { read: ["~/.tps/secrets"] } }, "protected-parent");
    writeProfile(home, { extends: "./protected-parent.json" });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("unsupported extends path");
  });

  test("array inheritance checks a later parent", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { read: ["/usr"] } }, "safe-parent");
    writeProfile(home, { filesystem: { write: [join(home, ".tps", "auth")] } }, "protected-parent");
    writeProfile(home, { extends: ["safe-parent", "protected-parent"] });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("filesystem.write");
  });

  for (const platform of ["macos", "linux", "windows"]) {
    test(`${platform} platform override is refused by name`, () => {
      const home = makeHome();
      writeProfile(home, { platform_overrides: { [platform]: { filesystem: { allow: ["~/.tps/secrets"] } } } });
      expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("unsupported platform_overrides");
    });
  }

  test("a harmless conditional read is accepted", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { read: [{ path: "/usr", when: "linux" }] } });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toBeNull();
  });

  test("a protected conditional read is checked even when inactive", () => {
    const home = makeHome();
    writeProfile(home, { filesystem: { read: [{ path: "~/.tps/auth", when: "windows" }] } });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("~/.tps/auth");
  });

  test("an unresolved built-in parent is refused by name", () => {
    const home = makeHome();
    writeProfile(home, { extends: "claude-code" });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("extends");
  });

  for (const path of ["$HOME/.tps/secrets", "$WORKDIR", "./secrets"]) {
    test(`path expansion ${path} is refused by name`, () => {
      const home = makeHome();
      writeProfile(home, { filesystem: { read: [path] } });
      expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("path expansion");
    });
  }

  test("profile identity reads and agent-bound launch identity reads differ", () => {
    const home = makeHome();
    const key = join(home, ".tps", "identity", "probe.key");
    writeFileSync(key, "fixture");
    writeProfile(home, { filesystem: { read_file: [key] } });
    expect(profileGrantRefusal!("tps-agent-run-claude-code", envFor(home))).toContain("~/.tps/identity");
    expect(nono.approveRuntimeNonoOptions(undefined, { readFiles: [key] }, envFor(home), "probe").refusal).toBeNull();
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

  for (const kind of ["allow", "workdir", "cwd"] as const) {
    for (const ancestor of [false, true]) {
      test(`${kind} ${ancestor ? "ancestor" : "direct"} profile-directory grant is refused`, () => {
        const home = makeHome();
        const path = ancestor ? join(home, ".config") : profileDir(home);
        const grants = kind === "allow" ? { allow: [path] } : { [kind]: path };
        expect(nono.approveRuntimeNonoOptions(undefined, grants, envFor(home)).refusal).toContain("sandbox profile directory");
      });
    }
  }

});

describe("cli#518 launch checks", () => {
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

  test("the default AgentRuntime launch checks its profile", () => {
    const sb = makeSandbox();
    try {
      writeProfile(sb.home, { filesystem: { read: [join(sb.home, ".tps", "auth")] } }, "tps-agent-run");
      const r = runLaunch(sb, { TPS_TEST_DEFAULT_RUNTIME: "1" });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(78);
      expect(`${r.stdout}${r.stderr}`).toContain("filesystem.read");
      expect(`${r.stdout}${r.stderr}`).not.toContain("HANDOFF ");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("a launch with TMPDIR at the profile directory is refused", () => {
    const sb = makeSandbox();
    try {
      const r = runLaunch(sb, { TMPDIR: join(sb.home, ".config", "nono", "profiles"), TPS_TEST_DEFAULT_RUNTIME: "1" });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(78);
      expect(`${r.stdout}${r.stderr}`).toContain("sandbox profile directory");
      expect(`${r.stdout}${r.stderr}`).not.toContain("HANDOFF ");
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

  test("a default AgentRuntime launch proceeds with the fixture profile", () => {
    const sb = makeSandbox();
    try {
      const r = runLaunch(sb, { TPS_TEST_DEFAULT_RUNTIME: "1" });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('"profile":"tps-agent-run"');
      expect(`${r.stdout}${r.stderr}`).toContain("HANDOFF ");
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
