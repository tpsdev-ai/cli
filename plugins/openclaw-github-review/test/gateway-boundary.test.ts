/**
 * gateway-boundary.test.ts — the section-E gateway-boundary lane and the A11
 * secret scans.
 *
 * THE LANE runs the BUILT plugin inside a separate node process (gateway-driver.mjs)
 * against the pinned openclaw release, with the controlled GitHub and Flair
 * services installed as globalThis.fetch BEFORE registration:
 *
 * - registration goes through OpenClaw's own loader: the record — contracts
 *   included — is read from the SHIPPED openclaw.plugin.json, the config is
 *   validated against its schema, and the registry must report ZERO
 *   diagnostics and exactly the one declared tool;
 * - the shipped manifest REJECTS the CI probe (the undeclared-contract
 *   diagnostic); the probe registers only from a manifest overlay the lane
 *   creates in its temp root;
 * - the reviewer's session is configured sandbox mode=all; OpenClaw's gateway
 *   tool resolution does NOT offer github_review under its default sandbox tool
 *   policy and DOES under the documented `alsoAllow`;
 * - the tool is dispatched through the gateway's tools.invoke path and posts
 *   through the plugin's real HttpGitHubApi and FlairHttpAuditSink all the way
 *   to `posted` with the audit acknowledged; a second call is `already_posted`
 *   and a concurrent pair posts once. OpenClaw 2026.8.1 may execute the tool
 *   from a "tool-discovery" registration it loads on demand (it does in the
 *   overlay run); that registration must reuse the full one's host state;
 * - the probe, dispatched the same way, reports the gateway process identity,
 *   reads the host-only marker and sees the sandboxed context OpenClaw built;
 *   every controlled-service request came from that same process.
 *
 * The lane drives no sandbox container and not the embedded agent runner: the
 * container half of the host/container contrast (the sandbox must NOT read the
 * marker) is deferred to section A / a later PR.
 *
 * THE SCANS check every lane run (results, gateway logs, diagnostics, process
 * output, launch data, and what reached Flair) for the token, the signing key,
 * the marker contents and the credential and key paths, and also drive
 * registerGithubReview in-process over the success, refusal, rejected,
 * ambiguous and audit-failure paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { verify, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CI_PROBE_ENV, CI_PROBE_TOOL_NAME, HOST_MARKER_ENV, registerGithubReview, TOOL_NAME } from "../src/index.js";
import {
  COMMIT,
  fakeCredentialFiles,
  FakeGitHub,
  FUTURE,
  PR,
  REPO,
  resolver,
  scenario,
  TOKEN,
  validAssignment,
  validInput,
  writeEd25519Key,
} from "./helpers.js";
import {
  createProbeOverlay,
  PLUGIN_DIR,
  PLUGIN_ID,
  pinnedOpenclawVersion,
  runGatewayLane,
  type InvokeResult,
  type LaneRun,
  type LaneSpec,
} from "./gateway-lane.js";

const MARKER = "HOST-ONLY-MARKER-7c21";
const REVIEWER = "anvil";
const SESSION = "agent:anvil:review-427";
const FLAIR = "http://flair.lane.invalid";
const GITHUB = `https://api.github.com/repos/${REPO}/pulls/${PR}`;
const FLAIR_EVENT = new URL(`${FLAIR}/OrgEvent/`);
const GITHUB_PULL = new URL(GITHUB);
const GITHUB_REVIEW = new URL(`${GITHUB}/reviews`);

function sameEndpoint(actual: URL, expected: URL): boolean {
  return actual.protocol === expected.protocol &&
    actual.host === expected.host &&
    actual.pathname === expected.pathname;
}

let root: string;
let savedProbe: string | undefined;
let savedMarker: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-boundary-"));
  savedProbe = process.env[CI_PROBE_ENV];
  savedMarker = process.env[HOST_MARKER_ENV];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedProbe === undefined) delete process.env[CI_PROBE_ENV];
  else process.env[CI_PROBE_ENV] = savedProbe;
  if (savedMarker === undefined) delete process.env[HOST_MARKER_ENV];
  else process.env[HOST_MARKER_ENV] = savedMarker;
});

interface LaneHost {
  pluginConfig: Record<string, unknown>;
  credentialFile: string;
  signingKeyFile: string;
  keyCanary: string;
  publicKey: KeyObject;
  markerPath: string;
  reconcileFile: string;
  pendingAuditFile: string;
}

/** A fully valid reviewer host: fake fine-grained token + bound provisioning
 *  evidence, a real Ed25519 signing key, one trusted dispatch assignment for
 *  the reviewer session, both durable stores, and a host-only marker. */
