/**
 * credential.ts — GitHub credential custody and the literal pre-request gate.
 *
 * The token is read ONCE, at gateway start, into a #private field of this
 * object. Its path is not re-read afterwards. The only method that exposes it
 * is authorizationHeader(), which builds the Authorization header value for the
 * plugin's own GitHub client (github.ts) and is called nowhere else; nothing
 * logs it, and no diagnostic here names the credential's path. Scope (login, repository coverage, permissions) is established from
 * trusted PROVISIONING EVIDENCE — recorded when the token was installed or
 * rotated and bound to the installed credential — never from the token's
 * appearance nor from a successful request. Unknown or stale evidence disables
 * posting.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { RefusalReason } from "./types.js";

/** The trusted provisioning record, written when the token was installed or
 *  rotated. All fields are host-established facts about the installed token. */
export interface ProvisioningEvidence {
  login: string;
  repositories: string[];
  permissions: Record<string, string>;
  /** sha256 of the installed token bytes, binding this evidence to it. */
  boundCredentialSha256: string;
  /** ISO timestamp the evidence was recorded. */
  recordedAt: string;
  credentialType: "fine-grained";
}

export type ScopeResult =
  | { ok: true; login: string }
  | { ok: false; reason: RefusalReason; state: string; remedy: string };

/** Fine-grained PATs start with this prefix; classic tokens do not. */
const FINE_GRAINED_PREFIX = "github_pat_";

/** Permissions a reviewer posting may hold. Anything outside this map, or any
 *  write beyond pull requests, is refused. `contents` and `issues` may only be
 *  `none`: no documented operation for this verb needs to read them. */
const ALLOWED_PERMISSIONS: Record<string, readonly string[]> = {
  pull_requests: ["write"],
  contents: ["none"],
  metadata: ["read"],
  issues: ["none"],
};

/** A path-free description of a load failure: the errno code, or the error's
 *  class for a parse error. Never the error message, which can carry the path. */
function errCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return err instanceof SyntaxError ? "invalid JSON" : "unreadable";
}

export interface CredentialLoadResult {
  custody: CredentialCustody;
  /** A human-safe diagnostic; never contains the token. */
  detail: string;
}

export class CredentialCustody {
  // A TRUE private field (#): the token is not a property of the instance, so it
  // is not serialized, inspected or enumerated with it. authorizationHeader() is
  // the one method that returns a value built from it.
  #token: string | null = null;
  #tokenSha256: string | null = null;
  private evidence: ProvisioningEvidence | null = null;
  private loadedDetail = "not loaded";

  private constructor() {}

  /**
   * Read the credential file and the provisioning evidence exactly once.
   * Failures are recorded as an unusable state (posting disabled); the token is
   * only held when the file is present, readable and properly protected.
   */
  static load(opts: {
    credentialFile: string | null;
    provisioningFile: string | null;
    maxAgeDays: number;
    clock: () => Date;
  }): CredentialLoadResult {
    const c = new CredentialCustody();
    if (!opts.credentialFile) {
      c.loadedDetail = "no credential file configured";
      return { custody: c, detail: c.loadedDetail };
    }
    let bytes: Buffer;
    try {
      const st = statSync(opts.credentialFile);
      const mode = st.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        c.loadedDetail = `the credential file is group/other-accessible (mode ${mode.toString(8)}); refusing to load`;
        return { custody: c, detail: c.loadedDetail };
      }
      bytes = readFileSync(opts.credentialFile);
    } catch (err) {
      c.loadedDetail = `the credential file is unreadable (${errCode(err)})`;
      return { custody: c, detail: c.loadedDetail };
    }
    const token = bytes.toString("utf8").trim();
    if (token === "") {
      c.loadedDetail = "credential file is empty";
      return { custody: c, detail: c.loadedDetail };
    }
    if (!token.startsWith(FINE_GRAINED_PREFIX)) {
      c.loadedDetail = "credential is not a fine-grained personal access token; classic tokens are disallowed";
      return { custody: c, detail: c.loadedDetail };
    }
    const sha = createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex");

