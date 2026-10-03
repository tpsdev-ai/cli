/**
 * local-agent.ts — the invoking agent's own id, resolved from configuration.
 *
 * The local agent id comes from an explicit argument or `TPS_AGENT_ID`; a
 * caller that needs it and has neither refuses with a named error instead of
 * falling back to a real agent id (cli#397).
 */

export function requireLocalAgentId(what: string, explicit?: string): string {
  const id = explicit ?? process.env.TPS_AGENT_ID;
  if (!id) {
    throw new Error(`no ${what}: pass an explicit agent id or set TPS_AGENT_ID`);
  }
  return id;
}
