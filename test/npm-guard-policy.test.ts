/**
 * cli#948 slice 1a — the npm guard policy, refusal formatter, path module and
 * shims. Nothing here is wired into a CI job yet.
 *
 * The shim tests run `sh` on the committed shims against a fake recorded npm (a
 * small node script that logs its argv), in a per-test root with
 * GITHUB_ACTIONS unset, so no lane needs a real npm.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUARD_DIR,
  PRODUCTION_ROOT,
  ROOT_ENV,
  recordedNpmPath,
  scriptShellPath,
  selectRoot,
} from "../scripts/npm-guard/paths.mjs";
import { TABLE, decide, needsScriptShell } from "../scripts/npm-guard/policy.mjs";
import { formatRefusal, redactArgs, sanitizeText } from "../scripts/npm-guard/refusal.mjs";

const JOBS = [...new Set(TABLE.map((entry) => entry.job))];
const SPEC_VALUE = "@scope-a/package-a@1.2.3";
const NPM_VERSION_VALUE = "npm@11.21.1";

const roots = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "npm-guard-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A template position's concrete value.
function materialize(pattern) {
  return pattern.map((token) => {
    if (typeof token === "string") return token;
    if (token.slot === "spec") return SPEC_VALUE;
    if (token.slot === "npm-version") return NPM_VERSION_VALUE;
    throw new Error(`unknown slot: ${token.slot}`);
  });
}

describe("policy table", () => {
  for (const entry of TABLE) {
    const args = materialize(entry.argv);
    test(`${entry.job}: npm ${args.join(" ")} (${entry.callers.join(", ")})`, () => {
      const decision = decide("npm", args, entry.job);
      expect(decision.allow).toBe(true);
      if (!decision.allow) return;
      expect(decision.argv.slice(0, args.length)).toEqual(args);

      const otherJob = JOBS.find(
        (job) => job !== entry.job && !decide("npm", args, job).allow,
      );
      expect(otherJob).toBeDefined();
      expect(decide("npm", args, otherJob).allow).toBe(false);
      expect(decide("npm", args, undefined).allow).toBe(false);
      expect(decide("npm", args, "no-such-job").allow).toBe(false);
    });
  }

  test("the table has 13 shapes", () => {
    expect(TABLE.length).toBe(13);
  });

  test("the meta job allows the dist-tags read and refuses it in another job", () => {
    expect(decide("npm", ["view", SPEC_VALUE, "version"], "meta").allow).toBe(true);
    expect(decide("npm", ["view", SPEC_VALUE, "dist-tags.latest"], "meta").allow).toBe(true);
    expect(decide("npm", ["view", SPEC_VALUE, "dist-tags.latest"], "test").allow).toBe(false);
  });

  test("a job not in the table allows only the probe", () => {
    expect(decide("npm", ["ci"], "no-such-job").allow).toBe(false);
    expect(decide("npm", ["--version"], "no-such-job").allow).toBe(true);
    expect(decide("npm", ["-v"], "no-such-job").allow).toBe(true);
  });

  test("the version verb is refused where a probe is allowed", () => {
    expect(decide("npm", ["version"], "test").allow).toBe(false);
    expect(decide("npm", ["version", "patch"], "test").allow).toBe(false);
  });
});

describe("refused verbs and shapes", () => {
  const REFUSED = [
    ["i"],
    ["in"],
    ["ins"],
    ["instal"],
    ["up"],
    ["update"],
    ["install-test"],
    ["it"],
    ["install-ci-test"],
    ["cit"],
    ["clean-install"],
    ["ic"],
    ["init", "x"],
    ["create", "x"],
    ["audit", "fix"],
    ["explore"],
    ["rebuild"],
    ["dedupe"],
    ["link"],
    ["uninstall"],
    ["remove"],
    ["set-script"],
    ["pkg", "set"],
    ["cache", "add"],
    ["ci"],
    ["install"],
    ["exec"],
    ["x"],
  ];

  for (const args of REFUSED) {
    test(`npm ${args.join(" ")} is refused`, () => {
      expect(decide("npm", args, "test").allow).toBe(false);
    });
  }

  test("install is refused in publish-packages without the exact global shape", () => {
    expect(decide("npm", ["install"], "publish-packages").allow).toBe(false);
    expect(decide("npm", ["install", "-g", "npm@11.21.1"], "publish-packages").allow).toBe(false);
    expect(
      decide("npm", ["install", "-g", "npm@11.21.1", "--registry=https://elsewhere.example"], "publish-packages")
        .allow,
    ).toBe(false);
  });

  test("the global install shape admits no shell metacharacters", () => {
    const decision = decide(
      "npm",
      ["install", "-g", "npm@11.21.1;id", "--registry=https://registry.npmjs.org"],
      "publish-packages",
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("metacharacter");
  });

  test("an unlisted flag on an allowed shape is refused", () => {
    expect(decide("npm", ["view", SPEC_VALUE, "version", "--json"], "meta").allow).toBe(false);
    expect(decide("npm", ["run", "build", "--silent"], "test").allow).toBe(false);
  });

  test("a flag before the verb is refused", () => {
    expect(decide("npm", ["--silent", "run", "build"], "test").allow).toBe(false);
    expect(decide("npm", ["-g", "install", "npm@11.21.1"], "publish-packages").allow).toBe(false);
  });

  test("npx has an empty allowlist in every job", () => {
    const forms = [
      [],
      ["--version"],
      ["-v"],
      ["ci"],
      ["install"],
      ["i"],
      ["--no-install", "package-a"],
      ["exec", "package-a"],
      ["x", "package-a"],
    ];
    for (const args of forms) {
      for (const job of [...JOBS, undefined]) {
        expect(decide("npx", args, job).allow).toBe(false);
      }
    }
  });
});

describe("script shell", () => {
  test("the run family is identified", () => {
    for (const args of [
      ["run", "build"],
      ["run-script", "build"],
      ["test"],
      ["start"],
      ["stop"],
      ["restart"],
      ["stage", "publish"],
      ["pack"],
    ]) {
      expect(needsScriptShell(args)).toBe(true);
    }
    expect(needsScriptShell(["view"])).toBe(false);
    expect(needsScriptShell(["dist-tag", "add"])).toBe(false);
    expect(needsScriptShell(["stage", "approve"])).toBe(false);
  });

  test("an allowed run shape gets --script-shell appended", () => {
    const run = decide("npm", ["run", "build"], "test");
    expect(run.allow).toBe(true);
    if (run.allow) expect(run.argv.slice(2)).toEqual(["--script-shell", scriptShellPath()]);

    const publish = decide(
      "npm",
      ["stage", "publish", "--tag", "staged", "--access", "public"],
      "publish-packages",
    );
    expect(publish.allow).toBe(true);
    if (publish.allow) {
      expect(publish.argv.slice(6)).toEqual(["--script-shell", scriptShellPath()]);
    }
  });

  test("view gets no --script-shell", () => {
    const decision = decide("npm", ["view", SPEC_VALUE, "version"], "meta");
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.argv).not.toContain("--script-shell");
  });
});

describe("refusal text", () => {
  function refusal(argv) {
    return formatRefusal({
      tool: "npm",
      argv,
      job: "test",
      action: "refs/heads/main",
      reason: "the command shape is not allowed in this job",
    });
  }

  test("names the job, step, command, and the supported path", () => {
    const text = refusal(["ci", "--ignore-scripts"]);
    expect(text).toContain("GITHUB_JOB: test");
    expect(text).toContain("GITHUB_ACTION: refs/heads/main");
    expect(text).toContain("command: npm ci --ignore-scripts");
    expect(text).toContain("installation not started");
    expect(text).toContain("scripts/npm-ci-tracked-lock.sh");
  });

  test("blank --otp and --password values in both spellings", () => {
    const secrets = ["otp-a", "otp-b", "pw-a", "pw-b"];
    const text = refusal([
      "--otp=otp-a",
      "--otp",
      "otp-b",
      "--password=pw-a",
      "--password",
      "pw-b",
    ]);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain("--otp=[REDACTED]");
    expect(text).toContain("--password=[REDACTED]");
  });

  test("blank any _authToken value", () => {
    const text = refusal(["ci", "--//registry.npmjs.org/:_authToken=token-a"]);
    expect(text).not.toContain("token-a");
    expect(text).toContain("_authToken=[REDACTED]");
  });

  test("collapse scheme://userinfo@host to scheme://host", () => {
    const text = refusal(["view", "https://user-a:pw-a@registry.example/x"]);
    expect(text).not.toContain("user-a");
    expect(text).not.toContain("pw-a");
    expect(text).toContain("https://registry.example/x");
  });

  test("strip a C0 escape, a C1 byte, and neutralize a leading ::", () => {
    expect(sanitizeText("\u001b[31mred")).toBe("[31mred");
    expect(sanitizeText("a\u009bb")).toBe("ab");
    expect(sanitizeText("::error::boom")).toBe(": :error::boom");

    const text = refusal(["ci", "\u001b[31mred", "a\u009bb", "::error::boom"]);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u009b");
    expect(text).toContain(": :error::boom");
    for (const line of text.split("\n")) expect(line.startsWith("::")).toBe(false);
  });

  test("redactArgs keeps the count and order of arguments", () => {
    expect(redactArgs(["ci", "--otp", "x", "--password=y"])).toEqual([
      "ci",
      "--otp",
      "[REDACTED]",
      "--password=[REDACTED]",
    ]);
  });
});

describe("paths", () => {
  test("the production root is fixed", () => {
    expect(PRODUCTION_ROOT).toBe("/tmp/tps-npm-guard");
    expect(recordedNpmPath(PRODUCTION_ROOT)).toBe("/tmp/tps-npm-guard/real-npm");
  });

  test("without a candidate the production root is selected", () => {
    expect(selectRoot(undefined)).toEqual({ ok: true, root: PRODUCTION_ROOT });
  });

  test("a per-test root is accepted only outside Actions", () => {
    const saved = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;
    try {
      const root = makeRoot();
      expect(selectRoot(root)).toEqual({ ok: true, root });
      process.env.GITHUB_ACTIONS = "true";
      const refused = selectRoot(root);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("GITHUB_ACTIONS");
    } finally {
      if (saved === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = saved;
    }
  });
});

describe("shims", () => {
  const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_NPM_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(Number(process.env.FAKE_NPM_EXIT || "0"));
`;

  function baseEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_JOB;
    delete env.GITHUB_ACTION;
    delete env[ROOT_ENV];
    return env;
  }

  function makeGuardRoot({ recorded = true } = {}) {
    const root = makeRoot();
    const npmPath = join(root, "fake-npm");
    writeFileSync(npmPath, FAKE_NPM, { mode: 0o755 });
    chmodSync(npmPath, 0o755);
    if (recorded) writeFileSync(recordedNpmPath(root), `${npmPath}\n`);
    return { root, npmPath, logPath: join(root, "calls.log") };
  }

  function runShim(shim, args, extraEnv) {
    return spawnSync("/bin/sh", [join(GUARD_DIR, shim), ...args], {
      env: { ...baseEnv(), ...extraEnv },
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  function loggedCalls(logPath) {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  test("an allowed shape reaches the fake npm with the decided argv", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["run", "build"], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).toBe(0);
    expect(loggedCalls(logPath)).toEqual([
      ["run", "build", "--script-shell", scriptShellPath()],
    ]);
  });

  test("the recorded npm's exit code is passed through", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["--version"], {
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_EXIT: "7",
    });
    expect(result.status).toBe(7);
    expect(loggedCalls(logPath)).toEqual([["--version"]]);
  });

  test("a refused shape exits nonzero and the fake npm never runs", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["ci", "--ignore-scripts"], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installation not started");
    expect(result.stderr).toContain("GITHUB_JOB: test");
    expect(result.stderr).toContain("scripts/npm-ci-tracked-lock.sh");
    expect(existsSync(logPath)).toBe(false);
  });

  test("the npx shim refuses before spawning", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npx", ["--version"], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npx has no allowed command shapes");
    expect(existsSync(logPath)).toBe(false);
  });

  test("a missing recorded file is a refusal", () => {
    const { root, logPath } = makeGuardRoot({ recorded: false });
    const result = runShim("npm", ["--version"], {
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recorded npm file is missing");
    expect(existsSync(logPath)).toBe(false);
  });

  test("a non-executable recorded npm is a refusal", () => {
    const root = makeRoot();
    const plain = join(root, "not-npm");
    writeFileSync(plain, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    chmodSync(plain, 0o644);
    writeFileSync(recordedNpmPath(root), `${plain}\n`);
    const result = runShim("npm", ["--version"], {
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: join(root, "calls.log"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recorded npm is not executable");
  });

  test("under GITHUB_ACTIONS a per-test root is refused", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["run", "build"], {
      GITHUB_ACTIONS: "true",
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GITHUB_ACTIONS");
    expect(existsSync(logPath)).toBe(false);
  });

  test("script-shell puts the guard directory first on PATH", () => {
    const result = spawnSync("/bin/sh", [join(GUARD_DIR, "script-shell"), "-c", 'printf "%s" "$PATH"'], {
      env: baseEnv(),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.split(":")[0]).toBe(GUARD_DIR);
  });
});
