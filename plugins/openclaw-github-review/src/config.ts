/**
 * config.ts — resolve the plugin's TRUSTED host configuration.
 *
 * Every value here comes from the gateway's plugin config, never from tool
 * input. A value that is required but absent is left as `null` so the handler
 * can enter an explicit refusal state rather than a seemingly working one.
 */

export interface GithubReviewConfig {
  /** The host-configured repository set; a call for anything else is refused. */
  allowedRepositories: string[];
  /** The finite UTF-8 byte cap for a body. `null` = configuration failure. */
  maxBodyBytes: number | null;
  /** Host-managed dispatch assignment store path; `null` disables posting. */
  assignmentsFile: string | null;
  /** GitHub credential file path (fine-grained PAT). */
  credentialFile: string | null;
  /** Trusted provisioning evidence path, bound to the installed credential. */
  provisioningFile: string | null;
  /** Evidence older than this many days is stale and disables posting. */
  provisioningMaxAgeDays: number;
  /** The reviewer's Flair signing key file (separate custody). */
  signingKeyFile: string | null;
  /** The reviewer agent identity the signing key belongs to. The assignment's
   *  reviewer must match it, so the signed author always matches the session. */
  reviewerIdentity: string | null;
  /** Where a pending (unacknowledged) audit record is retained for retry. */
  pendingAuditFile: string | null;
  /** Host-only store of the review-build evidence APPROVE requires. */
  approvalEvidenceFile: string | null;
  /** The host-held key that authenticates approval-evidence records. */
  approvalEvidenceKeyFile: string | null;
  /** The CI workflow and job an APPROVE's evidence must be for. */
  approvalCiWorkflow: string | null;
  approvalCiJob: string | null;
  /** Every host path a review sandbox mounts; empty = unusable. */
  sandboxMountRoots: string[];
  /** Durable per-dispatch latch for outcomes whose external state is unknown. */
  reconcileFile: string | null;
  flairUrl: string;
  /** The deployed reviewer sandbox image digest, recorded in audit records. */
  sandboxImageDigest: string | null;
  pluginVersion: string;
}

export const DEFAULT_PROVISIONING_MAX_AGE_DAYS = 90;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** An absolute path, or null. */
function asAbsolutePath(v: unknown): string | null {
  const s = asString(v);
  return s !== null && s.startsWith("/") ? s : null;
}

/** A non-empty list of absolute paths, or empty when any entry is not one. */
function asAbsolutePaths(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) return [];
  const paths = v.map(asAbsolutePath);
  return paths.every((p): p is string => p !== null) ? paths : [];
}

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve config from the raw plugin config object. Total function: never
 *  throws on a malformed value; it records the failure as an unusable field. */
export function resolveConfig(raw: unknown, pluginVersion: string): GithubReviewConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const repos = Array.isArray(cfg.allowedRepositories)
    ? cfg.allowedRepositories.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    : [];
  const maxAge = asPositiveInt(cfg.provisioningMaxAgeDays) ?? DEFAULT_PROVISIONING_MAX_AGE_DAYS;
  return {
    allowedRepositories: repos,
    maxBodyBytes: asPositiveInt(cfg.maxBodyBytes),
    assignmentsFile: asString(cfg.assignmentsFile),
    credentialFile: asString(cfg.credentialFile),
    provisioningFile: asString(cfg.provisioningFile),
    provisioningMaxAgeDays: maxAge,
    signingKeyFile: asString(cfg.signingKeyFile),
    reviewerIdentity: asString(cfg.reviewerIdentity),
    pendingAuditFile: asString(cfg.pendingAuditFile),
    approvalEvidenceFile: asAbsolutePath(cfg.approvalEvidenceFile),
    approvalEvidenceKeyFile: asAbsolutePath(cfg.approvalEvidenceKeyFile),
    approvalCiWorkflow: asString(cfg.approvalCiWorkflow),
    approvalCiJob: asString(cfg.approvalCiJob),
    sandboxMountRoots: asAbsolutePaths(cfg.sandboxMountRoots),
    reconcileFile: asString(cfg.reconcileFile),
    flairUrl: asString(cfg.flairUrl) ?? "http://127.0.0.1:9926",
    sandboxImageDigest: asString(cfg.sandboxImageDigest),
    pluginVersion,
  };
}
