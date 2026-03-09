/**
 * tui.ts — TPS Terminal UI (Phase 1: read-only dashboard)
 * ops-90
 */
import { spawnSync } from "node:child_process";
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
  reviewDecision?: string | null;
  mergeable?: string | null;
  isDraft?: boolean;
  statusCheckRollup?: Array<{ state: string }> | { state: string } | null;
}

type SyncRunner = (
  cmd: string,
  args: string[],
  options?: { encoding?: BufferEncoding; timeout?: number; stdio?: "inherit" | "pipe"; env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer };

interface CommandResult {
  ok: boolean;
  output: string;
  error?: string;
}

interface ComposeState {
  mode: "compose";
  field: "to" | "body";
  to: string;
  body: string;
}

interface MergeConfirmState {
  mode: "confirm-merge";
  pr: PullRequest;
}

interface DiffState {
  mode: "diff";
  pr: PullRequest;
  lines: string[];
}

type OverlayState = ComposeState | MergeConfirmState | DiffState | null;

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
    const out = runCmd("bun", [tpsBin, "office", "status", "--json"]);
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
    const out = spawnSync("bun", [tpsBin, "mail", "list", "--agent", agentId, "--json", "--limit", "15"], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, TPS_AGENT_ID: agentId, TPS_MAIL_DIR: mailDir },
    }).stdout?.trim() ?? "";
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
      "--json", "number,title,author,statusCheckRollup,reviewDecision,mergeable,isDraft", "--limit", "10",
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

function getPrCheckState(pr: PullRequest): string | undefined {
  const rollup = pr.statusCheckRollup;
  return Array.isArray(rollup)
    ? rollup[0]?.state
    : (rollup as { state?: string } | null)?.state;
}

export function getMergeWarnings(pr: PullRequest): string[] {
  const warnings: string[] = [];
  if (pr.isDraft) warnings.push("draft PR");
  if (pr.mergeable && pr.mergeable !== "MERGEABLE") warnings.push(`not mergeable (${pr.mergeable.toLowerCase()})`);
  const checkState = getPrCheckState(pr);
  if (checkState && checkState !== "SUCCESS") warnings.push(`checks ${checkState.toLowerCase()}`);
  if (!pr.reviewDecision || pr.reviewDecision === "REVIEW_REQUIRED") warnings.push("no approvals");
  return warnings;
}

function runInteractiveCommand(
  cmd: string,
  args: string[],
  spawnSyncImpl: SyncRunner = spawnSync,
): CommandResult {
  const result = spawnSyncImpl(cmd, args, { encoding: "utf-8", timeout: 15_000 });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : result.stdout?.toString("utf-8").trim() ?? "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : result.stderr?.toString("utf-8").trim() ?? "";
  if (result.status === 0) {
    return { ok: true, output: stdout };
  }
  const error = stderr || stdout || `${cmd} failed`;
  return { ok: false, output: stdout, error };
}

export function sendTuiMail(
  to: string,
  body: string,
  spawnSyncImpl: SyncRunner = spawnSync,
): CommandResult {
  return runInteractiveCommand("tps", ["mail", "send", to, body], spawnSyncImpl);
}

export function approvePr(
  repo: string,
  prNumber: number,
  spawnSyncImpl: SyncRunner = spawnSync,
): CommandResult {
  return runInteractiveCommand("gh-as", ["flint", "pr", "review", String(prNumber), "--repo", repo, "--approve"], spawnSyncImpl);
}

export function mergePr(
  repo: string,
  prNumber: number,
  spawnSyncImpl: SyncRunner = spawnSync,
): CommandResult {
  return runInteractiveCommand("gh-as", ["flint", "pr", "merge", String(prNumber), "--repo", repo, "--squash"], spawnSyncImpl);
}

export function loadPrDiff(
  repo: string,
  prNumber: number,
  spawnSyncImpl: SyncRunner = spawnSync,
): CommandResult {
  return runInteractiveCommand("gh-as", ["flint", "pr", "diff", String(prNumber), "--repo", repo], spawnSyncImpl);
}

function getAutocompleteAgents(agents: AgentStatus[], value: string): string[] {
  const needle = value.trim().toLowerCase();
  const ids = agents.map((agent) => agent.id);
  if (!needle) return ids.slice(0, 5);
  return ids.filter((id) => id.toLowerCase().startsWith(needle)).slice(0, 5);
}

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

