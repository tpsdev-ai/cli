import type { TPSReport } from "./report.js";

/**
 * Sanitize an identifier string.
 * Allows only alphanumeric characters, underscores, and hyphens.
 * Replaces invalid characters with hyphens.
 * Truncates to max length (default 64).
 */
export function sanitizeIdentifier(value: string, maxLength = 64): string {
  if (!value) return "unknown";
  // Replace anything not allowed with '-'
  let sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "-");
  // Collapse multiple hyphens
  sanitized = sanitized.replace(/-+/g, "-");
  // Trim leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, "");
  // Default if empty after trim
  if (!sanitized) return "unknown";
  // Truncate
  return sanitized.slice(0, maxLength);
}

/**
 * Sanitize a model identifier string (e.g. provider/model:tag).
 * Allows alphanumeric, underscores, hyphens, slashes, dots, and colons.
 */
export function sanitizeModelIdentifier(value: string, maxLength = 128): string {
  if (!value) return "unknown-model";
  // Allow a-z, 0-9, _, -, /, ., :
  const sanitized = value.replace(/[^a-zA-Z0-9_\-/.:]/g, "");
  // Truncate
  return sanitized.slice(0, maxLength);
}

/**
 * Sanitize free text to prevent shell injection.
 * Escapes characters that have special meaning in shell contexts.
 * Note: This is aggressive and might impact readability in some contexts,
 * but safety is priority.
 */
export function sanitizeFreeText(value: string): string {
  if (!value) return "";
  // Shell metacharacters to escape: $ ` " \
  // We'll replace them with their escaped versions or safe alternatives.
  // For Markdown/HTML contexts, Handlebars handles escaping.
  // This is specifically for preventing command injection if text is passed to shell.
  return value
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/\$/g, "\\$")  // Escape dollar signs
    .replace(/`/g, "\\`")   // Escape backticks
    .replace(/"/g, '\\"')  // Escape double quotes
    .replace(/;/g, "\\;")   // Escape semicolons
    .replace(/\|/g, "\\|")  // Escape pipes
    .replace(/&/g, "\\&")   // Escape ampersands
    .replace(/\(/g, "\\(")  // Escape parentheses
    .replace(/\)/g, "\\)"); // Escape parentheses
}

/**
 * Sanitize an array of strings using the identifier rules.
 */
export function sanitizeStringArray(arr: string[]): string[] {
  if (!arr) return [];
  return arr.map((item) => sanitizeIdentifier(item));
}

/**
 * Main sanitizer function for TPS Reports.
 * Returns a new, sanitized report object.
 */
export function sanitizeTPSReport(report: TPSReport): TPSReport {
  // Deep clone to avoid mutating original
  const sanitized = JSON.parse(JSON.stringify(report)) as TPSReport;

  // Sanitize Top-level fields
  sanitized.name = sanitizeIdentifier(sanitized.name);
  sanitized.description = sanitizeFreeText(sanitized.description);
  
  // Sanitize Identity fields
  sanitized.identity.default_name = sanitizeIdentifier(sanitized.identity.default_name);
  sanitized.identity.personality = sanitizeFreeText(sanitized.identity.personality);
  sanitized.identity.communication_style = sanitizeFreeText(sanitized.identity.communication_style);
  sanitized.identity.emoji = sanitizeFreeText(sanitized.identity.emoji); // Emojis are text? Usually safe but let's be careful.

  // Sanitize Arrays (Identifiers)
  sanitized.flair = sanitizeStringArray(sanitized.flair);
  sanitized.tools.required = sanitizeStringArray(sanitized.tools.required);
  sanitized.tools.optional = sanitizeStringArray(sanitized.tools.optional);
  sanitized.communication.channels = sanitizeStringArray(sanitized.communication.channels);
  sanitized.communication.handoff_targets = sanitizeStringArray(sanitized.communication.handoff_targets);
  sanitized.memory.shared_read = sanitizeStringArray(sanitized.memory.shared_read);
  sanitized.memory.shared_write = sanitizeStringArray(sanitized.memory.shared_write);

  // Sanitize Model (Identifier)
  sanitized.model.default = sanitizeIdentifier(sanitized.model.default);

  // Sanitize OpenClaw fields
  sanitized.openclaw.model = sanitizeModelIdentifier(sanitized.openclaw.model);
  sanitized.openclaw.thinking = sanitizeIdentifier(sanitized.openclaw.thinking);
  sanitized.openclaw.channel = sanitizeIdentifier(sanitized.openclaw.channel);

  return sanitized;
}
