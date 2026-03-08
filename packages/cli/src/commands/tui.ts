/**
 * tui.ts — TPS Terminal UI (Phase 1: read-only dashboard)
 * ops-90
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentStatus {
  id: string;
  status: "online" | "busy" | "offline";
  lastSeen?: string;
}

interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read?: boolean;
}

interface PullRequest {
  number: number;
  title: string;
  author: { login: string };
  statusCheckRollup?: Array<{ state: string }> | { state: string } | null;
}

type Panel = "agents" | "mail" | "tasks" | "prs" | "logs";
const PANELS: Panel[] = ["agents", "mail", "tasks", "prs", "logs"];
const PANEL_KEYS: Record<string, Panel> = {
  "1": "agents",
  "2": "mail",
  "3": "tasks",
  "4": "prs",
  "5": "logs",
};
const PANEL_LABELS: Record<Panel, string> = {
  agents: "Agents",
  mail: "Mail",
  tasks: "Tasks",
  prs: "PRs",
  logs: "Logs",
};

// ── Data fetching ──────────────────────────────────────────────────────────────

function runCmd(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 5000 });
  return r.stdout?.trim() ?? "";
}

function fetchAgents(): AgentStatus[] {
  try {
    const tpsBin = join(homedir(), "ops", "tps", "packages", "cli", "bin", "tps.ts");
    const out = execSync(`bun ${tpsBin} office status --json 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (out) {
      const data = JSON.parse(out) as { agents?: AgentStatus[] };
      if (Array.isArray(data.agents)) return data.agents;
    }
  } catch {
    // fall through to process check
  }
  const ids = ["flint", "anvil", "ember", "pixel", "kern", "sherlock"];
  return ids.map((id) => {
    const psCheck = spawnSync("pgrep", ["-f", `agent start.*${id}`], { encoding: "utf-8" });
    const running = (psCheck.stdout?.trim().length ?? 0) > 0;
    return { id, status: running ? "online" : "offline" } as AgentStatus;
  });
}

function fetchMail(mailDir: string, agentId: string): MailMessage[] {
  try {
    const tpsBin = join(homedir(), "ops", "tps", "packages", "cli", "bin", "tps.ts");
    const out = execSync(
      `TPS_AGENT_ID=${agentId} bun ${tpsBin} mail list --agent ${agentId} --json --limit 15 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (!out) return [];
    return JSON.parse(out) as MailMessage[];
  } catch {
    return [];
  }
}

const REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function fetchPRs(repo: string): PullRequest[] {
  if (!REPO_RE.test(repo)) return [];
  try {
    const out = runCmd("gh-as", [
      "anvil", "pr", "list", "--repo", repo,
      "--json", "number,title,author,statusCheckRollup", "--limit", "10",
    ]);
    if (!out) return [];
    return JSON.parse(out) as PullRequest[];
  } catch {
    return [];
  }
}

function fetchLogs(agentId: string): string[] {
  try {
    const logPath = join(homedir(), ".tps", "logs", `${agentId}.log`);
    if (!existsSync(logPath)) return ["(no log file)"];
    return runCmd("tail", ["-n", "25", logPath]).split("\n");
  } catch {
    return ["(error reading log)"];
  }
}

function fetchTasks(): string[] {
  try {
    const out = runCmd("bd", ["ready"]);
    return out.split("\n").filter(Boolean).slice(0, 10);
  } catch {
    return ["(bd unavailable)"];
  }
}

// ── Components ─────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: AgentStatus["status"] }) {
  const color = status === "online" ? "green" : status === "busy" ? "yellow" : "gray";
  const sym = status === "online" ? "●" : status === "busy" ? "◕" : "○";
  return React.createElement(Text, { color }, sym);
}

function AgentsPanel({ agents }: { agents: AgentStatus[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── Agents ──"),
    ...agents.map((a) =>
      React.createElement(Box, { key: a.id, gap: 1 },
        React.createElement(StatusDot, { status: a.status }),
        React.createElement(Text, { color: a.status === "offline" ? "gray" : "white" }, a.id),
      ),
    ),
  );
}

function MailPanel({ messages }: { messages: MailMessage[] }) {
  if (messages.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── Mail ──"),
      React.createElement(Text, { color: "gray" }, "(inbox empty)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── Mail ──"),
    ...messages.slice(0, 8).map((m) =>
      React.createElement(Box, { key: m.id, flexDirection: "column", marginBottom: 1 },
        React.createElement(Box, { gap: 2 },
          React.createElement(Text, { color: m.read ? "gray" : "cyan", bold: !m.read }, m.from),
          React.createElement(Text, { color: "gray" }, m.timestamp.slice(5, 16)),
        ),
        React.createElement(Text, { wrap: "truncate", color: "white" },
          m.body.split("\n")[0]?.slice(0, 90) ?? ""),
      ),
    ),
  );
}

function PRsPanel({ prs }: { prs: PullRequest[] }) {
  if (prs.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── PRs ──"),
      React.createElement(Text, { color: "gray" }, "(none open)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── PRs ──"),
    ...prs.map((pr) => {
      const rollup = pr.statusCheckRollup;
      const state = Array.isArray(rollup)
        ? rollup[0]?.state
        : (rollup as { state?: string } | null)?.state;
      const color = state === "SUCCESS" ? "green" : state === "FAILURE" ? "red" : "gray";
      const sym = state === "SUCCESS" ? "✓" : state === "FAILURE" ? "✗" : "·";
      return React.createElement(Box, { key: pr.number, gap: 1 },
        React.createElement(Text, { color }, sym),
        React.createElement(Text, { color: "yellow" }, `#${pr.number}`),
        React.createElement(Text, { wrap: "truncate", color: "white" }, pr.title.slice(0, 60)),
      );
    }),
  );
}

function TasksPanel({ tasks }: { tasks: string[] }) {
  if (tasks.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── Tasks (ready) ──"),
      React.createElement(Text, { color: "gray" }, "(none)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── Tasks (ready) ──"),
    ...tasks.map((t, i) =>
      React.createElement(Text, { key: i, wrap: "truncate", color: "white" }, t),
    ),
  );
}

function LogsPanel({ lines }: { lines: string[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── Logs (ember) ──"),
    ...lines.slice(-20).map((l, i) =>
      React.createElement(Text, { key: i, color: "gray", wrap: "truncate" }, l || " "),
    ),
  );
}

function TabBar({ active }: { active: Panel }) {
  return React.createElement(Box, { gap: 2, paddingX: 1 },
    React.createElement(Text, { bold: true, color: "white" }, "TPS Office"),
    React.createElement(Text, { color: "gray" }, "|"),
    ...PANELS.map((p, i) =>
      React.createElement(Text, {
        key: p,
        bold: p === active,
        color: p === active ? "cyan" : "gray",
      }, `[${i + 1}]${PANEL_LABELS[p]}`),
    ),
  );
}

function StatusBar({ lastRefresh, error }: { lastRefresh: Date | null; error: string | null }) {
  return React.createElement(Box, { gap: 3, marginTop: 1 },
    React.createElement(Text, { color: "gray" }, "Tab/1-5: panel  r: refresh  q: quit"),
    lastRefresh
      ? React.createElement(Text, { color: "gray" }, `refreshed ${lastRefresh.toLocaleTimeString()}`)
      : null,
    error
      ? React.createElement(Text, { color: "red" }, `⚠ ${error}`)
      : null,
  );
}

// ── App ────────────────────────────────────────────────────────────────────────

export interface TuiOptions {
  mailDir?: string;
  agentId?: string;
  repo?: string;
}

export function TuiApp({
  mailDir = join(homedir(), ".tps", "mail"),
  agentId = "anvil",
  repo = "tpsdev-ai/cli",
}: TuiOptions) {
  const { exit } = useApp();
  const [panel, setPanel] = useState<Panel>("agents");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [mail, setMail] = useState<MailMessage[]>([]);
  const [prs, setPRs] = useState<PullRequest[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshing = useRef(false);

  const refresh = useCallback(() => {
    if (refreshing.current) return;
    refreshing.current = true;
    setError(null);
    try {
      setAgents(fetchAgents());
      setMail(fetchMail(mailDir, agentId));
      setPRs(fetchPRs(repo));
      setLogs(fetchLogs("ember"));
      setTasks(fetchTasks());
      setLastRefresh(new Date());
    } catch (e: unknown) {
      setError((e as Error).message ?? "refresh failed");
    } finally {
      refreshing.current = false;
    }
  }, [mailDir, agentId, repo]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  useInput((input, key) => {
    if (input === "q") exit();
    if (input === "r") refresh();
    if (key.tab) setPanel((p) => PANELS[(PANELS.indexOf(p) + 1) % PANELS.length]);
    const mapped = PANEL_KEYS[input];
    if (mapped) setPanel(mapped);
  });

  const content =
    panel === "agents" ? React.createElement(AgentsPanel, { agents }) :
    panel === "mail"   ? React.createElement(MailPanel, { messages: mail }) :
    panel === "tasks"  ? React.createElement(TasksPanel, { tasks }) :
    panel === "prs"    ? React.createElement(PRsPanel, { prs }) :
                         React.createElement(LogsPanel, { lines: logs });

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(TabBar, { active: panel }),
    React.createElement(Box, { flexGrow: 1, paddingTop: 1, paddingX: 2 }, content),
    React.createElement(StatusBar, { lastRefresh, error }),
  );
}