function laneHost(dir: string, dispatchId: string): LaneHost {
  const { credentialFile, provisioningFile } = fakeCredentialFiles(dir);
  const signingKeyFile = join(dir, "anvil.key");
  const publicKey = writeEd25519Key(signingKeyFile);
  const assignmentsFile = join(dir, "assignments.json");
  writeFileSync(
    assignmentsFile,
    JSON.stringify({ assignments: [validAssignment({ sessionKey: SESSION, dispatchId, expiresAt: FUTURE })] }),
    { mode: 0o600 },
  );
  const markerPath = join(dir, "host-only.marker");
  writeFileSync(markerPath, MARKER, { mode: 0o600 });
  const reconcileFile = join(dir, "reconcile.json");
  const pendingAuditFile = join(dir, "pending.json");
  return {
    pluginConfig: {
      allowedRepositories: [REPO],
      maxBodyBytes: 65_536,
      credentialFile,
      provisioningFile: provisioningFile!,
      assignmentsFile,
      signingKeyFile,
      reviewerIdentity: REVIEWER,
      pendingAuditFile,
      reconcileFile,
      flairUrl: FLAIR,
    },
    credentialFile,
    signingKeyFile,
    keyCanary: readFileSync(signingKeyFile, "utf8").trim(),
    publicKey,
    markerPath,
    reconcileFile,
    pendingAuditFile,
  };
}

function spec(host: LaneHost, pluginDir: string, sandboxAllow: string[], invocations: LaneSpec["invocations"]): LaneSpec {
  return {
    pluginDir,
    reviewer: REVIEWER,
    sessionKey: SESSION,
    pluginConfig: host.pluginConfig,
    sandboxAllow,
    github: { repo: REPO, pr: PR, head: COMMIT, reviewId: 4242 },
    flairUrl: FLAIR,
    invocations,
  };
}

const call = (cfg: "default" | "allowed", name: string, args: Record<string, unknown> = {}) => ({ cfg, name, args });

function toolOut(r: InvokeResult | InvokeResult[] | undefined): Record<string, unknown> {
  const one = r as InvokeResult;
  expect(one.status).toBe(200);
  return JSON.parse(one.text!) as Record<string, unknown>;
}

/** A11 on a lane run: nothing the gateway process emitted or was launched with
 *  carries a secret, the marker contents or a credential location; Flair saw
 *  neither the token nor the key; the token went ONLY to GitHub. */
function scanLaneRun(run: LaneRun, host: LaneHost): void {
  // The probe's own result is the one place the marker contents belong.
  const { probe, ...otherInvocations } = run.report.invocations;
  const emitted = [run.stdout, run.stderr, JSON.stringify({ ...run.report, invocations: otherInvocations })].join("\n");
  const secrets = [TOKEN, host.keyCanary, host.credentialFile, host.signingKeyFile];
  for (const canary of [...secrets, MARKER]) expect(emitted).not.toContain(canary);
  if (probe) for (const canary of secrets) expect(JSON.stringify(probe)).not.toContain(canary);
  const launch = [...run.argv, ...Object.entries(run.env).map(([k, v]) => `${k}=${v}`)].join("\n");
  for (const canary of [TOKEN, host.keyCanary, MARKER]) expect(launch).not.toContain(canary);
  for (const r of run.requests) {
    const requestUrl = new URL(r.url);
    if (sameEndpoint(requestUrl, FLAIR_EVENT)) {
      expect(`${r.authorization}\n${r.body}`).not.toContain(TOKEN);
      expect(`${r.authorization}\n${r.body}`).not.toContain(host.keyCanary);
    } else {
      expect(sameEndpoint(requestUrl, GITHUB_PULL) || sameEndpoint(requestUrl, GITHUB_REVIEW)).toBe(true);
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.body ?? "").not.toContain(host.keyCanary);
    }
  }
}

