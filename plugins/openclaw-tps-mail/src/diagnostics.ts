export type ObligationPresence = "retained" | "none" | "unknown";

export interface StampDiagnosticFacts {
  kind: string;
  actor: string;
  id?: string;
  path: string;
  code?: string;
  obligation: ObligationPresence;
  retriesExhausted?: boolean;
}

export function formatStampDiagnostic(facts: StampDiagnosticFacts): string {
  const fields = [
    `tps-mail: ${facts.kind}:`,
    ...(facts.id === undefined ? [] : [facts.id]),
    `actor=${facts.actor}`,
    `path=${facts.path}`,
    ...(facts.code === undefined ? [] : [`code=${facts.code}`]),
  ];
  const state = facts.obligation === "retained" ? "obligation retained"
    : facts.obligation === "unknown" ? "state unknown" : undefined;
  return [
    fields.join(" "),
    ...(state ? [state] : []),
    ...(facts.retriesExhausted ? ["no retries left"] : []),
    "resolve the failure and restart the account",
  ].join("; ");
}
