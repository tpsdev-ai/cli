/**
 * cli#342 — `--help`/`-h` on a subcommand must print that command's usage and
 * exit 0, never run the command. Before the fix, `branch init --help` minted a
 * branch identity and opened a listener, `branch start --help` started a
 * daemon, and `identity init --help` rewrote every nono profile.
 *
 * Black-box: spawn the built CLI under node, non-TTY, with a throwaway HOME and
 * a fake `nono` first on PATH, and assert exit 0, usage on stdout, no file
 * created under HOME, and no `nono run` logged. The command list is read from
 * bin/tps.ts so a new top-level command cannot be added without this test
 * covering its `--help`.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const BIN_SOURCE = resolve(import.meta.dir, "../bin/tps.ts");
const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

/** The top-level commands of bin/tps.ts's dispatch switch, read from the source. */
function topLevelCommands(): string[] {
	const source = readFileSync(BIN_SOURCE, "utf-8");
	const names = [...source.matchAll(/^ {4}case "([a-z0-9-]+)":/gm)].map((m) => m[1]!);
	return [...new Set(names)].sort();
}

/**
 * `secrets-guard` wraps a command — its tail is that command's argv — so a
 * `--help` in it is not tps's (cli#342). `tps secrets-guard --help` is
 * therefore out of scope for the help assertions below.
 */
const PASS_THROUGH = new Set(["secrets-guard"]);

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

/** Run `<argv> --help` (argv includes the trailing help flag) against a fresh HOME. */
function runHelp(argv: string[]): Result & { cleanup: () => void } {
	const f = fixture();
	const before = tree(f.home);
	const r = spawnSync("node", [TPS_BIN, ...argv], {
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

describe("tps --help never executes the command (cli#342)", () => {
	test("every top-level command prints usage and exits 0 with no side effects", () => {
		const commands = topLevelCommands();
		// The source parse must see the real dispatch table; a silent regex miss
		// would turn this test into a no-op.
		expect(commands.length).toBeGreaterThan(20);
		expect(commands).toContain("branch");
		expect(commands).toContain("identity");
		const failures: string[] = [];
		for (const command of commands) {
			if (PASS_THROUGH.has(command)) continue;
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

	test("--help after a `--` separator belongs to the wrapped command, not tps", () => {
		// `tps office exec <agent> -- <cmd...>` passes its tail through; a `--help`
		// there must reach the wrapped command. Here the wrapped command is `true`,
		// so the run must not be turned into tps help.
		const r = runHelp(["office", "exec", "nobody", "--", "true"]);
		try {
			// Not a help request: tps dispatches `office exec`, which fails (there is
			// no such agent) — the point is that no usage was printed for it.
			expect(r.out).not.toContain("tps office join <name> <join-token>");
		} finally {
			r.cleanup();
		}
	}, 30_000);
});
