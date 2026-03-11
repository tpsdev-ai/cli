export { getRegistry, registerSlot, getSlot, resetRegistry } from "./registry.js";
export type { MemoryProvider, MemoryResult, MemoryWriteInput, MemoryRecord, SlotRegistry } from "./registry.js";
export { FlairMemoryProvider } from "./flair-memory.js";
export { loadPlugins } from "./loader.js";
export { registerHook, runHooks, getHooks, resetHooks } from "./hooks.js";
export type { HookName, HookContext, HookRegistration } from "./hooks.js";
export { applyRole } from "./roles.js";
export type { RoleConfig } from "./roles.js";
