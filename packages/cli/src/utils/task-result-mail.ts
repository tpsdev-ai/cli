// Escape regex metacharacters so an interpolated string is matched literally.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatTaskCompleteMailBody(summary: string, prefix = "Task complete"): string {
  const trimmedSummary = summary.trimStart();
  // `prefix` is interpolated into a pattern, so it must be escaped — otherwise
  // metacharacters in the prefix (e.g. parentheses in "Task complete (via …)")
  // are interpreted as regex syntax and the leading-prefix strip silently
  // misbehaves. Escaping keeps the match strictly literal.
  const prefixPattern = new RegExp(`^${escapeRegex(prefix)}:?(?:\\r?\\n\\s*|\\s+)`, "i"); // nosemgrep: detect-non-literal-regexp — prefix escaped above
  const normalizedSummary = trimmedSummary.replace(prefixPattern, "");
  return `${prefix}:\n\n${normalizedSummary}`;
}
