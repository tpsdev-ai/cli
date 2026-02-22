import { z } from "zod";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";

export const OfficeAgentSchema = z.object({
  name: z.string().min(1),
  persona: z.string().default("developer"),
  role: z.string().optional(),
  tps_report: z.string().optional(), // path to a .tps file
});

const OfficeContextMountSchema = z.object({
  host: z.string().min(1),
  target: z.string().min(1),
  readonly: z.boolean().default(true),
});

const OfficeContextSchema = z.object({
  briefs: z.array(z.string().min(1).max(1024)).max(20).optional(),
  mounts: z.array(OfficeContextMountSchema).max(20).optional(),
}).optional();

export const OfficeManifestSchema = z.object({
  version: z.string().default("1"),
  name: z.string().min(1, "Office name is required."),
  purpose: z.enum(["development", "research", "adversarial", "ops"]).default("development"),
  manager: OfficeAgentSchema.extend({
    persona: z.string().default("ops"),
  }),
  agents: z.array(OfficeAgentSchema).min(1, "At least one worker agent is required."),
  wall: z.boolean().default(true),
  context: OfficeContextSchema,
});

export type OfficeManifest = z.infer<typeof OfficeManifestSchema>;
export type OfficeAgent = z.infer<typeof OfficeAgentSchema>;

export function parseOfficeManifest(filePath: string): OfficeManifest {
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
    throw new Error("Office manifest exceeds maximum size (64KB).");
  }
  const aliasRefs = (raw.match(/\*/g) ?? []).length;
  if (aliasRefs > 20) {
    throw new Error("Office manifest contains too many YAML aliases (max 20).");
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e: any) {
    throw new Error(
      `I'm gonna need you to fix that office manifest. YAML parse error:\n${e.message}`
    );
  }

  const result = OfficeManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Did you get the memo about the office manifests? Validation failed:\n${issues}`
    );
  }

  return result.data;
}
