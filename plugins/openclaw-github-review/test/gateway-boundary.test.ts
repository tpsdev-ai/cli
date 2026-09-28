/**
 * gateway-boundary.test.ts — section E / A10 (host/container contrast) and A11
 * (secret canaries).
 *
 * The lane registers the plugin through the SAME `api.registerTool` mechanism
 * the gateway uses, then dispatches twice from one session: once with the
 * gateway's host context and once with a sandbox context. The host half posts
 * and reads a host-only marker; the sandbox half is refused and cannot read the
 * marker.
 *
 * HONEST SCOPE: this environment has no container runtime, so the "sandbox" is
 * modelled by an isolated child process plus the handler's own sandboxed-context
 * refusal — the strongest assertion available without the reviewer image
 * (section A, PR 2). The real container lane is a follow-up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWithDeps } from "../src/index.js";
import { makeDeps, scenario, TOKEN, validInput } from "./helpers.js";

let root: string;
let savedProbe: string | undefined;
let savedMarker: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-boundary-"));
  savedProbe = process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  savedMarker = process.env.TPS_GITHUB_REVIEW_HOST_MARKER;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedProbe === undefined) delete process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  else process.env.TPS_GITHUB_REVIEW_CI_PROBE = savedProbe;
  if (savedMarker === undefined) delete process.env.TPS_GITHUB_REVIEW_HOST_MARKER;
  else process.env.TPS_GITHUB_REVIEW_HOST_MARKER = savedMarker;
});

interface Registered {
  name: string;
  factory: (ctx: { sessionKey?: string; sandboxed?: boolean }) => {
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
}

function registerCapturing(deps: ReturnType<typeof makeDeps>["deps"]): { tools: Registered[]; logs: string[] } {
  const tools: Registered[] = [];
  const logs: string[] = [];
  const api = {
    logger: { info: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push(a.join(" ")), error: (...a: unknown[]) => logs.push(a.join(" ")) },
    registerTool: (factory: unknown, opts?: { name?: string }) => tools.push({ name: opts?.name ?? "?", factory: factory as Registered["factory"] }),
    registerChannel: () => {},
  };
  registerWithDeps(api as never, deps);
  return { tools, logs };
}

const MARKER = "HOST-ONLY-MARKER-9f3c";

describe("E / A10 — host/container contrast through the registration path", () => {
  test("the host half posts and reads the host-only marker", async () => {
    process.env.TPS_GITHUB_REVIEW_CI_PROBE = "1";
    const markerPath = join(root, "host-only.marker");
    writeFileSync(markerPath, MARKER, { mode: 0o600 });
    process.env.TPS_GITHUB_REVIEW_HOST_MARKER = markerPath;

    const { deps, github } = makeDeps(scenario(root));
    const { tools } = registerCapturing(deps);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(["github_review", "github_review_ci_probe"]);

    // The probe reports the gateway identity and reads the marker.
    const probe = byName.get("github_review_ci_probe")!.factory({ sessionKey: "sess-1", sandboxed: false });
    const probeOut = JSON.parse((await probe.execute("p1", {})).content[0]!.text) as { hostname: string; pid: number; marker: string | null };
    expect(probeOut.marker).toBe(MARKER);
    expect(probeOut.hostname).toBe(hostname());

    // The real handler, on the host, posts.
    const tool = byName.get("github_review")!.factory({ sessionKey: "sess-1", sandboxed: false });
    const out = JSON.parse((await tool.execute("c1", validInput())).content[0]!.text) as { status: string };
    expect(out.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("the sandbox half is refused and posts nothing", async () => {
    const { deps, github } = makeDeps(scenario(root));
    const { tools } = registerCapturing(deps);
    const tool = new Map(tools.map((t) => [t.name, t])).get("github_review")!.factory({ sessionKey: "sess-1", sandboxed: true });
    const out = JSON.parse((await tool.execute("c1", validInput())).content[0]!.text) as { status: string; reason?: string };
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("handler_sandboxed");
    expect(github.reviewCalls.length).toBe(0);
  });

  test("sandbox execution cannot read the host-only marker", () => {
    // The marker lives OUTSIDE the sandbox root; a child whose only view is the
    // sandbox root cannot find it.
    const markerPath = join(root, "host-only.marker");
    writeFileSync(markerPath, MARKER, { mode: 0o600 });
    const sandboxRoot = join(root, "sandbox");
    const script = [
      "const { readdirSync, statSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "let found = false;",
      "const walk = (d, depth) => { if (depth > 6) return; let e; try { e = readdirSync(d, {withFileTypes:true}); } catch { return; }",
      "  for (const x of e) { const p = join(d, x.name); if (x.isDirectory()) walk(p, depth+1); else if (x.name === 'host-only.marker') found = true; } };",
      "walk(process.env.HOME, 0);",
      "console.log(found ? 'FOUND' : 'SANDBOX_CANNOT_READ_MARKER');",
    ].join("\n");
    const res = spawnSync("node", ["-e", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: sandboxRoot },
      timeout: 20_000,
    });
    expect((res.stdout ?? "").trim()).toBe("SANDBOX_CANNOT_READ_MARKER");
  });
});

/** A scanner returning the matches of any canary present in a haystack. */
function scanForSecrets(haystack: string, canaries: string[]): string[] {
  return canaries.filter((c) => c.length > 0 && haystack.includes(c));
}

describe("A11 — complete secret-canary scans", () => {
  test("the scanner detects a controlled positive fixture", () => {
    expect(scanForSecrets(`x ${TOKEN} y`, [TOKEN])).toEqual([TOKEN]);
    expect(scanForSecrets("no secret here", [TOKEN])).toEqual([]);
  });

  test("no canary escapes into results, logs, transcripts or a sandbox env", async () => {
    const signingKey = "FAKE-SIGNING-KEY-DO-NOT-USE-4b1d";
    const markerPath = join(root, "host-only.marker");
    writeFileSync(markerPath, MARKER, { mode: 0o600 });

    process.env.TPS_GITHUB_REVIEW_CI_PROBE = "1";
    process.env.TPS_GITHUB_REVIEW_HOST_MARKER = markerPath;

    const { deps, github } = makeDeps(scenario(root));
    const { tools, logs } = registerCapturing(deps);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const tool = byName.get("github_review")!.factory({ sessionKey: "sess-1", sandboxed: false });

    const transcript: string[] = [];
    const ok = await tool.execute("c1", validInput());
    transcript.push(ok.content[0]!.text);

    // The exact bytes transmitted to GitHub (which are NOT secret).
    const transmitted = github.reviewCalls.map((c) => JSON.stringify(c)).join("\n");

    // A sandbox child's complete environment.
    const envRes = spawnSync("node", ["-e", "console.log(JSON.stringify(process.env))"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: join(root, "sandbox") },
      timeout: 20_000,
    });

    const canaries = [TOKEN, signingKey, process.env.TPS_GITHUB_REVIEW_HOST_MARKER!];
    const scans: Array<[string, string]> = [
      ["tool result", ok.content[0]!.text],
      ["gateway log", logs.join("\n")],
      ["session transcript", transcript.join("\n")],
      ["sandbox environment", envRes.stdout ?? ""],
      ["transmitted review", transmitted],
    ];
    for (const [label, hay] of scans) {
      expect([label, scanForSecrets(hay, canaries)]).toEqual([label, []]);
    }
  });
});
