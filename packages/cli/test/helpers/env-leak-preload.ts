/**
 * env-leak-preload.ts — cli#555: the process.env half of the cli test leak
 * guard. helpers/leak-preload.ts is the preload bun runs (listed in
 * packages/cli/bunfig.toml) and calls the install/onLoad/snippet functions here
 * for each `.test`/`.spec` file it loads (cli#568: bun runs only the first
 * plugin whose onLoad matches, so both checks share one plugin).
 *
 * Every cli test file runs in ONE bun process, so an env name a file sets and
 * does not put back is still set when later files run. Measured on bun 1.3.10:
 * a preload's own beforeAll/afterAll run once for the whole run, not per file,
 * and a runtime plugin's onLoad runs for each test file as bun loads it, after
 * the previous file has finished. So the preload copies process.env for each
 * file and appends one line to its source. That line registers an afterAll at
 * the end of the file's top-level code, so it runs after the top-level afterAll
 * hooks the file registered before it; it fails the file when process.env
 * differs from the copy, naming the names added, removed or changed (never
 * their values).
 */
import { afterAll } from "bun:test";

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

/** Install the process.env guard state. helpers/leak-preload.ts calls this once. */
export function installEnvGuard(): void {
  if ((globalThis as Record<symbol, unknown>)[STATE]) return;
  const guard: GuardState = { atLoad: new Map(), check };
  (globalThis as Record<symbol, unknown>)[STATE] = guard;
}

/** Copy process.env for a test file as the preload loads it. */
export function envGuardOnLoad(path: string): void {
  state().atLoad.set(path, { ...process.env });
}

/** The line the preload appends to a test file's source to check it at the end. */
export function envGuardSnippet(path: string): string {
  return `globalThis[Symbol.for(${JSON.stringify(STATE.description)})].check(${JSON.stringify(path)});`;
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
