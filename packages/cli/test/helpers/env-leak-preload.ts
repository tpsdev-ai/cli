/**
 * env-leak-preload.ts — cli#555: appends a process.env check to each cli test
 * file. Listed in packages/cli/bunfig.toml as a test preload.
 *
 * Every cli test file runs in ONE bun process, so an env name a file sets and
 * does not put back is still set when later files run. Measured on bun 1.3.10:
 * a preload's own beforeAll/afterAll run once for the whole run, not per file,
 * and a runtime plugin's onLoad runs for each test file as bun loads it, after
 * the previous file has finished. So this preload registers a plugin whose
 * onLoad, for each `.test`/`.spec` file, copies process.env and appends one
 * line to the file's source. That line registers an afterAll at the end of the
 * file's top-level code, so it runs after the top-level afterAll hooks the file
 * registered before it; it fails the file when process.env differs from the
 * copy, naming the names added, removed or changed (never their values).
 */
import { plugin } from "bun";
import { afterAll } from "bun:test";

const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const STATE = Symbol.for("tps.cli-test.env-leak-guard");

type Env = Record<string, string | undefined>;

interface GuardState {
  atLoad: Map<string, Env>;
  check: (path: string) => void;
}

export interface EnvDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** The names `after` adds to, removes from, or changes in `before`. */
export function diffEnv(before: Env, after: Env): EnvDiff {
  return {
    added: Object.keys(after).filter((name) => !Object.hasOwn(before, name)).sort(),
    removed: Object.keys(before).filter((name) => !Object.hasOwn(after, name)).sort(),
    changed: Object.keys(after).filter((name) => Object.hasOwn(before, name) && before[name] !== after[name]).sort(),
  };
}

/** The test files this process loaded through the guard. */
export function guardedFiles(): string[] {
  return [...state().atLoad.keys()];
}

function state(): GuardState {
  const existing = (globalThis as Record<symbol, GuardState | undefined>)[STATE];
  if (!existing) throw new Error("env-leak-preload: the guard is not installed in this process");
  return existing;
}

function check(path: string): void {
  const before = state().atLoad.get(path);
  if (!before) throw new Error(`env-leak-preload: no process.env copy was taken when ${path} loaded`);
  afterAll(() => {
    const { added, removed, changed } = diffEnv(before, { ...process.env });
    if (added.length + removed.length + changed.length === 0) return;
    const parts = [
      added.length > 0 ? `added ${added.join(", ")}` : "",
      removed.length > 0 ? `removed ${removed.join(", ")}` : "",
      changed.length > 0 ? `changed ${changed.join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(`${path} left process.env different from when it loaded: ${parts.join("; ")}`);
  });
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith("tsx")) return "tsx";
  if (path.endsWith("jsx")) return "jsx";
  return /ts$/.test(path) ? "ts" : "js";
}

if (!(globalThis as Record<symbol, unknown>)[STATE]) {
  const guard: GuardState = { atLoad: new Map(), check };
  (globalThis as Record<symbol, unknown>)[STATE] = guard;
  plugin({
    name: "cli-test-env-leak-guard",
    setup(build) {
      build.onLoad({ filter: TEST_FILE }, async ({ path }) => {
        guard.atLoad.set(path, { ...process.env });
        const source = await Bun.file(path).text();
        const call = `globalThis[Symbol.for(${JSON.stringify(STATE.description)})].check(${JSON.stringify(path)});`;
        return { contents: `${source}\n;${call}\n`, loader: loaderFor(path) };
      });
    },
  });
}
