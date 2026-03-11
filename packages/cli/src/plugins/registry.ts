export interface MemoryProvider {
  search(query: string, limit?: number): Promise<MemoryResult[]>;
  write(content: MemoryWriteInput): Promise<{ id: string }>;
  read(id: string): Promise<MemoryRecord | null>;
  bootstrap(opts?: { query?: string; maxTokens?: number }): Promise<string>;
  ping(): Promise<boolean>;
}

export interface MemoryResult {
  id: string;
  text: string;
  agentId: string;
  similarity?: number;
  durability?: string;
  tags?: string[];
  createdAt?: string;
}

export interface MemoryWriteInput {
  text: string;
  agentId: string;
  durability?: "permanent" | "persistent" | "standard" | "ephemeral";
  type?: string;
  tags?: string[];
  supersedes?: string;
}

export interface MemoryRecord extends MemoryResult {
  type?: string;
  archived?: boolean;
  updatedAt?: string;
}

export interface SlotRegistry {
  memory: MemoryProvider | null;
}

let _registry: SlotRegistry = { memory: null };

export function getRegistry(): SlotRegistry {
  return _registry;
}

export function registerSlot<K extends keyof SlotRegistry>(slot: K, provider: SlotRegistry[K]): void {
  _registry[slot] = provider;
}

export function getSlot<K extends keyof SlotRegistry>(slot: K): SlotRegistry[K] {
  return _registry[slot];
}

export function resetRegistry(): void {
  _registry = { memory: null };
}
