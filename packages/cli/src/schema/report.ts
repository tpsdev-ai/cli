import { z } from "zod";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";

/**
 * The type names zod 3 used in "Expected string, received …", in the order
 * zod 3.25.76's getParsedType checks them.
 */
function receivedType(value: unknown): string {
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(value) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object": {
      if (Array.isArray(value)) return "array";
      if (value === null) return "null";
      const thenable = value as { then?: unknown; catch?: unknown };
      if (typeof thenable.then === "function" && typeof thenable.catch === "function") return "promise";
      if (value instanceof Map) return "map";
      if (value instanceof Set) return "set";
      if (value instanceof Date) return "date";
      return "object";
    }
    default:
      return "unknown";
  }
}

function requiredMessage(message: string) {
  return (issue: { code?: string; input?: unknown }) => {
    if (issue.code !== "invalid_type") return undefined;
    return issue.input === undefined ? message : `Expected string, received ${receivedType(issue.input)}`;
  };
}

export const TPSReportSchema = z.object({
  version: z
    .string()
    .default("1")
    .describe("TPS report version"),

  name: z
    .string({ error: requiredMessage("I'm gonna need you to put a name on that TPS report.") })
    .min(1, "The name field is empty. Did you get the memo about filling out all the fields?"),

  description: z
    .string({ error: requiredMessage("Description missing. What exactly would you say... this agent does?") })
    .min(1, "Description can't be blank. We need to know what this agent does here."),

  identity: z.object({
    default_name: z
      .string({ error: requiredMessage("Every agent needs a name. Even Milton had a name.") })
      .min(1),
    emoji: z.string().default("📋"),
    personality: z
      .string()
      .default("Professional and helpful."),
    communication_style: z
      .string()
      .default("Clear and direct."),
  }),

  flair: z
    .array(z.string())
    .default([])
    .describe("Pieces of flair — capabilities this agent brings to the table"),

  model: z.object({
    default: z.string().default("reasoning"),
  }).prefault({}),

  tools: z.object({
    required: z.array(z.string()).default([]),
    optional: z.array(z.string()).default([]),
  }).prefault({}),

  communication: z.object({
    channels: z.array(z.string()).default(["direct"]),
    handoff_targets: z.array(z.string()).default([]),
  }).prefault({}),

  boundaries: z.object({
    can_commit: z.boolean().default(false),
    can_send_external: z.boolean().default(false),
    can_spend: z.boolean().default(false),
  }).prefault({}),

  memory: z.object({
    private: z.boolean().default(true),
    shared_read: z.array(z.string()).default([]),
    shared_write: z.array(z.string()).default([]),
  }).prefault({}),

  openclaw: z.object({
    model: z.string().default("anthropic/claude-sonnet-4-20250514"),
    thinking: z.string().default("off"),
    channel: z.string().default("discord"),
  }).prefault({}),
});

export type TPSReport = z.infer<typeof TPSReportSchema>;

export function parseTPSReport(filePath: string): TPSReport {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `PC Load Letter? Couldn't read file: ${filePath}\nWhat does that even mean? Check the path and try again.`
    );
  }

  // Pre-parse guardrails against YAML anchor expansion DoS (Billion Laughs).
  if (raw.length > 65_536) {
    throw new Error("TPS report exceeds maximum size (64KB).");
  }
  const aliasRefs = (raw.match(/\*/g) ?? []).length;
  if (aliasRefs > 20) {
    throw new Error("TPS report contains too many YAML aliases (max 20).");
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e: any) {
    throw new Error(
      `I'm gonna need you to fix that TPS report. YAML parse error:\n${e.message}`
    );
  }

  const result = TPSReportSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Did you get the memo about the TPS reports? Validation failed:\n${issues}`
    );
  }

  return result.data;
}
