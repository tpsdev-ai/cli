import { registerSlot } from "./registry.js";
import { FlairMemoryProvider } from "./flair-memory.js";
import type { FlairClient } from "../utils/flair-client.js";

export interface PluginConfig {
  slots?: {
    memory?: "flair";
  };
}

export function loadPlugins(config: PluginConfig, deps: { flair?: FlairClient }): void {
  const memorySlot = config.slots?.memory ?? "flair";
  if (memorySlot === "flair" && deps.flair) {
    registerSlot("memory", new FlairMemoryProvider(deps.flair));
  }
}
