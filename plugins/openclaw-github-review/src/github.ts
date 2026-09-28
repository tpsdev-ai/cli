/**
 * github.ts — the narrow GitHub REST client owned by the handler.
 *
 * It builds every request internally from the validated {repo, pr, commit,
 * event, body}. There is no endpoint, method, header or body passthrough: the
 * caller cannot select a URL or add a header. The body is serialized exactly as
 * given (no rewriting or enrichment), so the host-side sha256 commits to the
 * bytes actually transmitted.
 */

import type { CredentialCustody } from "./credential.js";
import type { GitHubApi, PullSnapshot, ReviewEvent, ReviewReceipt } from "./types.js";

export interface GitHubApiOptions {
  custody: CredentialCustody;
  /** The GitHub API base. Host-configured; used by tests to point at a
   *  controlled API service. Never taken from tool input. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.github.com";

export class HttpGitHubApi implements GitHubApi {
  private readonly custody: CredentialCustody;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubApiOptions) {
    this.custody = opts.custody;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
      res = await this.fetchImpl(url, { method: "GET", headers: this.headers() });
    } catch {
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
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: payload,
      });
    } catch {
      return { ok: false, kind: "ambiguous", detail: "posting request failed with no definitive response" };
    }
    if (!res.ok) {
      // A definitive rejection is 4xx (the request was understood and refused);
      // anything else (5xx, gateway errors) may or may not have created a review.
      const kind = res.status >= 400 && res.status < 500 ? "rejected" : "ambiguous";
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