    // Provisioning evidence is mandatory. Unknown or stale evidence disables
    // posting: there is no fallback to an online call.
    if (!opts.provisioningFile) {
      c.loadedDetail = "no provisioning evidence configured";
      return { custody: c, detail: c.loadedDetail };
    }
    let evidence: ProvisioningEvidence;
    try {
      evidence = JSON.parse(readFileSync(opts.provisioningFile, "utf8")) as ProvisioningEvidence;
    } catch (err) {
      c.loadedDetail = `provisioning evidence is unreadable (${errCode(err)})`;
      return { custody: c, detail: c.loadedDetail };
    }
    if (
      !evidence ||
      typeof evidence.login !== "string" ||
      !Array.isArray(evidence.repositories) ||
      typeof evidence.permissions !== "object" ||
      evidence.permissions === null ||
      typeof evidence.boundCredentialSha256 !== "string" ||
      typeof evidence.recordedAt !== "string"
    ) {
      c.loadedDetail = "provisioning evidence is malformed";
      return { custody: c, detail: c.loadedDetail };
    }
    if (evidence.credentialType !== "fine-grained") {
      c.loadedDetail = "provisioning evidence does not describe a fine-grained credential";
      return { custody: c, detail: c.loadedDetail };
    }
    if (evidence.boundCredentialSha256 !== sha) {
      c.loadedDetail = "provisioning evidence is not bound to the installed credential";
      return { custody: c, detail: c.loadedDetail };
    }
    const recordedMs = Date.parse(evidence.recordedAt);
    const ageDays = (opts.clock().getTime() - recordedMs) / 86_400_000;
    if (!Number.isFinite(recordedMs) || ageDays < 0 || ageDays > opts.maxAgeDays) {
      c.loadedDetail = "provisioning evidence is stale";
      return { custody: c, detail: c.loadedDetail };
    }

    c.#token = token;
    c.#tokenSha256 = sha;
    c.evidence = evidence;
    c.loadedDetail = `loaded; login ${evidence.login}`;
    return { custody: c, detail: c.loadedDetail };
  }

  /** Whether the credential and its evidence are usable at all. */
  isReady(): boolean {
    return this.#token !== null && this.evidence !== null;
  }

  /** The verified login from the provisioning record. Available only when
   *  ready; used for audit attribution, never from an online call. */
  verifiedLogin(): string | null {
    return this.evidence?.login ?? null;
  }

  /**
   * The literal pre-request gate. Called before ANY outbound request. Verifies
   * login, repository coverage and permission scope from provisioning evidence
   * for the specific repository being posted to.
   */
  verifyForRepo(repo: string): ScopeResult {
    if (!this.#token || !this.evidence) {
      return {
        ok: false,
        reason: "credential_unavailable",
        state: this.loadedDetail,
        remedy: "install a fine-grained token and its provisioning evidence, then restart the gateway",
      };
    }
    const { evidence } = this;
    if (evidence.login.trim() === "") {
      return {
        ok: false,
        reason: "scope_unverified",
        state: "provisioning evidence has no login",
        remedy: "re-record provisioning evidence with the reviewer login",
      };
    }
    if (!evidence.repositories.includes(repo)) {
      return {
        ok: false,
        reason: "scope_unverified",
        state: `credential does not cover ${repo}`,
        remedy: "extend the token's repository coverage and re-record the provisioning evidence",
      };
    }
    for (const [name, value] of Object.entries(evidence.permissions)) {
      const allowed = ALLOWED_PERMISSIONS[name];
      if (!allowed || !allowed.includes(value)) {
        return {
          ok: false,
          reason: "scope_unverified",
          state: `disallowed permission ${name}:${value}`,
          remedy: "reduce the token to pull-request write (plus read-only metadata; contents and issues none) and re-record the evidence",
        };
      }
    }
    if (evidence.permissions.pull_requests !== "write") {
      return {
        ok: false,
        reason: "scope_unverified",
        state: "credential lacks pull-request write",
        remedy: "grant the token pull-request write and re-record the provisioning evidence",
      };
    }
    return { ok: true, login: evidence.login };
  }

  /**
   * Build the Authorization header value for a GitHub request. It CONTAINS the
   * token: it exists for the plugin's own HTTP client (github.ts) and is called
   * nowhere else. No tool input reaches it, and nothing may log its result.
   */
  authorizationHeader(): string {
    if (!this.#token) throw new Error("credential not loaded");
    return `Bearer ${this.#token}`;
  }

  /** The sha256 binding of the loaded token, for evidence comparisons. */
  bindingSha256(): string | null {
    return this.#tokenSha256;
  }
}