describe("E — the gateway-boundary lane (OpenClaw loader + gateway tool dispatch, in a separate node process)", () => {
  test("controlled request classification rejects lookalike hosts and paths", () => {
    expect(sameEndpoint(new URL(`${FLAIR}/OrgEvent/`), FLAIR_EVENT)).toBe(true);
    expect(sameEndpoint(new URL("http://flair.lane.invalid.evil.test/OrgEvent/"), FLAIR_EVENT)).toBe(false);
    expect(sameEndpoint(new URL("https://flair.lane.invalid/OrgEvent/"), FLAIR_EVENT)).toBe(false);
    expect(sameEndpoint(new URL(`${FLAIR}/OrgEvent/other`), FLAIR_EVENT)).toBe(false);
    expect(sameEndpoint(new URL("https://api.github.com.evil.test/repos/tpsdev-ai/cli/pulls/427"), GITHUB_PULL)).toBe(false);
  });

  test("the SHIPPED manifest: zero diagnostics, default sandbox policy withholds the verb, the documented allow offers it, and it POSTS with the audit acknowledged", () => {
    const host = laneHost(root, "lane-dispatch-1");
    const run = runGatewayLane(
      root,
      spec(host, PLUGIN_DIR, [TOOL_NAME], [
        { label: "default-policy", ...call("default", TOOL_NAME, validInput()) },
        { label: "post", ...call("allowed", TOOL_NAME, validInput()) },
        { label: "again", ...call("allowed", TOOL_NAME, validInput({ event: "COMMENT" })) },
      ]),
    );
    const { report, requests } = run;

    // The pinned release, in a gateway process that is not this test process.
    expect(report.openclawVersion).toBe(pinnedOpenclawVersion());
    expect(report.pid).not.toBe(process.pid);

    // Registration through OpenClaw's loader, record read from the shipped manifest.
    const shipped = JSON.parse(readFileSync(join(PLUGIN_DIR, "openclaw.plugin.json"), "utf8")) as { contracts: { tools: string[] } };
    expect(report.diagnostics).toEqual([]);
    expect(report.plugin).toMatchObject({ id: PLUGIN_ID, status: "loaded" });
    expect(report.plugin!.contracts?.tools).toEqual(shipped.contracts.tools);
    expect(report.registryTools).toEqual([{ pluginId: PLUGIN_ID, names: [TOOL_NAME] }]);

    // The reviewer's sandbox (mode=all) tool policy decides whether it is offered.
    expect(report.offered.default).not.toContain(TOOL_NAME);
    expect(report.offered.allowed).toContain(TOOL_NAME);
    expect(report.executionMode).toBe("sequential");
    expect(report.invocations["default-policy"]).toMatchObject({ status: 404, errorType: "not_found" });

    // Posted through the real clients, audit acknowledged, then latched.
    const posted = toolOut(report.invocations.post);
    expect(posted).toMatchObject({ status: "posted", review_id: 4242, commit_id: COMMIT, github_login: "anvil-reviewer" });
    expect(toolOut(report.invocations.again)).toMatchObject({ status: "refused", reason: "already_posted" });

    const reviewPosts = requests.filter((r) => r.method === "POST" && r.url === `${GITHUB}/reviews`);
    const flairPosts = requests.filter((r) => r.method === "POST" && r.url === `${FLAIR}/OrgEvent/`);
    expect(requests.filter((r) => r.method === "GET").map((r) => r.url)).toEqual([GITHUB]);
    expect(reviewPosts.length).toBe(1);
    expect(JSON.parse(reviewPosts[0]!.body!)).toEqual({ commit_id: COMMIT, event: "APPROVE", body: "looks good" });
    expect(flairPosts.length).toBe(1);
    const event = JSON.parse(flairPosts[0]!.body!) as { id: string; authorId: string; kind: string };
    expect(event).toMatchObject({ id: posted.audit_event_id, authorId: REVIEWER, kind: "pr_review_posted" });
    const m = /^TPS-Ed25519 (\S+):(\d+):([^:]+):(.+)$/.exec(flairPosts[0]!.authorization!);
    expect(m).not.toBeNull();
    expect(verify(null, Buffer.from(`${m![1]}:${m![2]}:${m![3]}:POST:/OrgEvent/`), host.publicKey, Buffer.from(m![4]!, "base64"))).toBe(true);
    for (const r of requests) expect(r.pid).toBe(report.pid);
    expect(report.unexpected).toEqual([]);
    // OpenClaw may execute the verb from a registration it loads on demand in
    // another mode; every such registration reused the full one's host state.
    expect(run.stdout).not.toContain("has no host state");

    expect(JSON.parse(readFileSync(host.reconcileFile, "utf8"))).toEqual({
      latches: [
        {
          dispatchId: "lane-dispatch-1",
          latch: "posted",
          repo: REPO,
          pr: PR,
          commit: COMMIT,
          login: "anvil-reviewer",
          reservedAt: expect.any(String),
          reviewId: 4242,
        },
      ],
    });
    expect(existsSync(host.pendingAuditFile)).toBe(false);

    scanLaneRun(run, host);
  });

  test("the SHIPPED manifest REJECTS the CI probe even with the CI flag set", () => {
    const host = laneHost(root, "lane-dispatch-2");
    const { report } = runGatewayLane(root, spec(host, PLUGIN_DIR, [TOOL_NAME], []), {
      [CI_PROBE_ENV]: "1",
      [HOST_MARKER_ENV]: host.markerPath,
    });
    expect(report.diagnostics).toEqual([
      { level: "error", pluginId: PLUGIN_ID, message: `plugin must declare contracts.tools for: ${CI_PROBE_TOOL_NAME}` },
    ]);
    expect(report.registryTools).toEqual([{ pluginId: PLUGIN_ID, names: [TOOL_NAME] }]);
  });

  test("from the lane's manifest OVERLAY: the probe runs in the gateway process, reads the host-only marker, sees a sandboxed session; a concurrent pair posts ONCE", () => {
    const host = laneHost(root, "lane-dispatch-3");
    const overlay = createProbeOverlay(root, CI_PROBE_TOOL_NAME);
    const run = runGatewayLane(
      root,
      spec(host, overlay, [TOOL_NAME, CI_PROBE_TOOL_NAME], [
        { label: "probe", ...call("allowed", CI_PROBE_TOOL_NAME) },
        { label: "pair", parallel: [call("allowed", TOOL_NAME, validInput()), call("allowed", TOOL_NAME, validInput())] },
      ]),
      { [CI_PROBE_ENV]: "1", [HOST_MARKER_ENV]: host.markerPath },
    );
    const { report, requests } = run;
    expect(report.diagnostics).toEqual([]);
    expect(report.registryTools.flatMap((t) => t.names).sort()).toEqual([CI_PROBE_TOOL_NAME, TOOL_NAME].sort());

    const probe = toolOut(report.invocations.probe) as {
      hostname: string;
      pid: number;
      marker: string | null;
      context: { sessionKey: string | null; agentId: string | null; sandboxed: boolean | null };
    };
    expect(probe.pid).toBe(report.pid);
    expect(probe.pid).not.toBe(process.pid);
    expect(probe.hostname).toBe(hostname());
    expect(probe.marker).toBe(MARKER);
    expect(probe.context).toEqual({ sessionKey: SESSION, agentId: REVIEWER, sandboxed: true });

    const pair = (report.invocations.pair as InvokeResult[]).map((r) => toolOut(r));
    expect(pair.map((o) => (o.status === "posted" ? "posted" : o.reason)).sort()).toEqual(["dispatch_in_flight", "posted"]);
    expect(requests.filter((r) => r.method === "POST" && r.url === `${GITHUB}/reviews`).length).toBe(1);
    for (const r of requests) expect(r.pid).toBe(probe.pid);
    expect(report.unexpected).toEqual([]);
    expect(run.stdout).not.toContain("has no host state");

    scanLaneRun(run, host);
  });
});

