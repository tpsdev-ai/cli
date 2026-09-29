/**
 * github.ts — the narrow GitHub REST client owned by the handler.
 *
 * It builds every request internally from the validated {repo, pr, commit,
 * event, body}. There is no endpoint, method, header or body passthrough: the
 * caller cannot select a URL or add a header. The body is serialized exactly as
 * given (no rewriting or enrichment), so the host-side sha256 is taken over the
 * same UTF-8 body handed to the serializer.
 */

import type { CredentialCustody } from "./credential.js";
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "./request-timeout.js";
import type { ExistingReview, GitHubApi, GitHubReviewLister, PullSnapshot, ReviewEvent, ReviewReceipt } from "./types.js";

export interface GitHubApiOptions {
  custody: CredentialCustody;
  /** The GitHub API base. Host-configured; used by tests to point at a
   *  controlled API service. Never taken from tool input. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to REQUEST_TIMEOUT_MS (tests shorten it). */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.github.com";

/** The responses to "Create a review for a pull request" (POST
 *  /repos/{owner}/{repo}/pulls/{pull_number}/reviews) that PROVE no review was
 *  created, per GitHub's documented behaviour: 401 (bad credentials: the
 *  request is not authenticated), 403 (forbidden, documented for this
 *  endpoint), 404 (not found: no such repository or pull request for this
 *  credential) and 422 (validation failed, or the endpoint has been spammed,
 *  documented for this endpoint) — each a rejection before the review is
 *  created. They count only when GitHub itself produced them, i.e. the
 *  response carries GitHub's `X-GitHub-Request-Id` header; the same status
 *  from an intermediary proves nothing about GitHub.
 *
 *  EVERYTHING ELSE that is not a 2xx is AMBIGUOUS — the review may exist:
 *  408 and 429 (not documented for this endpoint, and commonly produced by an
 *  intermediary after the request was forwarded), any other 4xx, every 5xx and
 *  3xx, a transport failure, and a 2xx whose body cannot be read. */
export const NO_CREATE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 422]);
export const GITHUB_REQUEST_ID_HEADER = "x-github-request-id";
const REVIEWS_PER_PAGE = 100;
/** A PR with more reviews than this is not listed to the end: the listing is
 *  reported as incomplete, never as "no review exists". */
const MAX_REVIEW_PAGES = 30;

export class HttpGitHubApi implements GitHubApi, GitHubReviewLister {
  private readonly custody: CredentialCustody;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GitHubApiOptions) {
    this.custody = opts.custody;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.custody.authorizationHeader(),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openclaw-github-review",
    };
  }

  async fetchPull(
    repo: string,
    pr: number,
  ): Promise<{ ok: true; pull: PullSnapshot } | { ok: false; detail: string }> {
    const url = `${this.baseUrl}/repos/${repo}/pulls/${pr}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchImpl, url, { method: "GET", headers: this.headers() }, this.timeoutMs);
    } catch {
      // A transport failure or a timeout: the lookup failed, and nothing was posted.
      return { ok: false, detail: "lookup request failed" };
    }
    if (!res.ok) return { ok: false, detail: `lookup returned status ${res.status}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, detail: "lookup response was not JSON" };
    }
    const o = json as Record<string, unknown>;
    const head = (o.head as Record<string, unknown> | undefined)?.sha;
    const state = o.state;
    if (typeof head !== "string" || typeof state !== "string") {
      return { ok: false, detail: "lookup response was incomplete" };
    }
    return { ok: true, pull: { state: state === "open" ? "open" : "closed", head } };
  }

  /** List every review on a PR (read-only), for the host's reconciliation.
   *  Anything short of the complete list is a failure, never an empty list. */
  async listReviews(repo: string, pr: number): Promise<{ ok: true; reviews: ExistingReview[] } | { ok: false; detail: string }> {
    const reviews: ExistingReview[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const url = `${this.baseUrl}/repos/${repo}/pulls/${pr}/reviews?per_page=${REVIEWS_PER_PAGE}&page=${page}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(this.fetchImpl, url, { method: "GET", headers: this.headers() }, this.timeoutMs);
      } catch {
        return { ok: false, detail: "review listing request failed" };
      }
      if (!res.ok) return { ok: false, detail: `review listing returned status ${res.status}` };
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, detail: "review listing was not JSON" };
      }
      if (!Array.isArray(json)) return { ok: false, detail: "review listing was not a list" };
      for (const item of json) {
        const o = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
        if (!o || typeof o.id !== "number" || typeof o.state !== "string") {
          return { ok: false, detail: "review listing held an unrecognised entry" };
        }
        const user = typeof o.user === "object" && o.user !== null ? (o.user as Record<string, unknown>) : null;
        reviews.push({
          id: o.id,
          login: typeof user?.login === "string" ? user.login : null,
          commitId: typeof o.commit_id === "string" ? o.commit_id : null,
          state: o.state,
          url: typeof o.html_url === "string" ? o.html_url : null,
          submittedAt: typeof o.submitted_at === "string" ? o.submitted_at : null,
        });
      }
      if (json.length < REVIEWS_PER_PAGE) return { ok: true, reviews };
    }
    return { ok: false, detail: `review listing exceeded ${MAX_REVIEW_PAGES} pages` };
  }

  async createReview(input: {
    repo: string;
    pr: number;
    commitId: string;
    event: ReviewEvent;
    body: string;
  }): Promise<
    | { ok: true; receipt: ReviewReceipt }
    | { ok: false; kind: "rejected" | "ambiguous"; detail: string }
  > {
    const url = `${this.baseUrl}/repos/${input.repo}/pulls/${input.pr}/reviews`;
    // The body is serialized exactly as received — this exact value is also what
    // the host hashed. No normalization or host-data enrichment.
    const payload = JSON.stringify({
      commit_id: input.commitId,
      event: input.event,
      body: input.body,
    });
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetchImpl,
        url,
        { method: "POST", headers: { ...this.headers(), "Content-Type": "application/json" }, body: payload },
        this.timeoutMs,
      );
    } catch {
      // A transport failure or a TIMEOUT: the request may have reached GitHub
      // and created a review — AMBIGUOUS, never a rejection.
      return { ok: false, kind: "ambiguous", detail: "posting request failed with no definitive response" };
    }
    if (!res.ok) {
      // Only a documented no-create rejection produced by GitHub itself is
      // definitive; everything else may have created a review.
      const fromGitHub = res.headers.get(GITHUB_REQUEST_ID_HEADER) !== null;
      const kind = NO_CREATE_STATUSES.has(res.status) && fromGitHub ? "rejected" : "ambiguous";
      return { ok: false, kind, detail: `posting returned status ${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, kind: "ambiguous", detail: "posting response was not JSON" };
    }
    const o = json as Record<string, unknown>;
    const id = o.id;
    const htmlUrl = o.html_url;
    const commitId = o.commit_id;
    const state = o.state;
    if (typeof id !== "number" || typeof htmlUrl !== "string" || typeof commitId !== "string" || typeof state !== "string") {
      return { ok: false, kind: "ambiguous", detail: "posting receipt was incomplete" };
    }
    return { ok: true, receipt: { id, url: htmlUrl, commitId, state } };
  }
}
