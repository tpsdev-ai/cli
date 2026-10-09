import { expect, test } from "bun:test";
import meow from "meow";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("guard option table matches the parser declarations", async () => {
  const { cliFlagDefinitions } = await import("../src/utils/cli-flags.js");
  const { guardOptionTypes, parseGuardMode } = await import("../src/utils/secrets-guard-args.js");
  const parserSource = readFileSync(resolve(import.meta.dir, "../bin/tps.ts"), "utf-8");
  expect(parserSource).toContain("flags: cliFlagDefinitions,");
  expect([...guardOptionTypes]).toEqual(Object.entries(cliFlagDefinitions).flatMap(([name, flag]) =>
    [...new Set([name, name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)])]
      .map((spelling) => [`--${spelling}`, flag.type])
  ));
  for (const [flag, type] of guardOptionTypes) {
    const value = type === "number" ? "7" : "fixture";
    const parsed = meow("", {
      importMeta: import.meta, flags: cliFlagDefinitions, autoHelp: false, autoVersion: false,
      argv: ["secrets-guard", flag, ...(type === "boolean" ? [] : [value]), "child"],
    });
    expect(parsed.input).toEqual(["secrets-guard", "child"]);
    if (type !== "boolean") {
      expect(parseGuardMode(["secrets-guard", flag, value, "--check", "child"]).check).toBe(true);
    }
  }
  expect(parseGuardMode(["secrets-guard", "--config", "--check", "child"]).check).toBe(true);
  expect(parseGuardMode(["secrets-guard", "--limit", "-7", "--check", "child"]).check).toBe(true);
});

const cases = [
  { flags: ["--config", "config.json", "--check"], mode: "check" },
  { flags: ["--config=config.json", "--workspace", "workspace", "--check"], mode: "check" },
  { flags: ["--limit", "7", "--check"], mode: "check" },
  { flags: ["--baseModel", "model", "--check"], mode: "check" },
  { flags: ["--json", "false", "--config", "config.json", "--check"], mode: "check" },
  { flags: ["--no-guard", "--config", "config.json", "--no-guard=false"], mode: "refuse" },
  { flags: ["--check", "--config", "config.json", "--no-guard"], mode: "refuse" },
  { flags: ["--no-guard", "--limit", "7", "--check"], mode: "refuse" },
  { flags: ["--config", "config.json", "--noGuard"], mode: "refuse" },
  { flags: ["--check", "false"], mode: "refuse" },
  { flags: ["--no-guard", "true"], mode: "refuse" },
];

