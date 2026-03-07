/**
 * office-status.ts — `tps office status`
 *
 * Full office state at a glance:
 *   - All agents: role, model, status, last heartbeat
 *   - Current task (from recent OrgEvents)
 *   - Open PRs (via gh-as)
 *   - Task loop cursor age per agent
 *   - Git branch + dirty status for known workspaces
 */

import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface FlairAgent {
  id?: string;
  agentId?: string;
  name?: string;
  role?: string;
  model?: string;
  workspace?: string;
  status?: string;
  lastHeartbeat?: string;
}

interface OrgEvent {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  detail?: string;
  refId?: string;
  createdAt?: string;
}

interface PrInfo {
  number: number;
  title: string;
  url: string;
}

export interface OfficeStatusOpts {
  flairUrl?: string;
  agentId?: string;
  keyPath?: string;
  repo?: string;
  ghAgent?: string;
  json?: boolean;
  noColor?: boolean;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
function esc(code: number, text: string, nc: boolean): string {
  return nc ? text : `\x1b[${code}m${text}\x1b[0m`;
}
const bold   = (t: string, nc: boolean) => esc(1,  t, nc);
const green  = (t: string, nc: boolean) => esc(32, t, nc);
const yellow = (t: string, nc: boolean) => esc(33, t, nc);
const cyan   = (t: string, nc: boolean) => esc(36, t, nc);
const dim    = (t: string, nc: boolean) => esc(2,  t, nc);
const red    = (t: string, nc: boolean) => esc(31, t, nc);

// ── Auth helper ───────────────────────────────────────────────────────────────
function makeAuth(viewerId: string, keyPath: string, method: string, urlPath: string): string | undefined {
  if (!existsSync(keyPath)) return undefined;
  try {
    const raw = readFileSync(keyPath);
    let privKey;
    try { privKey = createPrivateKey(raw); } catch {
      const h = Buffer.from("302e020100300506032b657004220420", "hex");
      privKey = createPrivateKey({ key: Buffer.concat([h, raw]), format: "der", type: "pkcs8" });
    }
    const ts = Date.now().toString();
    const nonce = Math.random().toString(36).slice(2, 10);
    const sig = sign(null, Buffer.from(`${viewerId}:${ts}:${nonce}:${method}:${urlPath}`), privKey).toString("base64");
    return `TPS-Ed25519 ${viewerId}:${ts}:${nonce}:${sig}`;
  } catch { return undefined; }
}

// ── PR lookup ─────────────────────────────────────────────────────────────────
function fetchOpenPrs(ghAgent: string, repo: string): PrInfo[] {
  const result = spawnSync("gh-as", [ghAgent, "pr", "list", "--repo", repo,
    "--state", "open", "--json", "number,title,url"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout?.trim()) return [];
  try { return JSON.parse(result.stdout) as PrInfo[]; } catch { return []; }
}

// ── Cursor age ────────────────────────────────────────────────────────────────
function loadCursorIso(agentId: string): string | null {
  const p = join(homedir(), ".tps", "cursors", `${agentId}-task-loop.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")).since ?? null; } catch { return null; }
}

// ── Relative time ─────────────────────────────────────────────────────────────
function relTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Git branch + dirty check ──────────────────────────────────────────────────
function gitBranchStatus(workspace: string | undefined): string {
  if (!workspace || !existsSync(workspace)) return "—";
  const r = spawnSync("git", ["-C", workspace, "status", "--porcelain", "--branch"], { encoding: "utf-8" });
  if (r.status !== 0) return "?";
  const lines = (r.stdout ?? "").split("\n").filter(Boolean);
  const branch = (lines[0] ?? "").replace(/^##\s+/, "").split("...")[0] ?? "?";
  const dirty = lines.slice(1).length;
  return dirty > 0 ? `${branch} +${dirty}` : branch;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function runOfficeStatus(opts: OfficeStatusOpts): Promise<void> {
  const flairUrl = opts.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const viewerId = opts.agentId ?? process.env.TPS_AGENT_ID ?? "anvil";
  const kp = opts.keyPath ?? join(homedir(), ".tps", "identity", `${viewerId}.key`);
  const repo = opts.repo ?? process.env.TPS_REPO ?? "";
  const ghAgent = opts.ghAgent ?? viewerId;
  const nc = opts.noColor ?? false;

  function a(method: string, path: string) { return makeAuth(viewerId, kp, method, path); }

  // Fetch agents
  let agents: FlairAgent[] = [];
  try {
    const auth = a("GET", "/Agent/");
    const res = await fetch(`${flairUrl}/Agent/`, auth ? { headers: { Authorization: auth } } : {});
    if (res.ok) { agents = await res.json() as FlairAgent[]; }
    else { console.error(`Flair unreachable at ${flairUrl} (HTTP ${res.status})`); process.exit(1); }
  } catch { console.error(`Flair unreachable at ${flairUrl}. Is it running?`); process.exit(1); }

  // Fetch recent OrgEvents (last 6h) for task + heartbeat status
  const since = new Date(Date.now() - 6 * 3_600_000).toISOString().replace(/Z$/, ".000Z");
  const evPath = `/OrgEventCatchup/${viewerId}?since=${since}`;
  let events: OrgEvent[] = [];
  try {
    const auth = a("GET", evPath);
    const res = await fetch(`${flairUrl}${evPath}`, auth ? { headers: { Authorization: auth } } : {});
    if (res.ok) events = await res.json() as OrgEvent[];
  } catch { /* non-fatal */ }

  const lastTask   = new Map<string, OrgEvent>();
  const lastHbTime = new Map<string, string>();
  for (const ev of events) {
    const id = ev.authorId;
    if (!lastTask.has(id) && ["task.assigned","task.completed","task.started"].includes(ev.kind)) {
      lastTask.set(id, ev);
    }
    if (ev.kind === "agent.heartbeat" && !lastHbTime.has(id) && ev.createdAt) {
      lastHbTime.set(id, ev.createdAt);
    }
  }

  // Fetch open PRs
  const openPrs: PrInfo[] = repo ? fetchOpenPrs(ghAgent, repo) : [];

  // JSON output
  if (opts.json) {
    const out = agents.map(ag => {
      const id = ag.id ?? ag.agentId ?? "?";
      return {
        id, name: ag.name, role: ag.role, model: ag.model, status: ag.status,
        lastHeartbeat: ag.lastHeartbeat ?? lastHbTime.get(id),
        lastTask: lastTask.get(id),
        cursorSince: loadCursorIso(id),
        git: gitBranchStatus(ag.workspace),
      };
    });
    console.log(JSON.stringify({ agents: out, openPrs }, null, 2));
    return;
  }

  // Terminal output
  const now = new Date().toLocaleTimeString();
  console.log();
  console.log(`${bold("⚒️  TPS Office", nc)}  ${dim(now, nc)}`);
  console.log(dim("─".repeat(74), nc));
  console.log(
    dim(`  ${"AGENT".padEnd(12)} ${"ROLE".padEnd(26)} ${"MODEL".padEnd(18)} ${"HEARTBEAT".padEnd(12)} TASK`, nc)
  );
  console.log(dim("─".repeat(74), nc));

  for (const ag of agents) {
    const id   = ag.id ?? ag.agentId ?? "?";
    const name = (ag.name ?? id).padEnd(12);
    const role = (ag.role ?? "?").padEnd(26);
    const model= ((ag.model ?? "?").split("/").pop() ?? "?").padEnd(18);
    const hbIso= ag.lastHeartbeat ?? lastHbTime.get(id);
    const hb   = relTime(hbIso).padEnd(12);
    const dot  = ag.status === "active" ? green("●", nc) : yellow("○", nc);
    const task = lastTask.get(id);
    const taskStr = task
      ? (task.kind === "task.completed"
          ? green("✓ " + (task.summary.length > 30 ? task.summary.slice(0,30)+"…" : task.summary), nc)
          : yellow("→ " + (task.summary.length > 30 ? task.summary.slice(0,30)+"…" : task.summary), nc))
      : dim("idle", nc);

    console.log(`${dot} ${cyan(name, nc)} ${role} ${dim(model, nc)} ${hb} ${taskStr}`);

    // Sub-lines: git + cursor
    const git = gitBranchStatus(ag.workspace);
    const cursor = loadCursorIso(id);
    const extras: string[] = [];
    if (ag.workspace) extras.push(`git: ${git.includes("+") ? yellow(git, nc) : dim(git, nc)}`);
    if (cursor) extras.push(`cursor: ${relTime(cursor)}`);
    if (extras.length > 0) console.log(`  ${dim(extras.join("  •  "), nc)}`);
  }

  console.log(dim("─".repeat(74), nc));

  // PRs
  if (repo) {
    if (openPrs.length === 0) {
      console.log(`  ${green("✓ No open PRs", nc)}`);
    } else {
      console.log(`  ${yellow(`${openPrs.length} open PR${openPrs.length !== 1 ? "s" : ""}`, nc)}`);
      for (const pr of openPrs) {
        const t = pr.title.length > 62 ? pr.title.slice(0, 62) + "…" : pr.title;
        console.log(`    ${dim(`#${pr.number}`, nc)} ${t}`);
      }
    }
  }

  // Blockers
  const blocker = events.find(e => e.kind === "blocker");
  if (blocker) console.log(`  ${red(`⚠ BLOCKER: ${blocker.summary}`, nc)}`);

  console.log();
}
