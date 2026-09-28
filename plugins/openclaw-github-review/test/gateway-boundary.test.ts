/**
 * gateway-boundary.test.ts — the section-E gateway boundary lane (round 2) and
 * the A11 secret scans.
 *
 * The lane loads the BUILT plugin through OpenClaw's REAL registration machinery
 * (see openclaw-loader.ts) with a mode=all reviewer config, and proves the
 * handler executes in the GATEWAY process: a mode=all (sandboxed) session is NOT
 * refused and the handler runs its ordinary pipeline, and the host-only marker
 * CONTENTS are readable from the fixture registered through the same mechanism.
 *
 * The secret scans drive the plugin through registerGithubReview (not
 * registerWithDeps) with a real config and a real signing key, over the success,
 * refusal, rejected, ambiguous and audit-failure paths, using the marker's
 * CONTENTS and a signing-key canary.
 *
 * The container half (a real sandbox where the marker is NOT readable) is
 * deferred to section A / a later PR.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_PROBE_ENV,
  CI_PROBE_TOOL_NAME,
  HOST_MARKER_ENV,
  registerGithubReview,
  registerWithDeps,
  TOOL_NAME,
} from "../src/index.js";
import { FakeGitHub, makeDeps, resolver, scenario, session, TOKEN, validAssignment, validInput } from "./helpers.js";
import { openclawDistDir, registerBuiltPlugin, type CapturedTool } from "./openclaw-loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const MARKER = "HOST-ONLY-MARKER-7c21";

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

async function textOf(tool: { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }, params: unknown): Promise<string> {
  return (await tool.execute("call", params)).content[0]!.text;
}

/** The github_review tool's `execute` shape after a factory call. */
type Tool = CapturedTool["factory"] extends never ? never : { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> };