for (const { flags, mode } of cases) {
  test(`${flags.join(" ")}: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), "guard-prefix-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const sentinel = join(root, "child-ran");
      const argvFile = join(root, "argv.json");
      const child = join(root, "child.mjs");
      writeFileSync(child,
        'import { writeFileSync } from "node:fs";\n' +
        'writeFileSync(process.env.CHILD_SENTINEL, "ran");\n' +
        'writeFileSync(process.env.CHILD_ARGV_FILE, JSON.stringify(process.argv.slice(2)));\n' +
        'console.log("ghp_abcdefghijklmnopqrstuvwxyz1234567890");\n'
      );
      const run = (prefix: string[], tail: string[] = []) => spawnSync(process.execPath,
        [resolve(import.meta.dir, "../dist/bin/tps.js"), "secrets-guard", ...prefix, process.execPath, child, ...tail],
        {
          encoding: "utf-8", input: "", timeout: 15_000, killSignal: "SIGKILL", cwd: root,
          env: { ...process.env, HOME: home, TPS_HOME: home, CHILD_SENTINEL: sentinel, CHILD_ARGV_FILE: argvFile },
        }
      );
      const result = run(flags);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === "check" ? 0 : 1);
      if (mode === "check") expect(output).toMatch(/^matches: \d+/);
      else expect(output).toContain("InvalidSecretsGuardMode:");
      expect(existsSync(sentinel)).toBe(false);

      const control = run(["--config", "config.json", "--"], flags);
      const controlOutput = `${control.stdout ?? ""}${control.stderr ?? ""}`;
      expect(control.error).toBeUndefined();
      expect(control.status).toBe(0);
      expect(readFileSync(sentinel, "utf-8")).toBe("ran");
      expect(JSON.parse(readFileSync(argvFile, "utf-8"))).toEqual(flags);
      expect(controlOutput).toContain("[REDACTED-shape]");
      expect(controlOutput).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
}

test("a guard flag before the secrets-guard subcommand is refused (cli#563)", async () => {
  const { parseCliArgs } = await import("../src/utils/cli-args.js");
  for (const args of [
    ["--check", "secrets-guard", "child"],
    ["--no-guard", "secrets-guard", "child"],
    ["--check=false", "secrets-guard", "child"],
    ["--check", "--", "secrets-guard", "child"],
    ["--no-guard", "--config", "--", "secrets-guard", "child"],
  ]) {
    expect(() => parseCliArgs(args)).toThrow(/^InvalidSecretsGuardMode: .* before the secrets-guard subcommand/);
  }
  // A guard flag before a subcommand that is not secrets-guard sets no guard mode
  // and is not refused by this scan.
  expect(parseCliArgs(["--check", "status"]).guardMode).toEqual({ check: false, noGuard: false });
});

test("a guard flag after the secrets-guard subcommand is unchanged (cli#563)", async () => {
  const { parseCliArgs } = await import("../src/utils/cli-args.js");
  expect(parseCliArgs(["secrets-guard", "--check"]).guardMode).toEqual({ check: true, noGuard: false });
  expect(parseCliArgs(["secrets-guard", "--no-guard", "child"]).guardMode).toEqual({ check: false, noGuard: true });
});

for (const option of ["-x", "-abc"]) {
  test(`${option} consumes a -- value through meow`, async () => {
    const { parseCliArgs } = await import("../src/utils/cli-args.js");
    const { cliFlagDefinitions } = await import("../src/utils/cli-flags.js");
    const argv = [option, "--", "secrets-guard", "--check", "child"];
    const scanned = parseCliArgs(argv);
    const parsed = meow("", {
      importMeta: import.meta, flags: cliFlagDefinitions, autoHelp: false, autoVersion: false,
      argv: scanned.argv,
    });
    expect(parsed.input).toEqual(["secrets-guard", "child"]);
    expect(parsed.flags[option.slice(-1)]).toBe("--");
    expect(scanned.guardMode).toEqual({ check: true, noGuard: false });
    expect(() => parseCliArgs([option, "--", "--check", "secrets-guard", "child"]))
      .toThrow("InvalidSecretsGuardMode: --check before the secrets-guard subcommand; put the guard flag after the subcommand");
  });
}

test("a -- before secrets-guard leaves following tokens positional", async () => {
  const { parseCliArgs } = await import("../src/utils/cli-args.js");
  const args = ["--", "secrets-guard", "--check", "child"];
  const scanned = parseCliArgs(args);
  expect(scanned.argv).toEqual(args);
  expect(scanned.guardMode).toEqual({ check: false, noGuard: false });
});

for (const option of ["-x--", "-abc--", "-x=--", "-x1"]) {
  test(`${option} leaves secrets-guard positional through meow`, async () => {
    const { parseCliArgs } = await import("../src/utils/cli-args.js");
    const { cliFlagDefinitions } = await import("../src/utils/cli-flags.js");
    const argv = ["--check", option, "secrets-guard", "child"];
    const parsed = meow("", {
      importMeta: import.meta, flags: cliFlagDefinitions, autoHelp: false, autoVersion: false, argv,
    });
    expect(parsed.input).toEqual(["secrets-guard", "child"]);
    expect(() => parseCliArgs(argv)).toThrow("InvalidSecretsGuardMode: --check before the secrets-guard subcommand");
  });
}
