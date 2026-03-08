/**
 * tui.ts — TPS Terminal UI (Phase 1: read-only dashboard)
 * ops-90
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentStatus {
  id: string;
  status: "online" | "offline";
}

interface MailMessage {
  id: string;
  from: string;
  body: string;
  timestamp: string;
}

interface PullRequest {
  number: number;
  title: string;
  author: { login: string };
  statusCheckRollup?: { state: string } | null;
}

type Panel = "agents" | "mail" | "tasks" | "prs" | "logs";
const PANELS: Panel[] = ["agents", "mail", "tasks", "prs", "logs"];
const PANEL_KEYS: Record<string, Panel> = { "1": "agents", "2": "mail", "3": "tasks", "4": "prs", "5": "logs" };
const PANEL_LABELS: Record<Panel, string> = { agents: "Agents", mail: "Mail", tasks: "Tasks", prs: "PRs", logs: "Logs" };

// ── Helpers ────────────────────────────────────────────────────────────────────

function runCmd(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  return r.stdout?.trim() ?? "";
}

function fetchAgents(): AgentStatus[] {
  const ids = ["flint", "anvil", "ember", "pixel", "kern", "sherlock"];
  return ids.map((id) => {
    const pidFile = join(homedir(), "ops", `tps-${id}`, ".tps-agent.pid");
    return { id, status: existsSync(pidFile) ? "online" : "offline" } as AgentStatus;
  });
}

function fetchMail(mailDir: string, agentId: string): MailMessage[] {
  try {
    const out = runCmd("tps", ["mail", "list", "--agent", agentId, "--json", "--limit", "20"]);
    if (!out) return [];
    return JSON.parse(out) as MailMessage[];
  } catch { return []; }
}

const REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function fetchPRs(repo: string): PullRequest[] {
  if (!REPO_RE.test(repo)) {
    console.error(`[tui] Invalid repo format: ${repo}`);
    return [];
  }
  try {
    const out = runCmd("gh", ["pr", "list", "--repo", repo,
      "--json", "number,title,author,statusCheckRollup", "--limit", "10"]);
    if (!out) return [];
    return JSON.parse(out) as PullRequest[];
  } catch { return []; }
}

function fetchLogs(agentId: string): string[] {
  try {
    const logPath = join(homedir(), ".tps", "logs", `${agentId}.log`);
    if (!existsSync(logPath)) return ["(no log)"];
    return runCmd("tail", ["-n", "20", logPath]).split("\n");
  } catch { return []; }
}

function fetchTasks(): string[] {
  try {
    return runCmd("bd", ["ready"]).split("\n").filter(Boolean).slice(0, 10);
  } catch { return ["(bd unavailable)"]; }
}

// ── Components ─────────────────────────────────────────────────────────────────

function Dot({ status }: { status: "online" | "offline" }) {
  return React.createElement(Text, { color: status === "online" ? "green" : "gray" },
    status === "online" ? "●" : "○");
}

function AgentsPanel({ agents }: { agents: AgentStatus[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true }, "── Agents ──"),
    ...agents.map((a) => React.createElement(Box, { key: a.id, gap: 1 },
      React.createElement(Dot, { status: a.status }),
      React.createElement(Text, null, a.id),
    )),
  );
}

function MailPanel({ messages }: { messages: MailMessage[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true }, "── Mail ──"),
    messages.length === 0
      ? React.createElement(Text, { color: "gray" }, "(empty)")
      : messages.slice(0, 8).map((m) => React.createElement(Box, { key: m.id, flexDirection: "column" },
          React.createElement(Box, { gap: 1 },
            React.createElement(Text, { color: "cyan" }, m.from),
            React.createElement(Text, { color: "gray" }, m.timestamp.slice(0, 16)),
          ),
          React.createElement(Text, { wrap: "truncate" }, m.body.slice(0, 100)),
        )),
  );
}

function PRsPanel({ prs }: { prs: PullRequest[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true }, "── PRs ──"),
    prs.length === 0
      ? React.createElement(Text, { color: "gray" }, "(none)")
      : prs.map((pr) => {
          const ci = pr.statusCheckRollup?.state;
          const color = ci === "SUCCESS" ? "green" : ci === "FAILURE" ? "red" : "gray";
          const sym = ci === "SUCCESS" ? "✓" : ci === "FAILURE" ? "✗" : "·";
          return React.createElement(Box, { key: pr.number, gap: 1 },
            React.createElement(Text, { color }, sym),
            React.createElement(Text, { color: "yellow" }, `#${pr.number}`),
            React.createElement(Text, { wrap: "truncate" }, pr.title.slice(0, 55)),
          );
        }),
  );
}

function TasksPanel({ tasks }: { tasks: string[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true }, "── Tasks (ready) ──"),
    tasks.length === 0
      ? React.createElement(Text, { color: "gray" }, "(empty)")
      : tasks.map((t, i) => React.createElement(Text, { key: i }, t)),
  );
}

function LogsPanel({ lines }: { lines: string[] }) {
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true }, "── Logs (ember) ──"),
    ...lines.slice(-15).map((l, i) => React.createElement(Text, { key: i, color: "gray", wrap: "truncate" }, l)),
  );
}

function TabBar({ active }: { active: Panel }) {
  return React.createElement(Box, { gap: 2 },
    ...PANELS.map((p, i) => React.createElement(Text, { key: p,
      bold: p === active, color: p === active ? "cyan" : "gray" },
      `[${i + 1}]${PANEL_LABELS[p]}`,
    )),
  );
}

// ── App ────────────────────────────────────────────────────────────────────────

export interface TuiOptions {
  mailDir?: string;
  agentId?: string;
  repo?: string;
}

export function TuiApp({ mailDir = join(homedir(), ".tps", "mail"), agentId = "anvil", repo = "tpsdev-ai/cli" }: TuiOptions) {
  const { exit } = useApp();
  const [panel, setPanel] = useState<Panel>("agents");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [mail, setMail] = useState<MailMessage[]>([]);
  const [prs, setPRs] = useState<PullRequest[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setAgents(fetchAgents());
    setMail(fetchMail(mailDir, agentId));
    setPRs(fetchPRs(repo));
    setLogs(fetchLogs("ember"));
    setTasks(fetchTasks());
  }, [tick, mailDir, agentId, repo]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (input === "q") exit();
    if (input === "r") setTick((n) => n + 1);
    if (key.tab) setPanel((p) => PANELS[(PANELS.indexOf(p) + 1) % PANELS.length]);
    if (PANEL_KEYS[input]) setPanel(PANEL_KEYS[input]);
  });

  const content =
    panel === "agents" ? React.createElement(AgentsPanel, { agents }) :
    panel === "mail"   ? React.createElement(MailPanel, { messages: mail }) :
    panel === "tasks"  ? React.createElement(TasksPanel, { tasks }) :
    panel === "prs"    ? React.createElement(PRsPanel, { prs }) :
                         React.createElement(LogsPanel, { lines: logs });

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    React.createElement(TabBar, { active: panel }),
    React.createElement(Box, { flexGrow: 1, paddingTop: 1 }, content),
    React.createElement(Text, { color: "gray" }, "Tab/1-5: panel  r: refresh  q: quit"),
  );
}
