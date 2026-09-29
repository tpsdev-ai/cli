/**
 * gateway-lane.ts (test helper) — runs gateway-driver.mjs, the gateway half of
 * the section-E lane, in a separate NODE process against the pinned openclaw
 * install, and returns what it reported, every request its controlled services
 * received, and everything it printed.
 *
 * The child gets a MINIMAL environment built here (PATH, an isolated HOME and
 * TMPDIR, and the probe variables a run asks for) — never this process's
 * environment — so the launch data the secret scan checks is exactly what is
 * passed. The node binary is the one that launched the suite
 * (scripts/run-tests.mjs exports it as TPS_LANE_NODE).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ID = "openclaw-github-review";
const DRIVER = join(PLUGIN_DIR, "test", "gateway-driver.mjs");

export interface LaneInvocation {
  label?: string;
  cfg: "default" | "allowed";
  name: string;
  args?: Record<string, unknown>;
}
export type LaneStep = (LaneInvocation & { label: string }) | { label: string; parallel: LaneInvocation[] };

export interface LaneSpec {
  pluginDir: string;
  reviewer: string;
  sessionKey: string;
  pluginConfig: Record<string, unknown>;
  sandboxAllow: string[];
  github: { repo: string; pr: number; head: string; reviewId: number };
  flairUrl: string;
  flairStatus?: number;
  invocations: LaneStep[];
}

export interface InvokeResult {
  status: number;
  errorType: string | null;
  text: string | null;
}

export interface LaneReport {
  pid: number;
  hostname: string;
  node: string;
  openclawVersion: string;
  diagnostics: Array<{ level: string; pluginId: string | null; message: string }>;
  plugin: { id: string; status: string; origin: string; contracts: { tools?: string[] } | null } | null;
  registryTools: Array<{ pluginId: string; names: string[] }>;
  offered: { default: string[]; allowed: string[] };
  executionMode: string | null;
  invocations: Record<string, InvokeResult | InvokeResult[]>;
  logs: string[];
  unexpected: Array<{ method: string; url: string }>;
}

export interface LaneRequest {
  pid: number;
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

export interface LaneRun {
  status: number | null;
  stdout: string;
  stderr: string;
  report: LaneReport;
  requests: LaneRequest[];
  argv: string[];
  env: Record<string, string>;
}

/** Run the gateway driver once. `root` is this run's private directory. */
export function runGatewayLane(root: string, spec: LaneSpec, extraEnv: Record<string, string> = {}): LaneRun {
  const home = join(root, "gateway-home");
  const tmp = join(root, "gateway-tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const reportFile = join(root, "lane-report.json");
  const requestsFile = join(root, "lane-requests.json");
  const specFile = join(root, "lane-spec.json");
  writeFileSync(
    specFile,
    JSON.stringify({
      ...spec,
      pluginId: PLUGIN_ID,
      openclawDist: join(PLUGIN_DIR, "node_modules", "openclaw", "dist"),
      workspaceDir: join(home, "workspace"),
      reportFile,
      requestsFile,
    }),
    { mode: 0o600 },
  );
  const node = process.env.TPS_LANE_NODE || "node";
  const argv = [DRIVER, specFile];
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmp, ...extraEnv };
  const res = spawnSync(node, argv, { env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (res.status !== 0 || !existsSync(reportFile)) {
    throw new Error(`gateway driver failed (status ${res.status}, signal ${res.signal}):\n${stderr}\n${stdout}`);
  }
  return {
    status: res.status,
    stdout,
    stderr,
    report: JSON.parse(readFileSync(reportFile, "utf8")) as LaneReport,
    requests: JSON.parse(readFileSync(requestsFile, "utf8")) as LaneRequest[],
    argv: [node, ...argv],
    env,
  };
}

/** A copy of the BUILT plugin package whose manifest also declares the CI
 *  probe. The overlay exists only in the lane's temp root; the shipped
 *  manifest never declares the probe. */
export function createProbeOverlay(root: string, probeToolName: string): string {
  const dir = join(root, "probe-overlay", PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  cpSync(join(PLUGIN_DIR, "package.json"), join(dir, "package.json"));
  cpSync(join(PLUGIN_DIR, "dist"), join(dir, "dist"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "openclaw.plugin.json"), "utf8")) as {
    contracts: { tools: string[] };
  };
  manifest.contracts.tools = [...manifest.contracts.tools, probeToolName];
  writeFileSync(join(dir, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** The openclaw release the lane is pinned to (the plugin's devDependency). */
export function pinnedOpenclawVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
  return pkg.devDependencies?.openclaw ?? "";
}
