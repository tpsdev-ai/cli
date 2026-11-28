/**
 * cli#948 slice 1a — the npm guard policy, refusal formatter, path module and
 * shims. Nothing here is wired into a CI job yet.
 *
 * Most shim tests run `sh` on the committed shims against a fake recorded npm
 * (a small node script that logs its argv) in a per-test root; the root-refusal
 * case sets GITHUB_ACTIONS=true, and the script-shell case uses no root and no
 * fake npm. This test file needs no real npm.
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
const REGISTRY_URL = "https://registry.npmjs.org";
const REPO_ROOT = join(import.meta.dir, "..");

// The reviewed callers, written independently of TABLE. Each cited line is read
// from the repository and must carry this command's npm text.
const EXPECTED = [
  {
    job: "test",
    argv: ["run", "build"],
    callers: [
      { at: "test.yml:194", text: "npm run build" },
      { at: "test.yml:203", text: "npm run build" },
    ],
  },
  {
    job: "test",
    argv: ["run", "typecheck:test"],
    callers: [{ at: "test.yml:204", text: "npm run typecheck:test" }],
  },
  {
    job: "node-plugin-load",
    argv: ["run", "build"],
    callers: [{ at: "test.yml:261", text: "npm run build" }],
  },
  {
    job: "github-review-gateway-boundary",
    argv: ["run", "build"],
    callers: [{ at: "test.yml:367", text: "npm run build" }],
  },
  {
    job: "github-review-gateway-boundary",
    argv: ["run", "typecheck:test"],
    callers: [{ at: "test.yml:368", text: "npm run typecheck:test" }],
  },
  {
    job: "promote-latest-fixtures",
    argv: ["view", SPEC_VALUE, "version", "--registry", REGISTRY_URL],
    callers: [
      {
        at: "promote-latest.sh:361",
        text: 'run_npm view "${names[i]}@${version}" version --registry "$NPM_REGISTRY"',
      },
    ],
  },
  {
    job: "promote-latest-fixtures",
    argv: ["view", SPEC_VALUE, "dist-tags.latest", "--registry", REGISTRY_URL],
    callers: [
      {
        at: "promote-latest.sh:399",
        text: 'run_npm view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY"',
      },
      {
        at: "promote-latest.sh:562",
        text: 'run_npm view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY"',
      },
      {
        at: "promote-latest.sh:711",
        text: 'run_npm view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY"',
      },
      {
        at: "promote-latest.sh:730",
        text: 'run_npm view "${names[i]}" dist-tags.latest --registry "$NPM_REGISTRY"',
      },
    ],
  },
  {
    job: "promote-latest-fixtures",
    argv: ["dist-tag", "add", SPEC_VALUE, "latest", "--registry", REGISTRY_URL],
    callers: [
      {
        at: "promote-latest.sh:547",
        text: 'run_npm dist-tag add "${names[i]}@${prev_latest[i]}" latest --registry "$NPM_REGISTRY"',
      },
      {
        at: "promote-latest.sh:699",
        text: 'run_npm dist-tag add "${names[i]}@${version}" latest --registry "$NPM_REGISTRY"',
      },
    ],
  },
  {
    job: "meta",
    argv: ["view", SPEC_VALUE, "version"],
    callers: [
      { at: "docker-image-tags.sh:59", text: 'npm view "${PKG}@${V}" version' },
    ],
  },
  {
    job: "meta",
    argv: ["view", SPEC_VALUE, "dist-tags.latest"],
    callers: [
      { at: "docker-image-tags.sh:86", text: 'npm view "$PKG" dist-tags.latest' },
    ],
  },
  {
    job: "publish-packages",
    argv: ["install", "-g", NPM_VERSION_VALUE, `--registry=${REGISTRY_URL}`],
    callers: [
      {
        at: "release.yml:256",
        text: "npm install -g npm@11.21.1 --registry=https://registry.npmjs.org",
      },
    ],
  },
  {
    job: "publish-packages",
    argv: ["stage", "publish", "--tag", "staged", "--access", "public"],
    callers: [
      {
        at: "release.yml:414",
        text: "npm stage publish --tag staged --access public",
      },
    ],
  },
  {
    job: "publish-packages",
    argv: ["view", SPEC_VALUE, "version"],
    callers: [{ at: "release.yml:421", text: 'npm view "$nm@$VERSION" version' }],
  },
];

const CALLER_FILES = {
  "test.yml": join(REPO_ROOT, ".github/workflows/test.yml"),
  "release.yml": join(REPO_ROOT, ".github/workflows/release.yml"),
  "promote-latest.sh": join(REPO_ROOT, "scripts/promote-latest.sh"),
  "docker-image-tags.sh": join(REPO_ROOT, ".github/scripts/docker-image-tags.sh"),
};

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
  test("every reviewed caller is allowed in its job", () => {
    for (const entry of EXPECTED) {
      expect(decide("npm", entry.argv, entry.job).allow).toBe(true);
      expect(decide("npm", entry.argv, undefined).allow).toBe(false);
      expect(decide("npm", entry.argv, "no-such-job").allow).toBe(false);
    }
  });

  test("the table matches the reviewed callers exactly", () => {
    const table = TABLE.map((entry) => ({
      job: entry.job,
      argv: materialize(entry.argv),
      callers: entry.callers.map((at) => at),
    }));
    const expected = EXPECTED.map((entry) => ({
      job: entry.job,
      argv: entry.argv,
      callers: entry.callers.map((caller) => caller.at),
    }));
    expect(table.length).toBe(expected.length);
    expect(table).toEqual(expected);
  });

  test("every cited caller line carries the command's npm text", () => {
    for (const entry of EXPECTED) {
      for (const caller of entry.callers) {
        const [file, lineNumber] = caller.at.split(":");
        const path = CALLER_FILES[file];
        if (!path) throw new Error(`no file for ${caller.at}`);
        const lines = readFileSync(path, "utf8").split("\n");
        expect(lines[Number(lineNumber) - 1]).toContain(caller.text);
      }
    }
  });

  test("every reviewed caller decides its exact argv in the jobs that list it", () => {
    const shapes = new Map();
    for (const entry of EXPECTED) {
      const key = JSON.stringify(entry.argv);
      const shape = shapes.get(key) ?? { argv: entry.argv, jobs: [] };
      shape.jobs.push(entry.job);
      shapes.set(key, shape);
    }
    for (const shape of shapes.values()) {
      const shell =
        shape.argv[0] === "run" ||
        (shape.argv[0] === "stage" && shape.argv[1] === "publish");
      const expected = shell ? [...shape.argv, "--script-shell", scriptShellPath()] : [...shape.argv];
      for (const job of shape.jobs) {
        const decision = decide("npm", shape.argv, job);
        expect(decision.allow).toBe(true);
        if (decision.allow) expect(decision.argv).toEqual(expected);
      }
      for (const job of [...JOBS, undefined, "no-such-job"]) {
        expect(decide("npm", shape.argv, job).allow).toBe(
          job !== undefined && shape.jobs.includes(job),
        );
      }
    }
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

  test("the npm-version slot accepts only a bounded npm@x.y.z", () => {
    for (const value of [
      "other@11.21.1",
      "npm@latest",
      "npm@01.2.3",
      "npm@1234567890.0.0",
      "--global-style",
    ]) {
      expect(
        decide("npm", ["install", "-g", value, `--registry=${REGISTRY_URL}`], "publish-packages")
          .allow,
      ).toBe(false);
    }
  });

  test("the spec slot accepts only a package name, not a flag, whitespace, a semicolon, or a URL", () => {
    for (const value of ["--json", "pkg name", "pkg;id", "https://evil.example/x.tgz"]) {
      expect(decide("npm", ["view", value, "version"], "meta").allow).toBe(false);
      expect(
        decide(
          "npm",
          ["view", value, "dist-tags.latest", "--registry", REGISTRY_URL],
          "promote-latest-fixtures",
        ).allow,
      ).toBe(false);
    }
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

    const typecheck = decide("npm", ["run", "typecheck:test"], "test");
    expect(typecheck.allow).toBe(true);
    if (typecheck.allow) {
      expect(typecheck.argv.slice(2)).toEqual(["--script-shell", scriptShellPath()]);
    }

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

  test("under Actions an override naming the production root is refused", () => {
    const saved = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    try {
      const refused = selectRoot(PRODUCTION_ROOT);
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
if (process.env.FAKE_NPM_OUT) { process.stdout.write(process.env.FAKE_NPM_OUT); process.stderr.write(process.env.FAKE_NPM_OUT + "-err"); }
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

  test("the recorded npm's stdout and stderr reach the shim's own streams", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["view", SPEC_VALUE, "version"], {
      GITHUB_JOB: "meta",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_OUT: "1.2.3",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("1.2.3");
    expect(result.stderr).toContain("1.2.3-err");
    expect(loggedCalls(logPath)).toEqual([["view", SPEC_VALUE, "version"]]);
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

  test("the npx shim refuses before spawning the recorded npm", () => {
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

  test("a redacted secret leaves no fragment on stdout or stderr", () => {
    const separators = ["\n", " ", "\t", "\u009b"];
    const forms = [
      (secret) => [`--otp=${secret}`],
      (secret) => [`--password=${secret}`],
      (secret) => ["--otp", secret],
      (secret) => ["--password", secret],
      (secret) => [`--//registry.npmjs.org/:_authToken=${secret}`],
    ];
    for (const [formIndex, form] of forms.entries()) {
      for (const [sepIndex, separator] of separators.entries()) {
        const head = `HEAD-${formIndex}-${sepIndex}`;
        const tail = `TAIL-${formIndex}-${sepIndex}`;
        const secret = `${head}${separator}${tail}`;
        const { root, logPath } = makeGuardRoot();
        const result = runShim("npm", ["ci", ...form(secret)], {
          GITHUB_JOB: "test",
          [ROOT_ENV]: root,
          FAKE_NPM_LOG: logPath,
        });
        expect(result.status).not.toBe(0);
        for (const output of [result.stdout, result.stderr]) {
          expect(output).not.toContain(head);
          expect(output).not.toContain(tail);
          expect(output).not.toContain(secret);
        }
        expect(result.stderr).toContain("[REDACTED]");
        expect(existsSync(logPath)).toBe(false);
      }
    }
  });

  test("a URL userinfo with whitespace or a control byte leaves no fragment", () => {
    const separators = [" ", "\t", "\n", "\u009b"];
    for (const [index, separator] of separators.entries()) {
      const user = `user${index}${separator}name`;
      const password = `pass${index}${separator}word`;
      const url = `https://${user}:${password}@registry.example/x`;
      const { root, logPath } = makeGuardRoot();
      const result = runShim("npm", ["ci", url], {
        GITHUB_JOB: "test",
        [ROOT_ENV]: root,
        FAKE_NPM_LOG: logPath,
      });
      expect(result.status).not.toBe(0);
      for (const output of [result.stdout, result.stderr]) {
        for (const fragment of [user, password, `user${index}`, "name", `pass${index}`, "word"]) {
          expect(output).not.toContain(fragment);
        }
      }
      expect(result.stderr).toContain("https://registry.example/x");
      expect(existsSync(logPath)).toBe(false);
    }
  });

  test("a password containing one @ leaves no fragment on stdout or stderr", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["ci", "https://alice:TOP@SECRET@registry.example/x"], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    for (const output of [result.stdout, result.stderr]) {
      for (const fragment of ["alice", "TOP", "SECRET"]) {
        expect(output).not.toContain(fragment);
      }
    }
    expect(result.stderr).toContain("https://registry.example/x");
  });

  test("a password containing two @ and a control byte leaves no fragment", () => {
    const password = "SEG-1@SEG-2@\u009bSEG-3";
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["ci", `https://carol:${password}@registry.example/y`], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    for (const output of [result.stdout, result.stderr]) {
      for (const fragment of ["carol", "SEG-1", "SEG-2", "SEG-3"]) {
        expect(output).not.toContain(fragment);
      }
    }
    expect(result.stderr).toContain("https://registry.example/y");
  });

  test("_authToken beside URL userinfo leaves no fragment on either stream", () => {
    for (const url of [
      "https://alice:TOP@SECRET@registry.example/?_authToken=tok",
      "https://alice:_authToken=SECRET@registry.example/x",
    ]) {
      const { root, logPath } = makeGuardRoot();
      const result = runShim("npm", ["ci", url], {
        GITHUB_JOB: "test",
        [ROOT_ENV]: root,
        FAKE_NPM_LOG: logPath,
      });
      expect(result.status).not.toBe(0);
      for (const output of [result.stdout, result.stderr]) {
        for (const fragment of ["alice", "TOP", "SECRET", "tok"]) {
          expect(output).not.toContain(fragment);
        }
      }
      expect(existsSync(logPath)).toBe(false);
    }
  });

  test("two URLs in one argument both lose their userinfo", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["ci", "https://a.example https://alice:SECRET@b.example/x"], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    for (const output of [result.stdout, result.stderr]) {
      for (const fragment of ["alice", "SECRET"]) {
        expect(output).not.toContain(fragment);
      }
    }
    expect(result.stderr).toContain("https://a.example https://b.example/x");
    expect(existsSync(logPath)).toBe(false);
  });

  test("an @ in the path after a clean authority survives", () => {
    const { root, logPath } = makeGuardRoot();
    const result = runShim("npm", ["ci", "https://registry.example/@scope/pkg"], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: root,
      FAKE_NPM_LOG: logPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("https://registry.example/@scope/pkg");
  });

  test("a secret-bearing argv is not echoed by the shim", () => {
    const secret = "guardleak-7f3a9c";
    const refused = makeGuardRoot();
    const refusedResult = runShim("npm", ["ci", `--otp=${secret}`], {
      GITHUB_JOB: "test",
      [ROOT_ENV]: refused.root,
      FAKE_NPM_LOG: refused.logPath,
    });
    const allowed = makeGuardRoot();
    const allowedResult = runShim("npm", ["view", secret, "version"], {
      GITHUB_JOB: "meta",
      [ROOT_ENV]: allowed.root,
      FAKE_NPM_LOG: allowed.logPath,
    });
    expect(allowedResult.status).toBe(0);
    expect(loggedCalls(allowed.logPath)).toEqual([["view", secret, "version"]]);
    for (const result of [refusedResult, allowedResult]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });
});
