/**
 * Black-box probes use a throwaway HOME and fake nono.
 * Top-level discovery uses a regex over the USAGE map.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const BIN_SOURCE = resolve(import.meta.dir, "../bin/tps.ts");
const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

/** Discover top-level commands with a regex over the USAGE map. */
function topLevelCommands(): string[] {
	const source = readFileSync(BIN_SOURCE, "utf-8");
	const usage = source.slice(source.indexOf("const USAGE:"), source.indexOf("/** `--` ends TPS"));
	const names = [...usage.matchAll(/^ {2}"?([a-z0-9-]+)"?:/gm)].map((m) => m[1]!);
	return [...new Set(names)].sort();
}

/** A fresh empty HOME plus a fake `nono` on PATH that logs every invocation. */
function fixture(): { home: string; nonoLog: string; path: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "tps-help-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	const nonoLog = join(root, "nono.log");
	const nono = join(bin, "nono");
	writeFileSync(nono, `#!/bin/sh\necho "run $@" >> ${JSON.stringify(nonoLog)}\nexit 0\n`);
	chmodSync(nono, 0o755);
	return {
		home,
		nonoLog,
		path: `${bin}:${process.env.PATH ?? ""}`,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Every file or directory path under `dir`, relative names sorted. */
function tree(dir: string): string[] {
	const out: string[] = [];
	const walk = (base: string, prefix: string) => {
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			out.push(rel);
			if (entry.isDirectory()) walk(join(base, entry.name), rel);
		}
	};
	walk(dir, "");
	return out.sort();
}

interface Result {
	status: number | null;
	signal: NodeJS.Signals | null;
	out: string;
	files: string[];
	nonoRuns: string;
}

/** Run argv against a fresh HOME. */
function runHelp(argv: string[], controlled = false, forbidIO = false): Result & { cleanup: () => void } {
	const f = fixture();
	const before = tree(f.home);
	const register = join(f.home, "register.mjs");
	const loader = join(f.home, "loader.mjs");
	const handler = join(f.home, "handler.mjs");
	if (controlled) {
		writeFileSync(register, 'import { register } from "node:module"; register(new URL("./loader.mjs", import.meta.url));');
		writeFileSync(loader, `export async function resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/dist/bin/tps.js") && ["../src/commands/agent.js", "../src/commands/office.js", "../src/commands/mail.js", "../src/commands/init.js"].includes(specifier)) {
    return { url: new URL("./handler.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}`);
		writeFileSync(handler, `import { spawnSync } from "node:child_process";
export async function runAgent(args) { console.log(JSON.stringify({ message: args.message })); }
export async function runInit(args) { console.log(JSON.stringify({ model: args.model })); }
function child(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
export async function runOffice(args) { child(args.command); }
export async function runMail(args) { child(args.hook); }
`);
	}
	const probe = join(f.home, "..", "probe.mjs");
	if (forbidIO) writeFileSync(probe, `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const refuse = () => { throw new Error("help attempted stdin or child IO"); };
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = refuse;
const readSync = fs.readSync;
fs.readSync = (fd, ...args) => fd === 0 ? refuse() : readSync(fd, ...args);
process.stdin.setEncoding = refuse;
process.stdin[Symbol.asyncIterator] = refuse;
syncBuiltinESMExports();
`);
	const r = spawnSync("node", [...(forbidIO ? ["--import", probe] : []), ...(controlled ? ["--import", register] : []), TPS_BIN, ...argv], {
		encoding: "utf-8",
		timeout: 15_000,
		killSignal: "SIGKILL",
		cwd: f.home,
		env: {
			...process.env,
			HOME: f.home,
			TPS_HOME: f.home,
			PATH: f.path,
			TPS_NONO_STRICT: "",
			// A help probe must not itself start a detached daemon if the intercept
			// ever regresses: keep branch start in the foreground so a hang is caught.
			NODE_ENV: "test",
			TPS_BRANCH_NO_DAEMON: "1",
		},
	});
	const after = tree(f.home);
	return {
		status: r.status,
		signal: r.signal,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		files: after.filter((p) => !before.includes(p)),
		nonoRuns: existsSync(f.nonoLog) ? readFileSync(f.nonoLog, "utf-8") : "",
		cleanup: f.cleanup,
	};
}

function expectHelpIsInert(r: Result): void {
	// exit 0, and not killed by the test's own timeout (a hang reads as a kill).
	expect(r.signal).toBeNull();
	expect(r.status).toBe(0);
	expect(r.out).toContain("Usage");
	// no file created under the throwaway HOME, and no nono child launched.
	expect(r.files).toEqual([]);
	expect(r.nonoRuns).toBe("");
}

beforeAll(() => {
	if (!existsSync(TPS_BIN)) throw new Error(`tps binary not found at ${TPS_BIN}. Run 'bun run build' first.`);
});

describe("TPS help requests and argument passthrough (cli#342)", () => {
	test("top-level commands print usage and exit 0 with no side effects", () => {
		const commands = topLevelCommands();
		// Guard against an empty regex result.
		expect(commands.length).toBeGreaterThan(20);
		expect(commands).toContain("branch");
		expect(commands).toContain("identity");
		expect(commands).toContain("secrets-guard");
		const failures: string[] = [];
		for (const command of commands) {
			// `ui` is an alias of `tui`, so its usage names `tps tui`.
			const needle = command === "ui" ? "tps tui" : `tps ${command}`;
			const r = runHelp([command, "--help"]);
			try {
				expect(r.signal, command).toBeNull();
				expect(r.status, command).toBe(0);
				expect(r.out, command).toContain(needle);
				expect(r.files, `${command} created ${r.files.join(", ")}`).toEqual([]);
				expect(r.nonoRuns, command).toBe("");
			} catch (err) {
				failures.push(`${command}: ${(err as Error).message.split("\n")[0]}`);
			} finally {
				r.cleanup();
			}
		}
		expect(failures).toEqual([]);
	}, 180_000);

	test("the side-effecting subcommands print help instead of running, for --help and -h", () => {
		const cases: string[][] = [
			["branch", "init", "--help"],
			["branch", "start", "--help"],
			["office", "join", "--help"],
			["office", "connect", "--help"],
			["identity", "init", "--help"],
			["identity", "init", "-h"],
		];
		const failures: string[] = [];
		for (const argv of cases) {
			const r = runHelp(argv);
			try {
				expectHelpIsInert(r);
			} catch (err) {
				failures.push(`${argv.join(" ")}: ${(err as Error).message.split("\n")[0]}`);
			} finally {
				r.cleanup();
			}
		}
		expect(failures).toEqual([]);
	}, 120_000);

	test("an unknown command's --help falls back to the general help, exit 0", () => {
		const r = runHelp(["zzznotreal", "--help"]);
		try {
			expectHelpIsInert(r);
		} finally {
			r.cleanup();
		}
	}, 30_000);

	for (const flag of ["-h", "--help"]) {
		for (const mode of [[], ["--check"]]) {
			test(`secrets-guard ${mode.join(" ")} ${flag} prints usage without stdin or child IO`, () => {
				const r = runHelp(["secrets-guard", ...mode, flag], false, true);
				try { expectHelpIsInert(r); } finally { r.cleanup(); }
			});
		}
		test(`agent run receives ${flag} as message data`, () => {
			const r = runHelp(["agent", "run", "--id", "demo", "--message", flag], true);
			try {
				expect(r.status).toBe(0);
				expect(r.out).toContain(JSON.stringify({ message: flag }));
				expect(r.out).not.toContain("Usage");
			} finally { r.cleanup(); }
		});

		test(`a declared string option receives ${flag} as its value`, () => {
			const r = runHelp(["context", "update", "probe", "--summary", flag, "--json"]);
			try {
				expect(r.status).toBe(0);
				expect(r.out).not.toContain("Usage");
				expect(JSON.parse(r.out).summary).toBe(flag);
			} finally { r.cleanup(); }
		});

		test(`an undeclared value option receives ${flag} as its value`, () => {
			const r = runHelp(["init", "--model", flag], true);
			try {
				expect(r.status).toBe(0);
				expect(r.out).toContain(JSON.stringify({ model: flag }));
				expect(r.out).not.toContain("Usage");
			} finally { r.cleanup(); }
		});

		for (const separator of [false, true]) {
			test(`office exec child receives ${flag} ${separator ? "after --" : "without a separator"}`, () => {
				expectChildData(["office", "exec", "demo", ...(separator ? ["--"] : [])], flag);
			});
		}
		for (const options of [["--json", "false"], ["--unknown-option", "data"]]) {
			test(`office exec child receives ${flag} with ${options[0]} before the command`, () => {
				expectChildData([...options, "office", "exec", "demo"], flag);
			});
		}
		test(`mail watch hook receives ${flag}`, () => {
			expectChildData(["mail", "watch", "demo", "--sandbox-required", "--exec"], flag);
		});
		test(`secrets-guard child receives ${flag}`, () => {
			expectChildData(["secrets-guard"], flag);
		});
	}
});

// cli#550 — a --version/-v meant for a wrapped command reaches the child
// unchanged; only one before the wrapped command asks for tps's own version.
describe("TPS --version after a wrapped command is data (cli#550)", () => {
	for (const flag of ["-v", "--version"]) {
		test(`tps ${flag} prints the version and exits 0`, () => {
			const r = runHelp([flag]);
			try {
				expect(r.signal).toBeNull();
				expect(r.status).toBe(0);
				expect(r.out.trim()).toBe("dev");
				expect(r.out).not.toContain("Usage");
				expect(r.files).toEqual([]);
				expect(r.nonoRuns).toBe("");
			} finally { r.cleanup(); }
		});

		test(`secrets-guard ${flag} before the wrapped command prints the version`, () => {
			const r = runHelp(["secrets-guard", flag]);
			try {
				expect(r.signal).toBeNull();
				expect(r.status).toBe(0);
				expect(r.out.trim()).toBe("dev");
				expect(r.out).not.toContain("Usage");
			} finally { r.cleanup(); }
		});

		test(`agent run receives ${flag} as message data`, () => {
			const r = runHelp(["agent", "run", "--id", "demo", "--message", flag], true);
			try {
				expect(r.status).toBe(0);
				expect(r.out).toContain(JSON.stringify({ message: flag }));
				expect(r.out).not.toContain("Usage");
			} finally { r.cleanup(); }
		});

		for (const separator of [false, true]) {
			test(`office exec child receives ${flag} ${separator ? "after --" : "without a separator"}`, () => {
				expectChildData(["office", "exec", "demo", ...(separator ? ["--"] : [])], flag);
			});
		}
		for (const options of [["--json", "false"], ["--unknown-option", "data"]]) {
			test(`office exec child receives ${flag} with ${options[0]} before the command`, () => {
				expectChildData([...options, "office", "exec", "demo"], flag);
			});
		}
		test(`mail watch hook receives ${flag}`, () => {
			expectChildData(["mail", "watch", "demo", "--sandbox-required", "--exec"], flag);
		});
		test(`secrets-guard child receives ${flag}`, () => {
			expectChildData(["secrets-guard"], flag);
		});
		test(`secrets-guard --no-guard child receives ${flag}`, () => {
			expectChildData(["secrets-guard", "--no-guard"], flag);
		});
	}
});

function expectChildData(prefix: string[], flag: string): void {
	const root = mkdtempSync(join(tmpdir(), "tps-help-child-"));
	const child = join(root, "child.mjs");
	writeFileSync(child, 'console.log("CHILD_ARGV=" + JSON.stringify(process.argv.slice(2)));');
	const r = runHelp([...prefix, process.execPath, child, flag], true);
	try {
		expect(r.signal).toBeNull();
		expect(r.status).toBe(0);
		expect(r.out).toContain(`CHILD_ARGV=${JSON.stringify([flag])}`);
		expect(r.out).not.toContain("Usage");
	} finally {
		r.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
}