describe("E — the real registration/delivery path (gateway process)", () => {
  test("the BUILT plugin registers through OpenClaw's real machinery and a mode=all session is NOT refused", async () => {
    process.env[CI_PROBE_ENV] = "1";
    const markerPath = join(root, "host-only.marker");
    writeFileSync(markerPath, MARKER, { mode: 0o600 });
    process.env[HOST_MARKER_ENV] = markerPath;

    const s = scenario(root, { allowedRepositories: [] }); // refuse pre-request, no network
    const { tools, logs } = await registerBuiltPlugin({
      pluginDir,
      openclawDistDir: openclawDistDir(pluginDir),
      pluginConfig: {
        allowedRepositories: [],
        maxBodyBytes: 65_536,
        credentialFile: s.config.credentialFile,
        provisioningFile: s.config.provisioningFile,
        signingKeyFile: s.config.signingKeyFile,
        reviewerIdentity: s.config.reviewerIdentity,
        pendingAuditFile: s.config.pendingAuditFile,
        reconcileFile: s.config.reconcileFile,
      },
      registrationMode: "full",
    });

    // The one production verb and the CI probe both register through the real
    // mechanism; nothing else.
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([CI_PROBE_TOOL_NAME, TOOL_NAME].sort());

    // A mode=all (sandboxed) session is accepted: the handler runs its ordinary
    // pipeline and refuses at a NORMAL gate, never a sandbox gate.
    const review = tools.find((t) => t.name === TOOL_NAME)!.factory({
      sessionKey: "sess-1",
      agentId: "anvil",
      sandboxed: true,
    }) as Tool;
    const out = JSON.parse(await textOf(review, validInput())) as { status: string; reason?: string };
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("repo_not_configured");

    // The host-only marker's CONTENTS are readable from this gateway process,
    // through the fixture registered by the same mechanism.
    const probe = tools.find((t) => t.name === CI_PROBE_TOOL_NAME)!.factory({
      sessionKey: "sess-1",
      agentId: "anvil",
      sandboxed: true,
    }) as Tool;
    const probeOut = JSON.parse(await textOf(probe, {})) as { marker: string | null };
    expect(probeOut.marker).toBe(MARKER);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  test("a mode=all (sandboxed:true) session POSTS successfully", async () => {
    const { deps, github } = makeDeps(scenario(root));
    const tools: CapturedTool[] = [];
    const api = {
      registrationMode: "full",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: (t: unknown, o?: { name?: string }) =>
        tools.push({ name: o?.name ?? "?", factory: (typeof t === "function" ? t : () => t) as CapturedTool["factory"] }),
    };
    registerWithDeps(api as never, deps);
    const tool = tools.find((t) => t.name === TOOL_NAME)!.factory({
      sessionKey: "sess-1",
      agentId: "anvil",
      sandboxed: true,
    }) as Tool;
    const out = JSON.parse(await textOf(tool, validInput())) as { status: string };
    expect(out.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
  });
});

describe("A11 — full secret scans through registerGithubReview", () => {
  function mockApi(pluginConfig: unknown, tools: CapturedTool[], logs: string[]) {
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
        const factory = typeof tool === "function" ? (tool as CapturedTool["factory"]) : () => tool;
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
  }): Promise<{ haystack: string; result: string; logs: string[]; errors: string[] }> {
    const markerPath = join(root, "host-only.marker");
    writeFileSync(markerPath, MARKER, { mode: 0o600 });
    process.env[HOST_MARKER_ENV] = markerPath;

    const s = scenario(root);
    const github = new FakeGitHub();
    if (opts.reviewResult) github.reviewResult = opts.reviewResult;
    const flairRequests: unknown[] = [];
    const flairFetch = (async (url: string, init: RequestInit) => {
      flairRequests.push({ url, init });
      return new Response("", { status: opts.auditStatus ?? 200 });
    }) as unknown as typeof fetch;

    const tools: CapturedTool[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const api = mockApi(
      {
        allowedRepositories: ["tpsdev-ai/cli"],
        maxBodyBytes: 65_536,
        credentialFile: s.config.credentialFile,
        provisioningFile: s.config.provisioningFile,
        signingKeyFile: s.config.signingKeyFile,
        reviewerIdentity: "anvil",
        pendingAuditFile: s.config.pendingAuditFile,
        reconcileFile: s.config.reconcileFile,
      },
      tools,
      logs,
    );
    registerGithubReview(api as never, {
      assignments: resolver([validAssignment()]),
      github,
      flairFetch,
    });

    const review = tools.find((t) => t.name === TOOL_NAME)!.factory({
      sessionKey: "sess-1",
      agentId: "anvil",
      sandboxed: true,
    }) as Tool;

    let result = "";
    try {
      result = await textOf(review, opts.input ?? validInput());
    } catch (err) {
      errors.push(String((err as Error).message));
    }

    const keyCanary = readFileSync(s.config.signingKeyFile!, "utf8").trim();
    const haystack = [result, logs.join("\n"), errors.join("\n")].join("\n");
    return { haystack, result, logs, errors, keyCanary };
  }

  test("the scanner detects a controlled positive fixture", () => {
    const found = [TOKEN, MARKER].filter((c) => `x ${TOKEN} y`.includes(c));
    expect(found).toEqual([TOKEN]);
  });

  test("success path: no canary in result, logs or errors", async () => {
    const { haystack, result, keyCanary } = await runScenario({});
    expect(JSON.parse(result).status).toBe("posted");
    for (const c of [TOKEN, MARKER, keyCanary]) expect(haystack).not.toContain(c);
  });

  test("refusal path: no canary leaks", async () => {
    const { haystack, keyCanary } = await runScenario({ input: validInput({ repo: "not/configured" }) });
    for (const c of [TOKEN, MARKER, keyCanary]) expect(haystack).not.toContain(c);
  });

  test("rejected path: no canary leaks", async () => {
    const { haystack, result, keyCanary } = await runScenario({
      reviewResult: { ok: false, kind: "rejected", detail: "posting returned status 422" },
    });
    expect(JSON.parse(result).reason).toBe("github_rejected");
    for (const c of [TOKEN, MARKER, keyCanary]) expect(haystack).not.toContain(c);
  });

  test("ambiguous path: no canary leaks", async () => {
    const { haystack, result, keyCanary } = await runScenario({
      reviewResult: { ok: false, kind: "ambiguous", detail: "posting returned status 502" },
    });
    expect(JSON.parse(result).status).toBe("unknown");
    for (const c of [TOKEN, MARKER, keyCanary]) expect(haystack).not.toContain(c);
  });

  test("audit-failure path: no canary leaks", async () => {
    const { haystack, result, keyCanary } = await runScenario({ auditStatus: 500 });
    expect(JSON.parse(result).status).toBe("posted_audit_pending");
    for (const c of [TOKEN, MARKER, keyCanary]) expect(haystack).not.toContain(c);
  });
});
