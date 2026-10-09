/**
 * global-leak-preload.ts — cli#568: the guarded-global half of the cli test leak
 * guard. helpers/leak-preload.ts is the preload bun runs (listed in
 * packages/cli/bunfig.toml) and calls the install/onLoad/snippet functions here
 * for each `.test`/`.spec` file it loads (bun runs only the first plugin whose
 * onLoad matches, so both checks share one plugin).
 *
 * The preload records the guarded globals' values for each file as bun loads
 * it and appends one line to the file's source. That line registers an afterAll
 * at the end of the file's top-level code, so it runs after the top-level
 * afterAll hooks the file registered before it; it fails the file when a
 * guarded global no longer holds the value it held when the file loaded,
 * naming the ones that changed.
 */
import { afterAll } from "bun:test";
import { GUARDED_GLOBALS, guardedName, guardedObject } from "./guarded-globals.js";

const STATE = Symbol.for("tps.cli-test.global-leak-guard");

/** A guarded global's name to the value it held when its file loaded. */
type Snapshot = Map<string, unknown>;

interface GuardState {
  atLoad: Map<string, Snapshot>;
  check: (path: string) => void;
}

/** The guarded-global names whose value differs between `before` and `now`. */
export function diffGlobals(before: Snapshot, now: Snapshot): string[] {
  return [...before.keys()].filter((name) => !Object.is(before.get(name), now.get(name))).sort();
}

/** The test files this process loaded through the guard. */
export function guardedGlobalFiles(): string[] {
  return [...state().atLoad.keys()];
}

/** Install the guarded-global state. helpers/leak-preload.ts calls this once. */
export function installGlobalLeakGuard(): void {
  if ((globalThis as Record<symbol, unknown>)[STATE]) return;
  const guard: GuardState = { atLoad: new Map(), check };
  (globalThis as Record<symbol, unknown>)[STATE] = guard;
}

/** Record the guarded globals for a test file as the preload loads it. */
export function globalGuardOnLoad(path: string): void {
  state().atLoad.set(path, snapshot());
}

/** The line the preload appends to a test file's source to check it at the end. */
export function globalGuardSnippet(path: string): string {
  return `globalThis[Symbol.for(${JSON.stringify(STATE.description)})].check(${JSON.stringify(path)});`;
}

/** The current value of every guarded global that exists in this process. */
function snapshot(): Snapshot {
  const values: Snapshot = new Map();
  for (const entry of GUARDED_GLOBALS) {
    const target = guardedObject(entry.object);
    if (!target) continue;
    values.set(guardedName(entry), target[entry.property]);
  }
  return values;
}

function state(): GuardState {
  const existing = (globalThis as Record<symbol, GuardState | undefined>)[STATE];
  if (!existing) throw new Error("global-leak-preload: the guard is not installed in this process");
  return existing;
}

function check(path: string): void {
  const before = state().atLoad.get(path);
  if (!before) throw new Error(`global-leak-preload: no guarded-global snapshot was taken when ${path} loaded`);
  afterAll(() => {
    const changed = diffGlobals(before, snapshot());
    if (changed.length === 0) return;
    throw new Error(`${path} left a guarded global changed from when it loaded: ${changed.join(", ")}`);
  });
}
