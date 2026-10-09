/**
 * patch-shared.ts — cli#568: the one canonical way a cli test file may write a
 * value onto a shared global or onto a property of an imported module object.
 *
 * `mock.restore()` does not undo a direct assignment such as
 * `globalThis.fetch = mock(...)` or `obj.method = mock(...)` (measured on bun
 * 1.3.10): the assignment replaces the binding and registers nothing with the
 * mock registry, so `mock.restore()` has nothing to put back. A file that
 * patches a shared object must therefore save the original and restore it
 * itself. This helper does both: it saves the original, assigns the value, and
 * registers an unconditional top-level `afterAll` that restores the original
 * when the file's tests are done, so the next test file in the process sees it.
 *
 * Call it at the top level of a test file. The well-known globals in
 * guarded-globals.ts are checked at run time by helpers/global-leak-preload.ts;
 * this helper is what the static scan (helpers/mock-restore-guard-scan.ts)
 * requires for every other direct assignment to a global or to an imported
 * module object's property.
 */
import { afterAll } from "bun:test";

/**
 * Save `target[property]`, set it to `value`, and restore the saved original in
 * an unconditional top-level `afterAll`. Returns nothing: the restore is
 * registered, so a caller cannot forget it.
 */
export function patchShared<T extends object, K extends keyof T>(target: T, property: K, value: T[K]): void {
  const original = target[property];
  target[property] = value;
  afterAll(() => {
    target[property] = original;
  });
}
