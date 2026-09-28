/**
 * registration.test.ts — A1: independent plugin loading.
 *
 * The plugin registers exactly one production verb, `github_review`, through
 * `api.registerTool`, with the mail plugin absent; it requires no mail code and
 * exposes no passthrough. The built entry loads under node.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pluginModule from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const repoRoot = resolve(pluginRoot, "..", "..");

interface Registered {
  name: string;
  factory: unknown;
}

function makeApi() {
  const tools: Registered[] = [];
  const channels: unknown[] = [];
  const logs: string[] = [];
  const api = {
    pluginConfig: {},
    logger: {
      info: (...a: unknown[]) => logs.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.push(a.join(" ")),
      error: (...a: unknown[]) => logs.push(a.join(" ")),
    },
    registerTool: (factory: unknown, opts?: { name?: string }) => {
      tools.push({ name: opts?.name ?? "(unnamed)", factory });
    },
    registerChannel: (c: unknown) => channels.push(c),
  };
  return { api, tools, channels, logs };
}

let savedProbe: string | undefined;
beforeEach(() => {
  savedProbe = process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  delete process.env.TPS_GITHUB_REVIEW_CI_PROBE;
});
afterEach(() => {
  if (savedProbe === undefined) delete process.env.TPS_GITHUB_REVIEW_CI_PROBE;
  else process.env.TPS_GITHUB_REVIEW_CI_PROBE = savedProbe;
});

describe("A1 — independent plugin loading", () => {
  test("registers exactly one production verb, github_review", () => {
    const { api, tools, channels } = makeApi();
    (pluginModule as { register: (a: unknown) => void }).register(api);
    expect(tools.map((t) => t.name)).toEqual(["github_review"]);
    expect(channels.length).toBe(0);
  });

  test("the registered tool carries only the five documented fields", () => {
    const { api, tools } = makeApi();
    (pluginModule as { register: (a: unknown) => void }).register(api);
    const factory = tools[0]!.factory as (ctx: unknown) => { name: string; parameters: unknown };
    const tool = factory({ sessionKey: "s", sandboxed: false });
    expect(tool.name).toBe("github_review");
    const params = tool.parameters as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(params.properties).sort()).toEqual(["body", "commit_id", "event", "pr", "repo"]);
    expect(params.additionalProperties).toBe(false);
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
    // The package declares no dependency on the mail plugin or the CLI, and the
    // built entry references neither.
    const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    expect(Object.keys(deps).some((d) => d.includes("tps-mail"))).toBe(false);
    expect(Object.keys(deps).some((d) => d === "@tpsdev-ai/cli")).toBe(false);
    const entry = join(pluginRoot, "dist", "src", "index.js");
    if (existsSync(entry)) {
      const text = readFileSync(entry, "utf8");
      expect(text.includes("tps-mail")).toBe(false);
    }
  });

  test("the built entry loads under node", () => {
    const entry = join(pluginRoot, "dist", "src", "index.js");
    expect(existsSync(entry)).toBe(true);
    const script = `import(${JSON.stringify(entry)}).then(()=>console.log("LOADED")).catch(e=>{console.error(e.code||e.message);process.exit(2)})`;
    const res = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    expect(combined).toContain("LOADED");
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
