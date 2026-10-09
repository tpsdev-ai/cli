/**
 * guarded-globals.ts — cli#568: the well-known globals a cli test file may
 * patch, listed once for both halves of the guard.
 *
 * A cli test file runs in ONE bun process with every other test file, so a
 * value a file writes onto one of these and does not put back changes what a
 * later file observes (cli#544: one leaked prototype spy made two transport
 * tests time out only in suite order).
 *
 * `helpers/global-leak-preload.ts` snapshots each of these when bun loads a
 * test file and fails the file when one differs at the end. The static scan
 * (`helpers/mock-restore-guard-scan.ts`) treats a direct `globalThis.<name>`
 * assignment for one of the `globalThis` entries as covered by that runtime
 * check, and requires the `patchShared` helper for any other direct assignment
 * to a global or to an imported module object.
 */
export interface GuardedGlobal {
  /** The global object the property is reached through, by that name. */
  object: "globalThis" | "Date" | "process" | "console";
  /** The property on it. */
  property: string;
}

export const GUARDED_GLOBALS: readonly GuardedGlobal[] = [
  { object: "globalThis", property: "fetch" },
  { object: "globalThis", property: "setTimeout" },
  { object: "globalThis", property: "clearTimeout" },
  { object: "globalThis", property: "setInterval" },
  { object: "globalThis", property: "clearInterval" },
  { object: "Date", property: "now" },
  { object: "process", property: "exit" },
  { object: "console", property: "log" },
  { object: "console", property: "error" },
  { object: "console", property: "warn" },
];

/**
 * The `globalThis.<property>` names the preload snapshots — the ones the static
 * scan may leave to the runtime check.
 */
export const RUNTIME_GLOBALS: ReadonlySet<string> = new Set(
  GUARDED_GLOBALS.filter((entry) => entry.object === "globalThis").map((entry) => entry.property),
);

/** The live object a guarded global names, or undefined when it is absent. */
export function guardedObject(name: GuardedGlobal["object"]): Record<string, unknown> | undefined {
  return (globalThis as unknown as Record<string, Record<string, unknown> | undefined>)[name];
}

/** A name for a guarded global in a failure message, e.g. `globalThis.fetch`. */
export function guardedName(entry: GuardedGlobal): string {
  return `${entry.object}.${entry.property}`;
}
