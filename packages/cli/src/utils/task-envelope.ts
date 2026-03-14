/**
 * task-envelope.ts — Structured task message format for TPS mail.
 *
 * Task messages are JSON with a `type` field starting with "task.".
 * Plain text mail is unchanged — no breaking changes to existing flow.
 */

export interface TaskEnvelope {
  type: string;
  taskId: string;
  [key: string]: unknown;
}

/**
 * Try to parse a mail body as a task envelope.
 * Returns the envelope if valid, null if plain text or non-task JSON.
 */
export function parseTaskEnvelope(body: string): TaskEnvelope | null {
  if (!body || typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.type === "string" &&
      parsed.type.startsWith("task.") &&
      typeof parsed.taskId === "string" &&
      parsed.taskId.length > 0
    ) {
      return parsed as TaskEnvelope;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Format a task envelope as a human-readable one-liner.
 * e.g. "[task.assign] ops-119: Global Address List (P0)"
 */
export function formatTaskEnvelope(envelope: TaskEnvelope): string {
  const parts: string[] = [`[${envelope.type}] ${envelope.taskId}`];

  const title = typeof envelope.title === "string" ? envelope.title : null;
  if (title) parts.push(`: ${title}`);

  const priority = typeof envelope.priority === "string" ? envelope.priority : null;
  if (priority) parts.push(` (${priority})`);

  const pr = typeof envelope.pr === "string" ? envelope.pr : null;
  const verdict = typeof envelope.verdict === "string" ? envelope.verdict : null;
  if (pr && !title) parts.push(`: ${pr}`);
  if (verdict) parts.push(` — ${verdict}`);

  const reason = typeof envelope.reason === "string" ? envelope.reason : null;
  if (reason) parts.push(`: ${reason}`);

  const message = typeof envelope.message === "string" ? envelope.message : null;
  if (message && !title && !pr) parts.push(`: ${message}`);

  return parts.join("");
}

/**
 * Construct a task envelope JSON string for sending.
 * Validates required fields before serializing.
 */
export function createTaskEnvelope(
  type: string,
  fields: Record<string, unknown>
): string {
  if (!type || !type.startsWith("task.")) {
    throw new Error(`Invalid task type: "${type}" — must start with "task."`);
  }
  const taskId = fields.taskId ?? fields["task-id"];
  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("taskId is required and must be a non-empty string");
  }
  const envelope: TaskEnvelope = {
    type,
    taskId: String(taskId).trim(),
    ...fields,
  };
  // Remove undefined values for clean JSON
  const clean = Object.fromEntries(
    Object.entries(envelope).filter(([, v]) => v !== undefined)
  );
  return JSON.stringify(clean);
}
