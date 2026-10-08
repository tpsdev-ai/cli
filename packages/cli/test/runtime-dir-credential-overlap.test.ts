import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import * as nono from "../src/utils/nono.js";
import { cliEnv, makeSandbox } from "./helpers/runtime-launch-fixture.js";
import { providerAuthPath, runtimeCredentialFiles, runtimeProviders, type CredentialRuntime } from "../src/utils/runtime-credentials.js";

interface Grants {
  workdir?: string;
  cwd?: string;
  read?: readonly string[];
  allow?: readonly string[];
  readFiles?: readonly string[];
  allowFiles?: readonly string[];
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

describe("cli#483 — credential files and approved targets", () => {
  for (const writable of [true, false]) {
    test.skipIf(!writable && process.getuid?.() === 0)(`an overlapping workspace is refused without filesystem creation (writable=${writable})`, () => {
      const sb = makeSandbox();
      const auth = join(sb.home, ".tps", "auth");
      mkdirSync(auth);
      const workspace = join(auth, "workspace");
      const configPath = join(sb.home, ".tps", "agents", "probe", "agent.yaml");
      writeFileSync(configPath, readFileSync(configPath, "utf8")
        .replace(`workspace: ${sb.ws}`, `workspace: ${workspace}`)
        .replace(`mailDir: ${join(sb.home, ".tps", "mail")}`, `mailDir: ${join(sb.root, "new-mail")}`)
        .replace(`memoryPath: ${join(sb.home, ".tps", "agents", "probe", "memory.jsonl")}`, `memoryPath: ${join(sb.root, "new-memory", "memory.jsonl")}`));
      if (!writable) chmodSync(auth, 0o500);
      try {
        const before = readdirSync(sb.root, { recursive: true }).sort();
        const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
          cwd: sb.ws, env: cliEnv(sb, { HOME: sb.home }), encoding: "utf8", timeout: 10_000,
        });
        const text = `${r.stdout}${r.stderr}`;
        expect(r.status, text).toBe(78);
        expect(text).toContain("refusing to launch runtime 'claude-code'");
        expect(text).toContain("workdir grant");
        expect(text).toContain("~/.tps/auth");
        expect(text).not.toContain("HANDOFF ");
        expect(readdirSync(sb.root, { recursive: true }).sort()).toEqual(before);
      } finally {
        chmodSync(auth, 0o700);
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  for (const component of [".tps", ".TPS"]) {
    test(`an absent credential root is protected on a case-insensitive volume (${component})`, () => {
      const sb = makeSandbox();
      try {
        const custom = join(sb.home, component, "AUTH", "Runtime");
        expect(existsSync(join(sb.home, ".tps", "auth"))).toBe(false);
        const before = readdirSync(sb.root, { recursive: true }).sort();
        const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
          cwd: sb.ws,
          env: cliEnv(sb, { HOME: sb.home, CLAUDE_CONFIG_DIR: custom,
            TPS_TEST_CASE_INSENSITIVE_ROOT: existsSync(join(sb.root, "HOME")) ? undefined : sb.root }),
          encoding: "utf8", timeout: 10_000,
        });
        const text = `${r.stdout}${r.stderr}`;
        expect(r.status, text).toBe(78);
        expect(text).toContain("CLAUDE_CONFIG_DIR");
        expect(text).toContain("~/.tps/auth");
        expect(text).not.toContain("HANDOFF ");
        expect(readdirSync(sb.root, { recursive: true }).sort()).toEqual(before);
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  for (const runtime of Object.keys(runtimeProviders) as CredentialRuntime[]) {
    test(`${runtime}: every auth reader candidate is protected from other runtimes`, () => {
      const sb = makeSandbox();
      try {
        const env = cliEnv(sb, {
          HOME: sb.home, CLAUDE_CONFIG_DIR: join(sb.home, "claude-custom"),
          CODEX_HOME: join(sb.home, "codex-custom"), XDG_CONFIG_HOME: join(sb.home, ".config"),
        });
        const paths = runtimeCredentialFiles(runtime, env);
        if (runtime === "codex") expect(paths).toContain(join(sb.home, ".config", "codex", "auth.json"));
        if (runtime === "claude-code") expect(paths).toContain(join(sb.home, ".claude", ".credentials.json"));
        const bin = join(sb.root, "auth-bin");
        mkdirSync(bin);
        for (const name of ["claude", "gemini"]) {
          const path = join(bin, name);
          writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        }
        for (const path of paths) {
          mkdirSync(dirname(path), { recursive: true });
          const creds = runtime === "claude-code"
            ? { claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh" } }
            : { access_token: "fixture-access", refresh_token: "fixture-refresh" };
          writeFileSync(path, JSON.stringify(creds));
          const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-auth-path-driver.ts"), runtimeProviders[runtime]], {
            cwd: sb.ws, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: "utf8", timeout: 10_000,
          });
          expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
          expect(JSON.parse(readFileSync(providerAuthPath(runtimeProviders[runtime], env), "utf8")).refreshToken).toBe("fixture-refresh");
          for (const other of Object.keys(runtimeProviders).filter((rt) => rt !== runtime)) {
            expect(refusal(other, { read: [dirname(path)] }, env)).toContain(path);
            expect(refusal(other, { readFiles: [path] }, env)).toContain(path);
            expect(refusal(other, { allowFiles: [path] }, env)).toContain(path);
          }
          unlinkSync(path);
        }
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

  for (const kind of ["readFiles", "allowFiles"] as const) {
    test(`${kind}: an own file with a foreign credential target is refused`, () => {
      const home = makeHome();
      const foreign = providerAuthPath("openai", envFor(home));
      writeFileSync(foreign, "fixture");
      const own = join(home, ".claude.json");
      symlinkSync(foreign, own);
      const reason = refusal("claude-code", { [kind]: [own] }, envFor(home));
      expect(reason).toContain(own);
      expect(reason).toContain(foreign);
    });

    test(`${kind}: another file inside a TPS credential root is refused by name`, () => {
      const home = makeHome();
      const own = join(home, ".claude.json");
      symlinkSync(join(home, ".tps", "secrets", "fixture"), own);
      const reason = refusal("claude-code", { [kind]: [own] }, envFor(home));
      expect(reason).toContain(own);
      expect(reason).toContain("~/.tps/secrets");
    });
  }

  test("the launching agent's identity and Codex's auth file are permitted", () => {
    const home = makeHome();
    const env = envFor(home);
    const key = join(home, ".tps", "identity", "probe.key");
    const auth = providerAuthPath("openai", env);
    expect(nono.approveRuntimeNonoOptions("codex", { readFiles: [key], allowFiles: [auth] }, env, "probe").refusal).toBeNull();
    const peer = join(home, ".tps", "identity", "peer.key");
    symlinkSync(peer, key);
    expect(nono.approveRuntimeNonoOptions("codex", { readFiles: [key] }, env, "probe").refusal).toContain("~/.tps/identity");
  });

  test("a file outside the runtime's permitted files is refused", () => {
    const home = makeHome();
    expect(refusal("claude-code", { allowFiles: [join(home, "unrelated")] }, envFor(home))).toContain("not a permitted file");
  });

  test("the launch refuses a runtime file with a foreign credential target", () => {
    const sb = makeSandbox();
    try {
      const foreign = join(sb.home, ".config", "codex", "auth.json");
      mkdirSync(dirname(foreign), { recursive: true });
      writeFileSync(foreign, "fixture");
      const own = join(sb.home, ".claude.json");
      symlinkSync(foreign, own);
      const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
        cwd: sb.ws, env: cliEnv(sb, { HOME: sb.home }), encoding: "utf8", timeout: 10_000,
      });
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(78);
      expect(text).toContain(own);
      expect(text).toContain(foreign);
      expect(text).not.toContain("HANDOFF ");
      expect(existsSync(join(sb.home, ".claude"))).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("the launch hands canonical grants and runtime directories to attestation", () => {
    const sb = makeSandbox();
    try {
      const target = join(sb.root, "claude-config");
      mkdirSync(target);
      const alias = join(sb.root, "claude-alias");
      symlinkSync(target, alias);
      const credential = join(sb.home, ".claude", ".credentials.json");
      mkdirSync(dirname(credential));
      writeFileSync(credential, "fixture");
      symlinkSync(credential, join(sb.home, ".claude.json"));
      const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
        cwd: sb.ws, env: cliEnv(sb, { HOME: sb.home, CLAUDE_CONFIG_DIR: alias }), encoding: "utf8", timeout: 10_000,
      });
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(0);
      const handoff = JSON.parse(text.split("\n").find((l) => l.startsWith("HANDOFF "))!.slice(8));
      expect(handoff.options.allow).toContain(realpathSync(target));
      expect(handoff.options.allow).not.toContain(alias);
      expect(handoff.options.allowFiles).toContain(realpathSync(credential));
      expect(handoff.opts.runtimeDirectories).toContain(realpathSync(target));
      expect(handoff.args).toContain(realpathSync(target));
      expect(handoff.args).toContain(realpathSync(credential));
      expect(handoff.args).not.toContain(alias);
      expect(handoff.args).not.toContain("--allow-cwd");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("buildNonoArgs carries approved canonical paths", () => {
    const home = makeHome();
    const env = envFor(home);
    const safe = join(home, "ws");
    mkdirSync(safe);
    const dirAlias = join(home, "workspace-alias");
    symlinkSync(safe, dirAlias);
    const credential = runtimeCredentialFiles("claude-code", env)[0]!;
    mkdirSync(dirname(credential), { recursive: true });
    writeFileSync(credential, "fixture");
    const fileAlias = join(home, ".claude.json");
    symlinkSync(credential, fileAlias);
    const approved = nono.approveRuntimeNonoOptions("claude-code", {
      cwd: dirAlias, workdir: dirAlias, read: [dirAlias], allow: [dirAlias],
      readFiles: [fileAlias], allowFiles: [fileAlias],
    }, env);
    expect(approved.refusal).toBeNull();
    unlinkSync(dirAlias);
    symlinkSync(join(home, ".tps", "auth"), dirAlias);
    unlinkSync(fileAlias);
    symlinkSync(providerAuthPath("openai", env), fileAlias);
    const args = nono.buildNonoArgs("tps-agent-run-claude-code", approved.options, ["echo"], env);
    expect(args).not.toContain(dirAlias);
    expect(args).not.toContain(fileAlias);
    expect(args).not.toContain("--allow-cwd");
    expect(args[args.indexOf("--workdir") + 1]).toBe(realpathSync(safe));
    expect(args[args.indexOf("--read") + 1]).toBe(realpathSync(safe));
    expect(args[args.indexOf("--allow") + 1]).toBe(realpathSync(safe));
    expect(args[args.indexOf("--read-file") + 1]).toBe(realpathSync(credential));
    expect(args[args.indexOf("--allow-file") + 1]).toBe(realpathSync(credential));
  });

  test.skipIf(process.getuid?.() === 0)("an unwritable overlapping runtime location gets the launch-gate refusal", () => {
    const sb = makeSandbox();
    const auth = join(sb.home, ".tps", "auth");
    mkdirSync(auth);
    chmodSync(auth, 0o500);
    const overlap = join(auth, "runtime");
    try {
      expect(() => mkdirSync(overlap)).toThrow();
      const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
        cwd: sb.ws, env: cliEnv(sb, { HOME: sb.home, CLAUDE_CONFIG_DIR: overlap }), encoding: "utf8", timeout: 10_000,
      });
      const text = `${r.stdout}${r.stderr}`;
      expect(r.status, text).toBe(78);
      expect(text).toContain("CLAUDE_CONFIG_DIR");
      expect(text).toContain("~/.tps/auth");
      expect(text).not.toContain("HANDOFF ");
      expect(existsSync(join(sb.home, ".claude"))).toBe(false);
      expect(existsSync(overlap)).toBe(false);
      chmodSync(auth, 0o000);
      const inaccessible = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
        cwd: sb.ws, env: cliEnv(sb, { HOME: sb.home, CLAUDE_CONFIG_DIR: overlap }), encoding: "utf8", timeout: 10_000,
      });
      expect(inaccessible.status, `${inaccessible.stdout}${inaccessible.stderr}`).toBe(78);
      expect(inaccessible.stderr).toContain("CLAUDE_CONFIG_DIR");
      expect(inaccessible.stderr).toContain("~/.tps/auth");
    } finally {
      chmodSync(auth, 0o700);
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
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

test("an overlapping location with a file parent gets the named-root refusal", () => {
  const sb = makeSandbox();
  try {
    const parent = join(sb.home, ".tps", "auth", "blocked");
    mkdirSync(dirname(parent));
    writeFileSync(parent, "fixture");
    const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
      cwd: sb.ws, env: cliEnv(sb, { HOME: sb.home, CLAUDE_CONFIG_DIR: join(parent, "runtime") }), encoding: "utf8", timeout: 10_000,
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(78);
    expect(r.stderr).toContain("CLAUDE_CONFIG_DIR");
    expect(r.stderr).toContain("~/.tps/auth");
    expect(existsSync(join(sb.home, ".claude"))).toBe(false);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
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

describe("cli#483 — launcher grant checks", () => {
  for (const fromHome of [false, true]) {
    test(`the positive fixture reaches attestation only from its workspace (fromHome=${fromHome})`, () => {
      const sb = makeSandbox();
      try {
        const custom = join(sb.root, "claude-custom");
        const r = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-dir-launch-driver.ts")], {
          cwd: fromHome ? sb.home : sb.ws,
          env: cliEnv(sb, { HOME: sb.home, CLAUDE_CONFIG_DIR: custom }),
          encoding: "utf8", timeout: 10_000,
        });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        expect(r.error).toBeUndefined();
        expect(r.status, text).toBe(fromHome ? 78 : 0);
        if (fromHome) {
          expect(text).toContain(`current-directory grant (${sb.home})`);
          expect(text).toContain(`~/.tps/auth (${join(sb.home, ".tps", "auth")})`);
          expect(text).toContain("launch from a workspace directory outside the credential roots");
          expect(text).not.toContain("HANDOFF ");
        } else {
          const line = text.split("\n").find((l) => l.startsWith("HANDOFF "));
          expect(line, text).toBeDefined();
          const handoff = JSON.parse(line!.slice(8));
          expect(handoff.profile).toBe("tps-agent-run-claude-code");
          expect(handoff.cwd).toBe(sb.ws);
          expect(handoff.options.workdir).toBe(sb.ws);
          expect(handoff.options.allow).toContain(custom);
          expect(handoff.options.read.length).toBeGreaterThan(0);
          expect(handoff.cmd.slice(-2)).toEqual(["--runtime", "claude-code"]);
          expect(handoff.cmd).toContain("--sandboxed");
          expect(handoff.cmd).toContain("--sandbox-required");
        }
      } finally {
        rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }

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
