// ops-88 smoke test passed
export function formatTaskCompleteMailBody(summary: string, prefix = "Task complete"): string {
  const trimmedSummary = summary.trimStart();
  const prefixPattern = new RegExp(`^${prefix}:?(?:\\r?\\n\\s*|\\s+)`, "i");
  const normalizedSummary = trimmedSummary.replace(prefixPattern, "");
  return `${prefix}:\n\n${normalizedSummary}`;
}
