import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { createHash } from "node:crypto";
import type { AgentConfig } from "./runtime/types.js";

export interface AgentRuntimeConfig {
  agentId: string;
  name: string;
  mailDir: string;
  memoryPath?: string;
  workspace: string;
  systemPrompt?: string;
  llm: {
    provider: "anthropic" | "google" | "openai" | "ollama";
    model: string;
    apiKey?: string;
    baseUrl?: string;
  };
  contextWindowTokens?: number;
  maxTokens?: number;
  tools?: Array<"read" | "write" | "edit" | "exec" | "mail">;
  execAllowlist?: string[];
}

export function loadAgentConfig(path: string): AgentConfig {
  const raw = readFileSync(path, "utf-8");
  const parsed = (yaml.load(raw) ?? {}) as Record<string, any>;

  const workspace = String(parsed.workspace || parsed.repo || process.cwd());
  const memoryPath = parsed.memoryPath || `${workspace}/.openclaw/agent.memory.jsonl`;

  const agent: AgentConfig = {
    agentId: String(parsed.agentId || parsed.id || "agent"),
    name: String(parsed.name || parsed.agentId || "agent"),
    workspace,
    mailDir: String(parsed.mailDir || `${workspace}/mail`),
    memoryPath: String(memoryPath),
    systemPrompt: parsed.systemPrompt ? String(parsed.systemPrompt) : undefined,
    contextWindowTokens: parsed.contextWindowTokens ? Number(parsed.contextWindowTokens) : 8192,
    maxTokens: parsed.maxTokens ? Number(parsed.maxTokens) : 1024,
    tools: parsed.tools ?? ["read", "write", "edit", "exec", "mail"],
    execAllowlist: parsed.execAllowlist,
    llm: {
      provider: parsed.llm?.provider || parsed.provider || "openai",
      model: parsed.llm?.model || parsed.model || "gpt-4o-mini",
      apiKey: parsed.llm?.apiKey || parsed.apiKey,
      baseUrl: parsed.llm?.baseUrl || parsed.baseUrl,
    },
  };

  return agent;
}

export function defaultMemoryPath(workspace: string): string {
  const digest = createHash("sha1").update(workspace).digest("hex").slice(0, 8);
  return `${workspace}/.openclaw/memory-${digest}.jsonl`;
}

export function normalizeConfigObject(value: unknown): AgentRuntimeConfig {
  if (typeof value !== "object" || !value) {
    throw new Error("Invalid agent config");
  }
  return value as AgentRuntimeConfig;
}
