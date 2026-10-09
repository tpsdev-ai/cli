/**
 * Runtime snapshots: globalThis.fetch, setTimeout, clearTimeout, setInterval,
 * clearInterval, setImmediate, clearImmediate, queueMicrotask; Date.now,
 * process.exit; console.log, console.error, console.warn.
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
  { object: "globalThis", property: "setImmediate" },
  { object: "globalThis", property: "clearImmediate" },
  { object: "globalThis", property: "queueMicrotask" },
  { object: "Date", property: "now" },
  { object: "process", property: "exit" },
  { object: "console", property: "log" },
  { object: "console", property: "error" },
  { object: "console", property: "warn" },
];

/** The live object a guarded global names, or undefined when it is absent. */
export function guardedObject(name: GuardedGlobal["object"]): Record<string, unknown> | undefined {
  return (globalThis as unknown as Record<string, Record<string, unknown> | undefined>)[name];
}

/** A name for a guarded global in a failure message, e.g. `globalThis.fetch`. */
export function guardedName(entry: GuardedGlobal): string {
  return `${entry.object}.${entry.property}`;
}