function MailPanel({ messages, selectedIndex }: { messages: MailMessage[]; selectedIndex: number }) {
  if (messages.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── Mail ──"),
      React.createElement(Text, { color: "gray" }, "(inbox empty)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── Mail ──"),
    ...messages.slice(0, 8).map((m, index) =>
      React.createElement(Box, { key: m.id, flexDirection: "column", marginBottom: 1 },
        React.createElement(Box, { gap: 2 },
          React.createElement(Text, { color: index === selectedIndex ? "yellow" : "gray" }, index === selectedIndex ? ">" : " "),
          React.createElement(Text, { color: m.read ? "gray" : "cyan", bold: !m.read }, m.from),
          React.createElement(Text, { color: "gray" }, m.timestamp.slice(5, 16)),
        ),
        React.createElement(Text, { wrap: "truncate", color: "white" },
          m.body.split("\n")[0]?.slice(0, 90) ?? ""),
      ),
    ),
  );
}

function PRsPanel({ prs, selectedIndex }: { prs: PullRequest[]; selectedIndex: number }) {
  if (prs.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── PRs ──"),
      React.createElement(Text, { color: "gray" }, "(none open)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── PRs ──"),
    ...prs.map((pr, index) => {
      const state = getPrCheckState(pr);
      const color = state === "SUCCESS" ? "green" : state === "FAILURE" ? "red" : "gray";
      const sym = state === "SUCCESS" ? "✓" : state === "FAILURE" ? "✗" : "·";
      return React.createElement(Box, { key: pr.number, gap: 1 },
        React.createElement(Text, { color: index === selectedIndex ? "yellow" : "gray" }, index === selectedIndex ? ">" : " "),
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
    React.createElement(Text, { bold: true, color: "cyan" }, "── Logs ──"),
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
    React.createElement(Text, { color: "gray" }, "Tab/1-5: panel  j/k: move  c: compose  r: refresh/reply  q: quit"),
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
  const [notice, setNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [mailIndex, setMailIndex] = useState(0);
  const [prIndex, setPrIndex] = useState(0);
  const refreshing = useRef(false);

  const refresh = useCallback(() => {
    if (refreshing.current) return;
    refreshing.current = true;
    setError(null);
    try {
      setAgents(fetchAgents());
      setMail(fetchMail(mailDir, agentId));
      setPRs(fetchPRs(repo));
      setLogs(fetchLogs(agentId));
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

  useEffect(() => {
    setMailIndex((value) => Math.min(value, Math.max(mail.length - 1, 0)));
  }, [mail.length]);

  useEffect(() => {
    setPrIndex((value) => Math.min(value, Math.max(prs.length - 1, 0)));
  }, [prs.length]);

  useInput((input, key) => {
    if (overlay?.mode === "diff") {
      if (key.escape || key.return) setOverlay(null);
      return;
    }

    if (overlay?.mode === "confirm-merge") {
      if (input.toLowerCase() === "y") {
        const warnings = getMergeWarnings(overlay.pr);
        const result = mergePr(repo, overlay.pr.number);
        if (result.ok) {
          setNotice(`Merged PR #${overlay.pr.number}${warnings.length > 0 ? ` (${warnings.join(", ")})` : ""}`);
          setOverlay(null);
          refresh();
        } else {
          setError(result.error ?? `Failed to merge PR #${overlay.pr.number}`);
          setOverlay(null);
        }
        return;
      }
      if (input.toLowerCase() === "n" || key.escape) {
        setOverlay(null);
      }
      return;
    }

    if (overlay?.mode === "compose") {
      if (key.escape) {
        setOverlay(null);
        return;
      }
      if (key.tab) {
        if (overlay.field === "to") {
          const matches = getAutocompleteAgents(agents, overlay.to);
          const topMatch = matches[0];
          if (topMatch && topMatch !== overlay.to) {
            setOverlay({ ...overlay, to: topMatch });
            return;
          }
        }
        setOverlay({
          ...overlay,
          field: overlay.field === "to" ? "body" : "to",
        });
        return;
      }
      if (key.backspace || key.delete) {
        const target = overlay.field === "to" ? overlay.to : overlay.body;
        const nextValue = target.slice(0, -1);
        setOverlay(overlay.field === "to"
          ? { ...overlay, to: nextValue }
          : { ...overlay, body: nextValue });
        return;
      }
      if (key.return) {
        if (!overlay.to.trim() || !overlay.body.trim()) {
          setError("Recipient and body are required");
          return;
        }
        const result = sendTuiMail(overlay.to.trim(), overlay.body);
        if (result.ok) {
          setNotice(`Sent mail to ${overlay.to.trim()}`);
          setOverlay(null);
          refresh();
        } else {
          setError(result.error ?? "Failed to send mail");
        }
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        setOverlay(overlay.field === "to"
          ? { ...overlay, to: overlay.to + input }
          : { ...overlay, body: overlay.body + input });
      }
      return;
    }
    if (input === "q") exit();
    if (input === "r" && panel !== "mail") refresh();
    if (key.tab) setPanel((p) => PANELS[(PANELS.indexOf(p) + 1) % PANELS.length]);
    const mapped = PANEL_KEYS[input];
    if (mapped) setPanel(mapped);
    if (input === "j" || key.downArrow) {
      if (panel === "mail") setMailIndex((value) => Math.min(value + 1, Math.max(mail.length - 1, 0)));
      if (panel === "prs") setPrIndex((value) => Math.min(value + 1, Math.max(prs.length - 1, 0)));
    }
    if (input === "k" || key.upArrow) {
      if (panel === "mail") setMailIndex((value) => Math.max(value - 1, 0));
      if (panel === "prs") setPrIndex((value) => Math.max(value - 1, 0));
    }
    if (input === "c") {
      setOverlay({ mode: "compose", field: "to", to: "", body: "" });
      setError(null);
      return;
    }
    if (input === "r" && panel === "mail" && mail[mailIndex]) {
      setOverlay({ mode: "compose", field: "body", to: mail[mailIndex]?.from ?? "", body: "" });
      setError(null);
      return;
    }
    if (panel === "prs" && input === "a" && prs[prIndex]) {
      const selectedPr = prs[prIndex];
      const result = approvePr(repo, selectedPr.number);
      if (result.ok) {
        setNotice(`Approved PR #${selectedPr.number}`);
        refresh();
      } else {
        setError(result.error ?? `Failed to approve PR #${selectedPr.number}`);
      }
      return;
    }
    if (panel === "prs" && input === "m" && prs[prIndex]) {
      setOverlay({ mode: "confirm-merge", pr: prs[prIndex] });
      return;
    }
    if (panel === "prs" && key.return && prs[prIndex]) {
      const selectedPr = prs[prIndex];
      const result = loadPrDiff(repo, selectedPr.number);
      if (result.ok) {
        setOverlay({
          mode: "diff",
          pr: selectedPr,
          lines: result.output.split("\n").slice(0, 20),
        });
      } else {
        setError(result.error ?? `Failed to load diff for PR #${selectedPr.number}`);
      }
    }
  });

  const content =
    panel === "agents" ? React.createElement(AgentsPanel, { agents }) :
    panel === "mail"   ? React.createElement(MailPanel, { messages: mail, selectedIndex: mailIndex }) :
    panel === "tasks"  ? React.createElement(TasksPanel, { tasks }) :
    panel === "prs"    ? React.createElement(PRsPanel, { prs, selectedIndex: prIndex }) :
                         React.createElement(LogsPanel, { lines: logs });

  const composeSuggestions = overlay?.mode === "compose" ? getAutocompleteAgents(agents, overlay.to) : [];

  const overlayNode =
    overlay?.mode === "compose"
      ? React.createElement(Box, { flexDirection: "column", paddingX: 1 },
          React.createElement(Text, { color: "cyan", bold: true }, "Compose"),
          React.createElement(Text, { color: overlay.field === "to" ? "yellow" : "white" }, `To: ${overlay.to || "_"}`),
          React.createElement(Text, { color: overlay.field === "body" ? "yellow" : "white", wrap: "wrap" }, `Body: ${overlay.body || "_"}`),
          React.createElement(Text, { color: "gray" }, `Matches: ${composeSuggestions.join(", ") || "(none)"}`),
          React.createElement(Text, { color: "gray" }, "Tab: autocomplete/switch  Enter: send  Esc: cancel"),
        )
      : overlay?.mode === "confirm-merge"
        ? React.createElement(Box, { flexDirection: "column", paddingX: 1 },
            React.createElement(Text, { color: "yellow", bold: true }, `Merge PR #${overlay.pr.number}?`),
            React.createElement(Text, null, overlay.pr.title),
            React.createElement(Text, { color: getMergeWarnings(overlay.pr).length > 0 ? "yellow" : "gray" },
              getMergeWarnings(overlay.pr).length > 0 ? `Warnings: ${getMergeWarnings(overlay.pr).join(", ")}` : "No merge warnings"),
            React.createElement(Text, { color: "gray" }, "y: merge  n/Esc: cancel"),
          )
        : overlay?.mode === "diff"
          ? React.createElement(Box, { flexDirection: "column", paddingX: 1 },
              React.createElement(Text, { color: "cyan", bold: true }, `PR #${overlay.pr.number} diff`),
              ...overlay.lines.map((line, index) =>
                React.createElement(Text, { key: `${overlay.pr.number}-${index}`, wrap: "truncate", color: "white" }, line || " "),
              ),
              React.createElement(Text, { color: "gray" }, "Enter/Esc: close"),
            )
          : null;

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(TabBar, { active: panel }),
    React.createElement(Box, { flexGrow: 1, paddingTop: 1, paddingX: 2 }, content),
    overlayNode,
    React.createElement(StatusBar, { lastRefresh, error: error ?? notice }),
  );
}
