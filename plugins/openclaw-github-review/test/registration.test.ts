/**
 * registration.test.ts — A1: independent plugin loading.
 *
 * The plugin registers exactly ONE production verb through `api.registerTool`,
 * with the mail plugin absent; it requires no mail code and exposes no
 * passthrough. The verb is offered only to the configured reviewer agent (and
 * to no one when none is configured), and host-side work — reading the
 * credential and the signing key, and the audit retry — happens only on a full
 * registration: every other registration mode reads neither secret, never
 * throws, and retries nothing. The built entry loads under node.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOrgEvent, FilePendingAuditStore } from "../src/audit.js";
import pluginModule, { registerGithubReview } from "../src/index.js";
import { FakeGitHub, GatedGitHub, resolver, scenario, validAssignment, validInput } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");

interface Registered {
  name: string;
  factory: (ctx: Record<string, unknown>) => unknown;
}

function makeApi(pluginConfig: unknown = {}, registrationMode = "full") {
  const tools: Registered[] = [];
  const channels: unknown[] = [];
  const logs: string[] = [];
  const api = {
    pluginConfig,
    registrationMode,
    version: "0.1.0-test",
    logger: {
      info: (...a: unknown[]) => logs.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.push(a.join(" ")),
      error: (...a: unknown[]) => logs.push(a.join(" ")),
    },
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      const factory = typeof tool === "function" ? (tool as Registered["factory"]) : () => tool;
      tools.push({ name: opts?.name ?? "(unnamed)", factory });
    },
    registerChannel: (c: unknown) => channels.push(c),
  };
  return { api, tools, channels, logs };
}

let savedProbe: string | undefined;
let root: string;
beforeEach(() => {
  savedProbe = process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  delete process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  root = mkdtempSync(join(tmpdir(), "gr-reg-"));
});
afterEach(() => {
  if (savedProbe === undefined) delete process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  else process.env.TPS_GITHUB_REVIEW_CI_PROBE = savedProbe;
  rmSync(root, { recursive: true, force: true });
});

describe("A1 — independent plugin loading", () => {
  test("registers exactly one production verb, github_review", () => {
    const { api, tools, channels } = makeApi();
    (pluginModule as { register: (a: unknown) => void }).register(api);
    expect(tools.map((t) => t.name)).toEqual(["github_review"]);
    expect(channels.length).toBe(0);
  });

  test("the registered tool carries only the five documented fields and runs sequentially", () => {
    const { api, tools } = makeApi({ reviewerIdentity: "anvil" });
    (pluginModule as { register: (a: unknown) => void }).register(api);
    const tool = tools[0]!.factory({ sessionKey: "s", agentId: "anvil", sandboxed: true }) as {
      name: string;
      parameters: { properties: Record<string, unknown>; additionalProperties?: boolean };
    };
    expect(tool.name).toBe("github_review");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["body", "commit_id", "event", "pr", "repo"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect((tool as { executionMode?: string }).executionMode).toBe("sequential");
  });

  test("the verb is offered ONLY to the configured reviewer agent", () => {
    const { api, tools } = makeApi({ reviewerIdentity: "anvil" });
    (pluginModule as { register: (a: unknown) => void }).register(api);
    const factory = tools[0]!.factory;
    expect(factory({ sessionKey: "s", agentId: "anvil", sandboxed: true })).not.toBeNull();
    expect(factory({ sessionKey: "s", agentId: "someone-else", sandboxed: true })).toBeNull();
  });

  test("with NO reviewer identity configured the verb is offered to no agent", () => {
    const { api, tools } = makeApi({});
    (pluginModule as { register: (a: unknown) => void }).register(api);
    const factory = tools[0]!.factory;
    for (const agentId of ["anvil", "random-agent", undefined]) {
      expect(factory({ sessionKey: "s", agentId, sandboxed: true })).toBeNull();
    }
  });

  test("no CI probe is registered in production", () => {
    const { api, tools } = makeApi();
    (pluginModule as { register: (a: unknown) => void }).register(api);
    expect(tools.some((t) => t.name === "github_review_ci_probe")).toBe(false);
  });

  test("the CI probe registers ONLY under the CI flag", () => {
    process.env.TPS_GITHUB_REVIEW_CI_PROBE = "1";
    const { api, tools } = makeApi();
    (pluginModule as { register: (a: unknown) => void }).register(api);
    expect(tools.map((t) => t.name).sort()).toEqual(["github_review", "github_review_ci_probe"]);
  });


  test("the plugin depends on no mail code", () => {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    expect(Object.keys(deps).some((d) => d.includes("tps-mail"))).toBe(false);
    expect(Object.keys(deps).some((d) => d === "@tpsdev-ai/cli")).toBe(false);
    const entry = join(pluginRoot, "dist", "src", "index.js");
    if (existsSync(entry)) expect(readFileSync(entry, "utf8").includes("tps-mail")).toBe(false);
  });

  test("the built entry loads under node", () => {
    const entry = join(pluginRoot, "dist", "src", "index.js");
    expect(existsSync(entry)).toBe(true);
    const script = `import(${JSON.stringify(entry)}).then(()=>console.log("LOADED")).catch(e=>{console.error(e.code||e.message);process.exit(2)})`;
    const res = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(`${res.stdout ?? ""}\n${res.stderr ?? ""}`).toContain("LOADED");
    expect(res.status).toBe(0);
  });

  test("the manifest declares exactly this one tool and activates on startup", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "openclaw.plugin.json"), "utf8")) as {
      contracts?: { tools?: string[] };
      activation?: { onStartup?: boolean };
    };
    expect(manifest.contracts?.tools).toEqual(["github_review"]);
    expect(manifest.activation?.onStartup).toBe(true);
  });
});

describe("B3 — only a full registration does host-side work", () => {
  /** A FULLY VALID host configuration on disk (credential, provisioning
   *  evidence, signing key, both stores), with one retained audit record so an
   *  audit retry would have something to send. */
  function validHost() {
    const s = scenario(root);
    const receipt = { id: 1, url: "https://example.test/r/1", commitId: "a".repeat(40), state: "APPROVED" };
    new FilePendingAuditStore(s.config.pendingAuditFile!).save(
      buildOrgEvent({
        id: "retained-1",
        reviewer: "anvil",
        repo: "tpsdev-ai/cli",
        pr: 425,
        commitId: receipt.commitId,
        event: "APPROVE",
        bodySha256: "0".repeat(64),
        receipt,
        sessionCorrelationId: "dispatch-0",
        runtime: { bunVersion: null, nodeVersion: null, sandboxImageDigest: null, pluginVersion: "0.1.0-test" },
        login: "anvil-reviewer",
        createdAt: new Date().toISOString(),
      }),
    );
    const pluginConfig = {
      allowedRepositories: ["tpsdev-ai/cli"],
      maxBodyBytes: 65_536,
      credentialFile: s.config.credentialFile,
      provisioningFile: s.config.provisioningFile,
      signingKeyFile: s.config.signingKeyFile,
      reviewerIdentity: "anvil",
      pendingAuditFile: s.config.pendingAuditFile,
      reconcileFile: s.config.reconcileFile,
      flairUrl: "http://flair.test.invalid",
    };
    return { s, pluginConfig };
  }

  /** Register in `mode` with every file read and every Flair request recorded. */
  async function registerObserved(mode: string, pluginConfig: unknown, github: FakeGitHub = new FakeGitHub()) {
    const { api, tools, logs } = makeApi(pluginConfig, mode);
    const flairCalls: string[] = [];
    const flairFetch = (async (url: unknown) => {
      flairCalls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const readSpy = spyOn(fs, "readFileSync");
    let threw: unknown = null;
    try {
      registerGithubReview(api as never, { assignments: resolver([validAssignment()]), github, flairFetch });
      // Let a (would-be) background audit retry run to completion.
      await new Promise((r) => setTimeout(r, 25));
    } catch (err) {
      threw = err;
    }
    // Capture the calls BEFORE restoring: mockRestore() clears them.
    const reads = readSpy.mock.calls.map((c) => String(c[0]));
    readSpy.mockRestore();
    return { tools, logs, flairCalls, github, reads, threw };
  }

  for (const mode of ["discovery", "tool-discovery", "cli-metadata", "setup-runtime", "setup-only"]) {
    test(`${mode}: no credential, evidence, key or pending-audit read; no throw; no retry; the verb refuses credential_unavailable`, async () => {
      const { s, pluginConfig } = validHost();
      const { tools, logs, flairCalls, github, reads, threw } = await registerObserved(mode, pluginConfig);
      expect(threw).toBeNull();
      for (const secretOrStore of [s.config.credentialFile, s.config.provisioningFile, s.config.signingKeyFile, s.config.pendingAuditFile]) {
        expect(reads).not.toContain(secretOrStore!);
      }
      expect(flairCalls).toEqual([]);
      expect(logs.some((l) => l.includes("credential") || l.includes("signing key"))).toBe(false);
      const tool = tools[0]!.factory({ sessionKey: "sess-1", agentId: "anvil", sandboxed: true }) as {
        execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
      };
      const out = JSON.parse((await tool.execute("c", validInput())).content[0]!.text) as { reason?: string };
      expect(out.reason).toBe("credential_unavailable");
      expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
    });
  }

  test("full (control): the credential, evidence and key ARE read, the retained audit IS retried, and the verb posts", async () => {
    const { s, pluginConfig } = validHost();
    const { tools, flairCalls, github, reads, threw } = await registerObserved("full", pluginConfig);
    expect(threw).toBeNull();
    for (const f of [s.config.credentialFile, s.config.provisioningFile, s.config.signingKeyFile, s.config.pendingAuditFile]) {
      expect(reads).toContain(f!);
    }
    expect(flairCalls).toEqual(["http://flair.test.invalid/OrgEvent/"]);
    const tool = tools[0]!.factory({ sessionKey: "sess-1", agentId: "anvil", sandboxed: true }) as {
      execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const out = JSON.parse((await tool.execute("c", validInput())).content[0]!.text) as { status: string };
    expect(out.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
  });

  type Tool = { execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> };
  const toolOf = (tools: Registered[]) => tools[0]!.factory({ sessionKey: "sess-1", agentId: "anvil", sandboxed: true }) as Tool;
  const outOf = async (p: ReturnType<Tool["execute"]>) => JSON.parse((await p).content[0]!.text) as { status: string; reason?: string };

  test("a non-full registration of the SAME configuration in this process reuses the full one's host state: it reads no secret, posts, and shares the one-verdict ledger", async () => {
    const { s, pluginConfig } = validHost();
    const fullGithub = new GatedGitHub();
    const full = await registerObserved("full", pluginConfig, fullGithub);
    const discovery = await registerObserved("tool-discovery", pluginConfig);
    for (const secret of [s.config.credentialFile, s.config.provisioningFile, s.config.signingKeyFile, s.config.pendingAuditFile]) {
      expect(discovery.reads).not.toContain(secret!);
    }
    expect(discovery.flairCalls).toEqual([]);
    expect(discovery.logs.some((l) => l.includes("uses the host state"))).toBe(true);

    // In flight through the full registration: the other registration's call is refused.
    const inFlight = toolOf(full.tools).execute("c1", validInput());
    expect(await outOf(toolOf(discovery.tools).execute("c2", validInput()))).toMatchObject({ reason: "dispatch_in_flight" });
    fullGithub.open();
    expect((await outOf(inFlight)).status).toBe("posted");
    // …and once posted, neither registration posts again.
    expect(await outOf(toolOf(discovery.tools).execute("c3", validInput()))).toMatchObject({ reason: "already_posted" });
    expect(fullGithub.reviewCalls.length + discovery.github.reviewCalls.length).toBe(1);
  });

  test("a non-full registration of a DIFFERENT configuration does not reuse the full one's host state", async () => {
    const { pluginConfig } = validHost();
    await registerObserved("full", pluginConfig);
    const other = await registerObserved("tool-discovery", { ...pluginConfig, maxBodyBytes: 1024 });
    expect(other.logs.some((l) => l.includes("has no host state"))).toBe(true);
    expect(await outOf(toolOf(other.tools).execute("c", validInput()))).toMatchObject({ reason: "credential_unavailable" });
    expect(other.github.fetchPullCalls.length + other.github.reviewCalls.length).toBe(0);
  });

  test("an unparsable signing key never makes a non-full registration throw, and a full one disables posting with a path-free warning", async () => {
    const { s, pluginConfig } = validHost();
    writeFileSync(s.config.signingKeyFile!, "not a key", { mode: 0o600 });
    for (const mode of ["discovery", "tool-discovery", "cli-metadata", "setup-runtime"]) {
      expect((await registerObserved(mode, pluginConfig)).threw).toBeNull();
    }
    const full = await registerObserved("full", pluginConfig);
    expect(full.threw).toBeNull();
    const warning = full.logs.find((l) => l.includes("signing key"));
    expect(warning).toContain("posting disabled");
    expect(warning).not.toContain(s.config.signingKeyFile!);
    expect(full.logs.join("\n")).not.toContain(root);
    const tool = full.tools[0]!.factory({ sessionKey: "sess-1", agentId: "anvil", sandboxed: true }) as {
      execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const out = JSON.parse((await tool.execute("c", validInput())).content[0]!.text) as { reason?: string };
    expect(out.reason).toBe("signing_unavailable");
  });

  test("a full registration's credential and signing-key diagnostics name no path", async () => {
    const { s, pluginConfig } = validHost();
    fs.chmodSync(s.config.credentialFile!, 0o644);
    const loose = await registerObserved("full", pluginConfig);
    fs.rmSync(s.config.credentialFile!);
    fs.rmSync(s.config.signingKeyFile!);
    const missing = await registerObserved("full", pluginConfig);
    expect(missing.logs.some((l) => l.includes("signing key could not be loaded (ENOENT)"))).toBe(true);
    for (const run of [loose, missing]) {
      expect(run.logs.some((l) => l.includes("credential"))).toBe(true);
      expect(run.logs.join("\n")).not.toContain(root);
    }
  });
});
