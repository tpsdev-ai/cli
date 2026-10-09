/** Canonical save/restore helper for cli test patches. */
import { afterAll } from "bun:test";

const patches = new WeakMap<object, Map<PropertyKey, Array<() => void>>>();

function savePatch<T extends object, K extends keyof T>(target: T, property: K, value: T[K]): () => void {
  const original = Object.getOwnPropertyDescriptor(target, property);
  let properties = patches.get(target);
  if (!properties) { properties = new Map(); patches.set(target, properties); }
  let stack = properties.get(property);
  if (!stack) { stack = []; properties.set(property, stack); }
  const pending = stack;
  const undo = () => {
    if (original) Object.defineProperty(target, property, original);
    else delete target[property];
  };
  Object.defineProperty(target, property, {
    configurable: original?.configurable ?? true,
    enumerable: original?.enumerable ?? true,
    writable: true,
    value,
  });
  pending.push(undo);
  const restore = () => {
    const index = pending.indexOf(undo);
    if (index < 0) return;
    while (pending.length > index) pending.pop()!();
    if (pending.length === 0) properties.delete(property);
  };
  return restore;
}

export function patchShared<T extends object, K extends keyof T>(target: T, property: K, value: T[K]): () => void {
  const restore = savePatch(target, property, value);
  afterAll(restore);
  return restore;
}

/** Call at file scope before patches made in hooks or tests. */
export function createPatchShared(): typeof patchShared {
  const restores: Array<() => void> = [];
  afterAll(() => {
    while (restores.length > 0) restores.pop()!();
  });
  return (target, property, value) => {
    const restore = savePatch(target, property, value);
    restores.push(restore);
    return restore;
  };
}
