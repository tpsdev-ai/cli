export type HookName =
  | "agent.boot"
  | "agent.ready"
  | "task.before"
  | "task.after"
  | "mail.received"
  | "workspace.before_reset"
  | "workspace.after_reset";

export interface HookContext {
  agentId: string;
  [key: string]: unknown;
}

export interface HookRegistration<T extends HookContext = HookContext> {
  name: string;
  priority: number;
  fn: (ctx: T) => Promise<unknown>;
}

const _hooks = new Map<HookName, HookRegistration[]>();

export function registerHook(hook: HookName, registration: HookRegistration): void {
  const list = _hooks.get(hook) ?? [];
  list.push(registration);
  list.sort((a, b) => a.priority - b.priority);
  _hooks.set(hook, list);
}

export async function runHooks(hook: HookName, ctx: HookContext): Promise<unknown[]> {
  const list = _hooks.get(hook) ?? [];
  const results: unknown[] = [];
  for (const reg of list) {
    results.push(await reg.fn(ctx));
  }
  return results;
}

export function getHooks(hook: HookName): HookRegistration[] {
  return _hooks.get(hook) ?? [];
}

export function resetHooks(): void {
  _hooks.clear();
}
