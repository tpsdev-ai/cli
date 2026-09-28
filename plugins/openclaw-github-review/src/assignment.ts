/**
 * assignment.ts — the trusted session→dispatch binding.
 *
 * The assignment is created by a trusted host component at dispatch time and
 * written to a host-managed file. No agent-invokable tool can create or change
 * one. Missing, expired or inactive assignments refuse posting.
 */

import { readFileSync } from "node:fs";
import type { AssignmentResolver, DispatchAssignment } from "./types.js";

interface AssignmentFileShape {
  assignments?: unknown;
}

function parseAssignment(raw: unknown): DispatchAssignment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const sessionKey = typeof o.sessionKey === "string" ? o.sessionKey : null;
  const reviewer = typeof o.reviewer === "string" ? o.reviewer : null;
  const repo = typeof o.repo === "string" ? o.repo : null;
  const pr = typeof o.pr === "number" && Number.isInteger(o.pr) ? o.pr : null;
  const reviewedCommit = typeof o.reviewedCommit === "string" ? o.reviewedCommit : null;
  const dispatchId = typeof o.dispatchId === "string" ? o.dispatchId : null;
  const expiresAt = typeof o.expiresAt === "string" ? o.expiresAt : null;
  const active = o.active === true;
  if (!sessionKey || !reviewer || !repo || pr === null || !reviewedCommit || !dispatchId || !expiresAt) {
    return null;
  }
  return { sessionKey, reviewer, repo, pr, reviewedCommit, dispatchId, expiresAt, active };
}

/** A resolver backed by the host-managed assignment file. It re-reads the file
 *  on every resolve so a reassignment by the host takes effect immediately. A
 *  missing or malformed file resolves to `null` (fail closed). */
export class FileAssignmentResolver implements AssignmentResolver {
  constructor(private readonly file: string) {}

  resolve(sessionKey: string): DispatchAssignment | null {
    let parsed: AssignmentFileShape;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as AssignmentFileShape;
    } catch {
      return null;
    }
    const list = Array.isArray(parsed.assignments) ? parsed.assignments : [];
    for (const entry of list) {
      const a = parseAssignment(entry);
      if (a && a.sessionKey === sessionKey) return a;
    }
    return null;
  }
}

/** An in-memory resolver for tests and for hosts that inject assignments
 *  directly (never used in production registration). */
export class StaticAssignmentResolver implements AssignmentResolver {
  private readonly bySession = new Map<string, DispatchAssignment>();
  constructor(assignments: DispatchAssignment[]) {
    for (const a of assignments) this.bySession.set(a.sessionKey, a);
  }
  resolve(sessionKey: string): DispatchAssignment | null {
    return this.bySession.get(sessionKey) ?? null;
  }
}
