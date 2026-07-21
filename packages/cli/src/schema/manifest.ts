import { z } from "zod";
import safeRegex from "safe-regex";

// Patterns come from tps.yaml manifests and are evaluated against inbound mail
// bodies. Compiling a pattern only proves it is well-formed — not that its
// evaluation cost is bounded by input length. We therefore validate on two
// axes so "validated" means "safe to run", not merely "parses":
//   1. it compiles to a RegExp, and
//   2. safeRegex accepts it (keeps match cost bounded relative to input).
// Manifests carrying a rejected pattern fail schema validation and are dropped,
// so a rejected pattern never reaches the runtime match sites.
const RegexStringSchema = z
  .string()
  .refine((val) => {
    try {
      new RegExp(val); // nosemgrep: detect-non-literal-regexp — validating a config-provided pattern for well-formedness
      return true;
    } catch {
      return false;
    }
  }, { message: "Invalid regular expression" })
  .refine((val) => safeRegex(val), {
    message: "Regular expression pattern rejected by safety validation",
  });

export const MailHandlerMatchSchema = z.object({
  from: z.array(z.string()).optional(),
  bodyPattern: RegexStringSchema.optional(),
}).strict();

export const MailHandlerCapabilitySchema = z.object({
  enabled: z.boolean().default(true),
  exec: z.string().optional(),
  priority: z.number().default(100),
  timeout: z.number().default(30),
  needs_roster: z.boolean().default(false),
  match: MailHandlerMatchSchema.optional(),
}).strict();

export const RoutingRuleSchema = z.object({
  pattern: RegexStringSchema,
  to: z.string(),
}).strict();

export const TpsYamlSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.object({
    mail_handler: MailHandlerCapabilitySchema.optional(),
  }).optional(),
  routing: z.array(RoutingRuleSchema).optional(),
}).strict();

export type TpsYaml = z.infer<typeof TpsYamlSchema>;

export const OfficeManifestSchema = z.object({
  name: z.string().min(1),
  purpose: z.enum(["ops", "research", "development", "adversarial"]).default("ops"),
  image: z.string().optional(),
  runtime: z.string().optional(),
  manager: z.object({
    name: z.string(),
    persona: z.string(),
    role: z.string().optional(),
  }),
  agents: z.array(z.object({
    name: z.string(),
    persona: z.string(),
    role: z.string().optional(),
    runtime: z.string().optional(),
  })).default([]),
  mounts: z.array(z.object({
    host: z.string(),
    target: z.string(),
    readonly: z.boolean().default(true),
  })).optional(),
  resources: z.object({
    memory: z.string().optional(),
    cpus: z.union([z.number(), z.string()]).optional(),
  }).optional(),
  wall: z.boolean().default(false),
  context: z.object({
    briefs: z.array(z.string()).optional(),
    mounts: z.array(z.object({
      host: z.string(),
      target: z.string(),
      readonly: z.boolean().default(true),
    })).optional(),
  }).optional(),
}).strict();

export type OfficeManifest = z.infer<typeof OfficeManifestSchema>;

export function parseOfficeManifest(path: string): OfficeManifest {
  const { readFileSync } = require("node:fs");
  const { load } = require("js-yaml");
  const doc = load(readFileSync(path, "utf-8"));
  return OfficeManifestSchema.parse(doc);
}
