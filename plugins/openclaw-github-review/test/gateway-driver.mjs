#!/usr/bin/env node
/**
 * gateway-driver.mjs — the gateway half of the section-E boundary lane. The lane
 * (gateway-boundary.test.ts) runs this file under NODE, the gateway's runtime:
 * OpenClaw's plugin loader needs node:sqlite, which bun does not provide.
 *
 * In this one node process it:
 *   1. replaces globalThis.fetch with CONTROLLED GitHub and Flair services,
 *      BEFORE the plugin registers, so the plugin's own HttpGitHubApi and
 *      FlairHttpAuditSink post through them (every request is recorded);
 *   2. loads the BUILT plugin with OpenClaw's own loader (`loadOpenClawPlugins`,
 *      activate: true — how a gateway installs its root registry): manifest
 *      discovery from the plugin directory, config-schema validation, and
 *      createPluginRegistry().createApi(record, { registrationMode: "full" })
 *      with the record read from that directory's openclaw.plugin.json;
 *   3. resolves the reviewer session's tools through OpenClaw's gateway tool
 *      resolution (`resolveGatewayScopedTools`), which classifies the session
 *      as sandboxed from agents.entries.<reviewer>.sandbox.mode = "all" and
 *      applies that sandbox's tool policy — once with OpenClaw's DEFAULT policy
 *      and once with the documented `alsoAllow`;
 *   4. dispatches tool calls through the gateway's tools.invoke path
 *      (`invokeGatewayTool`), which resolves the tools the same way and runs
 *      the before-tool-call hooks before executing the tool.
 *
 * It does NOT run a sandbox container or the embedded agent runner; the
 * container half of the host/container contrast arrives with the reviewer
 * image (section A).
 *
 * The OpenClaw functions are internal chunk exports, located by name in the
 * pinned openclaw install; a missing one fails the lane by name.
 *
 * usage: node gateway-driver.mjs <spec.json>   (writes spec.reportFile and spec.requestsFile)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));

// ── prerequisites: the node running this must satisfy openclaw's engines ──
const openclawPkg = JSON.parse(readFileSync(join(spec.openclawDist, "..", "package.json"), "utf8"));
function satisfies(version, range) {
  const v = version.replace(/^v/, "").split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return range.split("||").some((clause) =>
    clause
      .trim()
      .split(/\s+/)
      .every((c) => {
        const m = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(c);
        if (!m) throw new Error(`unparsed engines clause "${c}"`);
        const d = cmp(v, [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]);
        return m[1] === ">=" ? d >= 0 : m[1] === ">" ? d > 0 : m[1] === "<=" ? d <= 0 : m[1] === "<" ? d < 0 : d === 0;
      }),
  );
}
const engines = openclawPkg.engines?.node ?? "";
if (engines && !satisfies(process.version, engines)) {
  console.error(`gateway-driver: node ${process.version} does not satisfy openclaw ${openclawPkg.version} engines "${engines}"`);
  process.exit(3);
}

// ── 1. controlled GitHub and Flair services ──
const requests = [];
const unexpected = [];
let gate = null;
let reviewCount = 0;
const STATE = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };
const GH = `https://api.github.com/repos/${spec.github.repo}/pulls/${spec.github.pr}`;
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
  const body = init.body == null ? null : String(init.body);
  requests.push({ pid: process.pid, method, url, authorization: headers.authorization ?? null, body });
  if (method === "GET" && url === GH) {
    if (gate) await gate.promise;
    return json(200, { state: "open", head: { sha: spec.github.head } });
  }
  if (method === "POST" && url === `${GH}/reviews`) {
    const posted = JSON.parse(body);
    const id = spec.github.reviewId + reviewCount++;
    return json(200, {
      id,
      html_url: `https://github.com/${spec.github.repo}/pull/${spec.github.pr}#pullrequestreview-${id}`,
      commit_id: posted.commit_id,
      state: STATE[posted.event],
    });
  }
  if (method === "POST" && url === `${spec.flairUrl}/OrgEvent/`) {
    return new Response("", { status: spec.flairStatus ?? 200 });
  }
  unexpected.push({ method, url });
  throw new Error("gateway-driver: request to an uncontrolled service");
};

// ── locate OpenClaw's internal exports by name ──
async function openclawExport(filePattern, name) {
  const rx = new RegExp(`\\b${name} as ([A-Za-z0-9_$]+)`);
  for (const f of readdirSync(spec.openclawDist)) {
    if (!filePattern.test(f)) continue;
    const m = rx.exec(readFileSync(join(spec.openclawDist, f), "utf8"));
    if (!m) continue;
    const fn = (await import(pathToFileURL(join(spec.openclawDist, f)).href))[m[1]];
    if (typeof fn === "function") return fn;
  }
  throw new Error(`gateway-driver: openclaw ${openclawPkg.version} has no ${name} export in ${filePattern}`);
}
const loadOpenClawPlugins = await openclawExport(/^loader-.*\.js$/, "loadOpenClawPlugins");
const resolveGatewayScopedTools = await openclawExport(/^tool-resolution-.*\.js$/, "resolveGatewayScopedTools");
const invokeGatewayTool = await openclawExport(/^tools-invoke-shared-.*\.js$/, "invokeGatewayTool");

// ── the reviewer's gateway configuration ──
const plugins = {
  allow: [spec.pluginId],
  load: { paths: [spec.pluginDir] },
  entries: { [spec.pluginId]: { enabled: true, config: spec.pluginConfig } },
};
const reviewerEntry = (alsoAllow) => ({
  sandbox: { mode: "all" },
  ...(alsoAllow ? { tools: { sandbox: { tools: { alsoAllow } } } } : {}),
});
const cfgs = {
  default: { plugins, agents: { entries: { [spec.reviewer]: reviewerEntry(null) } } },
  allowed: { plugins, agents: { entries: { [spec.reviewer]: reviewerEntry(spec.sandboxAllow) } } },
};

// ── 2. register through OpenClaw's loader ──
const logs = [];
const logger = {
  info: (m) => logs.push(`info ${m}`),
  warn: (m) => logs.push(`warn ${m}`),
  error: (m) => logs.push(`error ${m}`),
  debug: () => {},
};
const registry = loadOpenClawPlugins({
  config: cfgs.allowed,
  onlyPluginIds: [spec.pluginId],
  activate: true,
  cache: false,
  workspaceDir: spec.workspaceDir,
  logger,
});
const record = registry.plugins.find((p) => p.id === spec.pluginId) ?? null;

// ── 3. the tools the reviewer session is offered ──
function offered(cfg) {
  const { tools } = resolveGatewayScopedTools({ cfg, sessionKey: spec.sessionKey, agentId: spec.reviewer, surface: "loopback" });
  return tools;
}
const firstAllowed = offered(cfgs.allowed);
const report = {
  pid: process.pid,
  hostname: hostname(),
  node: process.version,
  openclawVersion: openclawPkg.version,
  diagnostics: registry.diagnostics.map((d) => ({ level: d.level, pluginId: d.pluginId ?? null, message: d.message })),
  plugin: record && { id: record.id, status: record.status, origin: record.origin, contracts: record.contracts ?? null },
  registryTools: registry.tools.map((t) => ({ pluginId: t.pluginId, names: t.names })),
  offered: {
    default: offered(cfgs.default).map((t) => t.name),
    allowed: firstAllowed.map((t) => t.name),
  },
  executionMode: firstAllowed.find((t) => t.name === "github_review")?.executionMode ?? null,
  invocations: {},
  logs,
  unexpected,
};

// ── 4. dispatch through the gateway's tools.invoke path ──
async function invoke(step) {
  const r = await invokeGatewayTool({
    cfg: cfgs[step.cfg],
    input: { name: step.name, args: step.args ?? {}, sessionKey: spec.sessionKey },
    toolCallIdPrefix: "lane",
    senderIsOwner: false,
  });
  return { status: r.status, errorType: r.error?.type ?? null, text: r.result?.content?.[0]?.text ?? null };
}
for (const step of spec.invocations ?? []) {
  if (step.parallel) {
    // Hold the first call's PR lookup until every other call has settled, so
    // they arrive while the first is in flight (released after 5 s regardless).
    let open;
    gate = { promise: new Promise((r) => (open = r)) };
    const timer = setTimeout(() => open(), 5000);
    const [first, ...rest] = step.parallel.map((s) => invoke(s));
    const restResults = await Promise.all(rest);
    open();
    const firstResult = await first;
    clearTimeout(timer);
    gate = null;
    report.invocations[step.label] = [firstResult, ...restResults];
  } else {
    report.invocations[step.label] = await invoke(step);
  }
}

writeFileSync(spec.requestsFile, JSON.stringify(requests));
writeFileSync(spec.reportFile, JSON.stringify(report));
