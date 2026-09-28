/**
 * clients.test.ts — the REAL clients behind their injection points (cli#427
 * round 2, item 4): HttpGitHubApi, FlairHttpAuditSink and FileAssignmentResolver.
 * Exact URLs, methods, headers and JSON bodies; the rejected/ambiguous
 * classification; the Ed25519 signature over the real auth payload; and the
 * assignment resolver's session binding (including duplicates).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAssignmentResolver } from "../src/assignment.js";
import { FlairHttpAuditSink } from "../src/flair-sink.js";
import { HttpGitHubApi } from "../src/github.js";
import type { OrgEventDraft } from "../src/types.js";
import { COMMIT, PR, REPO, scenario, TOKEN, validAssignment, writeEd25519Key } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-clients-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("HttpGitHubApi — exact request, classification and receipt", () => {
  const BASE = "https://api.example.test";

  test("fetchPull issues the exact GET and headers", async () => {
    const { custody } = scenario(root);
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ state: "open", head: { sha: COMMIT } }), { status: 200 }));
    const api = new HttpGitHubApi({ custody, baseUrl: BASE, fetchImpl: fn });
    const r = await api.fetchPull(REPO, 42);
    expect(r).toEqual({ ok: true, pull: { state: "open", head: COMMIT } });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${BASE}/repos/${REPO}/pulls/42`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe("GET");
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["User-Agent"]).toBe("openclaw-github-review");
  });

  test("createReview issues the exact POST URL and JSON body", async () => {
    const { custody } = scenario(root);
    const body = "  keep my whitespace  \n";
    const { fn, calls } = fakeFetch(() =>
      new Response(JSON.stringify({ id: 7, html_url: "https://example.test/r/7", commit_id: COMMIT, state: "COMMENTED" }), { status: 200 }),
    );
    const api = new HttpGitHubApi({ custody, baseUrl: BASE, fetchImpl: fn });
    const r = await api.createReview({ repo: REPO, pr: PR, commitId: COMMIT, event: "COMMENT", body });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.receipt).toEqual({ id: 7, url: "https://example.test/r/7", commitId: COMMIT, state: "COMMENTED" });
    expect(calls[0]!.url).toBe(`${BASE}/repos/${REPO}/pulls/${PR}/reviews`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // The body is serialized EXACTLY as given.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ commit_id: COMMIT, event: "COMMENT", body });
    expect(String(calls[0]!.init.body)).toBe(JSON.stringify({ commit_id: COMMIT, event: "COMMENT", body }));
  });

  test("a 4xx is a definitive rejection; a 5xx or a transport failure is ambiguous", async () => {
    const { custody } = scenario(root);
    for (const [status, kind] of [
      [422, "rejected"],
      [502, "ambiguous"],
    ] as const) {
      const { fn } = fakeFetch(() => new Response("nope", { status }));
      const api = new HttpGitHubApi({ custody, baseUrl: BASE, fetchImpl: fn });
      const r = await api.createReview({ repo: REPO, pr: PR, commitId: COMMIT, event: "APPROVE", body: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe(kind);
    }
    const { fn } = fakeFetch(() => {
      throw new Error("network down");
    });
    const api = new HttpGitHubApi({ custody, baseUrl: BASE, fetchImpl: fn });
    const r = await api.createReview({ repo: REPO, pr: PR, commitId: COMMIT, event: "APPROVE", body: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("ambiguous");
  });

  test("a non-open PR is reported as closed", async () => {
    const { custody } = scenario(root);
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ state: "closed", head: { sha: COMMIT } }), { status: 200 }));
    const api = new HttpGitHubApi({ custody, baseUrl: BASE, fetchImpl: fn });
    const r = await api.fetchPull(REPO, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pull.state).toBe("closed");
  });
});

describe("FlairHttpAuditSink — exact request and Ed25519 signature", () => {
  test("POSTs the OrgEvent and signs `${agentId}:${ts}:${nonce}:POST:/OrgEvent/`", async () => {
    const keyPath = join(root, "anvil.key");
    const publicKey = writeEd25519Key(keyPath);
    const { fn, calls } = fakeFetch(() => new Response("", { status: 200 }));
    const sink = new FlairHttpAuditSink("anvil", "https://flair.example.test/", keyPath, fn);
    const event: OrgEventDraft = {
      id: "evt-1",
      authorId: "anvil",
      kind: "pr_review_posted",
      scope: REPO,
      refId: String(PR),
      targetIds: [String(PR), COMMIT],
      summary: "APPROVE review posted",
      detail: "{}",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await sink.record(event);
    expect(calls[0]!.url).toBe("https://flair.example.test/OrgEvent/");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(event);

    const m = /^TPS-Ed25519 (\S+):(\d+):([^:]+):(.+)$/.exec(headers.Authorization!);
    expect(m).not.toBeNull();
    const [, agentId, ts, nonce, sigB64] = m!;
    expect(agentId).toBe("anvil");
    const payload = `${agentId}:${ts}:${nonce}:POST:/OrgEvent/`;
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(sigB64!, "base64"))).toBe(true);
    // The signature commits to method AND path: a shorter payload does not verify.
    const wrongPayload = `${agentId}:${ts}:${nonce}`;
    expect(verify(null, Buffer.from(wrongPayload), publicKey, Buffer.from(sigB64!, "base64"))).toBe(false);
  });

  test("a non-2xx audit write throws a status-only error", async () => {
    const keyPath = join(root, "anvil.key");
    writeEd25519Key(keyPath);
    const { fn } = fakeFetch(() => new Response("secret upstream body", { status: 503 }));
    const sink = new FlairHttpAuditSink("anvil", "https://flair.example.test", keyPath, fn);
    await expect(
      sink.record({ id: "e", authorId: "anvil", kind: "pr_review_posted", scope: REPO, refId: "1", targetIds: [], summary: "", detail: "{}", createdAt: "x" }),
    ).rejects.toThrow("status 503");
  });
});

describe("FileAssignmentResolver — session binding", () => {
  function writeAssignments(list: unknown[]): string {
    const p = join(root, "assignments.json");
    writeFileSync(p, JSON.stringify({ assignments: list }), { mode: 0o600 });
    return p;
  }

  test("returns the assignment bound to the session key", () => {
    const p = writeAssignments([{ ...validAssignment(), sessionKey: "sess-1" }]);
    const r = new FileAssignmentResolver(p);
    expect(r.resolve("sess-1")?.reviewer).toBe("anvil");
    expect(r.resolve("sess-2")).toBeNull();
  });

  test("a DUPLICATE session key refuses (no positional pick)", () => {
    const p = writeAssignments([
      { ...validAssignment(), sessionKey: "sess-1", pr: 1 },
      { ...validAssignment(), sessionKey: "sess-1", pr: 2 },
    ]);
    const r = new FileAssignmentResolver(p);
    expect(r.resolve("sess-1")).toBeNull();
  });

  test("a malformed entry and a missing file resolve to null", () => {
    const p = writeAssignments([{ sessionKey: "sess-1" }]);
    expect(new FileAssignmentResolver(p).resolve("sess-1")).toBeNull();
    expect(new FileAssignmentResolver(join(root, "missing.json")).resolve("sess-1")).toBeNull();
  });
});