describe("A11 — secret scans through registerGithubReview, every outcome path (in-process)", () => {
  interface Captured {
    name: string;
    factory: (ctx: Record<string, unknown>) => unknown;
  }
  type Tool = { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> };

  function mockApi(pluginConfig: unknown, tools: Captured[], logs: string[]) {
    return {
      pluginConfig,
      registrationMode: "full",
      version: "0.1.0-test",
      logger: {
        info: (...a: unknown[]) => logs.push(a.join(" ")),
        warn: (...a: unknown[]) => logs.push(a.join(" ")),
        error: (...a: unknown[]) => logs.push(a.join(" ")),
      },
      registerTool: (tool: unknown, opts?: { name?: string }) => {
        const factory = typeof tool === "function" ? (tool as Captured["factory"]) : () => tool;
        tools.push({ name: opts?.name ?? "(unnamed)", factory });
      },
      registerChannel: () => {},
    };
  }

  /** Run one scenario through registerGithubReview and return everything a leak
   *  could surface in. */
  async function runScenario(opts: {
    reviewResult?: FakeGitHub["reviewResult"];
    auditStatus?: number;
    input?: unknown;
  }): Promise<{ haystack: string; result: string; keyCanary: string; paths: string[] }> {
    const markerPath = join(root, "host-only.marker");
    writeFileSync(markerPath, MARKER, { mode: 0o600 });
    process.env[HOST_MARKER_ENV] = markerPath;

    const s = scenario(root);
    const github = new FakeGitHub();
    if (opts.reviewResult) github.reviewResult = opts.reviewResult;
    const flairFetch = (async () => new Response("", { status: opts.auditStatus ?? 200 })) as unknown as typeof fetch;

    const tools: Captured[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const api = mockApi(
      {
        allowedRepositories: [REPO],
        maxBodyBytes: 65_536,
        credentialFile: s.config.credentialFile,
        provisioningFile: s.config.provisioningFile,
        signingKeyFile: s.config.signingKeyFile,
        reviewerIdentity: REVIEWER,
        pendingAuditFile: s.config.pendingAuditFile,
        reconcileFile: s.config.reconcileFile,
      },
      tools,
      logs,
    );
    registerGithubReview(api as never, { assignments: resolver([validAssignment()]), github, flairFetch });

    const review = tools.find((t) => t.name === TOOL_NAME)!.factory({ sessionKey: "sess-1", agentId: REVIEWER, sandboxed: true }) as Tool;
    let result = "";
    try {
      result = (await review.execute("call", opts.input ?? validInput())).content[0]!.text;
    } catch (err) {
      errors.push(String((err as Error).message));
    }
    const keyCanary = readFileSync(s.config.signingKeyFile!, "utf8").trim();
    const haystack = [result, logs.join("\n"), errors.join("\n")].join("\n");
    return { haystack, result, keyCanary, paths: [s.config.credentialFile!, s.config.signingKeyFile!] };
  }

  test("the scanner detects a controlled positive fixture", () => {
    const found = [TOKEN, MARKER].filter((c) => `x ${TOKEN} y`.includes(c));
    expect(found).toEqual([TOKEN]);
  });

  const cases: Array<[string, Parameters<typeof runScenario>[0], (out: Record<string, unknown>) => void]> = [
    ["success", {}, (o) => expect(o.status).toBe("posted")],
    ["refusal", { input: validInput({ repo: "not/configured" }) }, (o) => expect(o.reason).toBe("repo_not_configured")],
    [
      "rejected",
      { reviewResult: { ok: false, kind: "rejected", detail: "posting returned status 422" } },
      (o) => expect(o.reason).toBe("github_rejected"),
    ],
    [
      "ambiguous",
      { reviewResult: { ok: false, kind: "ambiguous", detail: "posting returned status 502" } },
      (o) => expect(o.status).toBe("unknown"),
    ],
    ["audit-failure", { auditStatus: 500 }, (o) => expect(o.status).toBe("posted_audit_pending")],
  ];
  for (const [name, opts, check] of cases) {
    test(`${name} path: no canary or credential location in result, logs or errors`, async () => {
      const { haystack, result, keyCanary, paths } = await runScenario(opts);
      check(JSON.parse(result) as Record<string, unknown>);
      for (const c of [TOKEN, MARKER, keyCanary, ...paths]) expect(haystack).not.toContain(c);
    });
  }
});
