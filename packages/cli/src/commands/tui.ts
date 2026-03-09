/**
 * tui.ts — TPS Terminal UI (Phase 2: interactive)
 * ops-90 Phase 2: mail compose, PR actions
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";

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

// ── Interactive mode types ─────────────────────────────────────────────────────

type ComposeField = "to" | "body";
type ComposeState = "idle" | "composing" | "sending" | "done" | "error";

interface ComposeData {
  to: string;
  body: string;
  focusField: ComposeField;
}

type PRAction = "approve" | "merge" | null;

interface PRActionState {
  action: PRAction;
  prNumber: number;
  repo: string;
  confirming: boolean;
}
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
    const out = spawnSync("bun", [tpsBin, "office", "status", "--json"], {
      encoding: "utf-8",
      timeout: 5000,
    }).stdout?.trim() ?? "";
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

function fetchMail(_mailDir: string, agentId: string): MailMessage[] {
  try {
    const tpsBin = join(homedir(), "ops", "tps", "packages", "cli", "bin", "tps.ts");
    const out = spawnSync("bun", [tpsBin, "mail", "list", "--agent", agentId, "--json", "--limit", "15"], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, TPS_AGENT_ID: agentId },
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

// ── Actions ────────────────────────────────────────────────────────────────────

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function sendMailAction(agentId: string, to: string, body: string): { ok: boolean; err?: string } {
  if (!AGENT_NAME_RE.test(to)) return { ok: false, err: `invalid recipient: ${to}` };
  try {
    const tpsBin = join(homedir(), "ops", "tps", "packages", "cli", "bin", "tps.ts");
    const r = spawnSync("bun", [tpsBin, "mail", "send", to, body], {
      encoding: "utf-8",
      timeout: 8000,
      env: { ...process.env, TPS_AGENT_ID: agentId },
    });
    if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || "send failed").slice(0, 80) };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, err: (e as Error).message?.slice(0, 80) ?? "send failed" };
  }
}

function approvePRAction(repo: string, prNumber: number): { ok: boolean; err?: string } {
  if (!REPO_RE.test(repo)) return { ok: false, err: `invalid repo: ${repo}` };
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, err: `invalid PR number: ${prNumber}` };
  try {
    const r = spawnSync("gh-as", ["flint", "pr", "review", String(prNumber), "--repo", repo, "--approve"], {
      encoding: "utf-8",
      timeout: 15000,
    });
    if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || "approve failed").slice(0, 80) };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, err: (e as Error).message?.slice(0, 80) ?? "approve failed" };
  }
}

function mergePRAction(repo: string, prNumber: number): { ok: boolean; err?: string } {
  if (!REPO_RE.test(repo)) return { ok: false, err: `invalid repo: ${repo}` };
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, err: `invalid PR number: ${prNumber}` };
  try {
    const r = spawnSync("gh-as", ["flint", "pr", "merge", String(prNumber), "--repo", repo, "--squash", "--delete-branch"], {
      encoding: "utf-8",
      timeout: 20000,
    });
    if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || "merge failed").slice(0, 80) };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, err: (e as Error).message?.slice(0, 80) ?? "merge failed" };
  }
}

const KNOWN_AGENTS = ["flint", "anvil", "ember", "kern", "sherlock", "pulse", "pixel"];

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

// ── ComposeBar ─────────────────────────────────────────────────────────────────

interface ComposeBarProps {
  data: ComposeData;
  state: ComposeState;
  error: string | null;
  onToChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onTabField: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function ComposeBar({ data, state, error, onToChange, onBodyChange, onTabField, onSubmit, onCancel: _onCancel }: ComposeBarProps) {
  if (state === "sending") {
    return React.createElement(Box, { gap: 1, paddingX: 1, borderStyle: "single", borderColor: "yellow" },
      React.createElement(Text, { color: "yellow" }, "Sending…"),
    );
  }
  if (state === "done") {
    return React.createElement(Box, { gap: 1, paddingX: 1, borderStyle: "single", borderColor: "green" },
      React.createElement(Text, { color: "green" }, `✓ Sent to ${data.to}`),
    );
  }
  if (state === "error") {
    return React.createElement(Box, { gap: 1, paddingX: 1, borderStyle: "single", borderColor: "red" },
      React.createElement(Text, { color: "red" }, `✗ ${error ?? "send failed"}  [Esc to dismiss]`),
    );
  }
  // composing
  return React.createElement(Box, { flexDirection: "column", borderStyle: "single", borderColor: "cyan", paddingX: 1 },
    React.createElement(Box, { gap: 1 },
      React.createElement(Text, { color: data.focusField === "to" ? "cyan" : "gray" }, "To:"),
      React.createElement(TextInput, {
        value: data.to,
        onChange: onToChange,
        onSubmit: onTabField,
        focus: data.focusField === "to",
        placeholder: "agent name",
      }),
      React.createElement(Text, { color: "gray" }, "  Tab to body  Esc cancel"),
    ),
    React.createElement(Box, { gap: 1 },
      React.createElement(Text, { color: data.focusField === "body" ? "cyan" : "gray" }, "Msg:"),
      React.createElement(TextInput, {
        value: data.body,
        onChange: onBodyChange,
        onSubmit: onSubmit,
        focus: data.focusField === "body",
        placeholder: "message body  (Enter to send)",
      }),
    ),
  );
}

// ── PRActionBar ────────────────────────────────────────────────────────────────

interface PRActionBarProps {
  state: PRActionState;
  result: string | null;
  onConfirm: (yes: boolean) => void;
}

function PRActionBar({ state, result, onConfirm: _onConfirm }: PRActionBarProps) {
  const verb = state.action === "approve" ? "Approve" : "Merge";
  const color = state.action === "merge" ? "red" : "yellow";
  if (result) {
    const isErr = result.startsWith("✗");
    return React.createElement(Box, { paddingX: 1, borderStyle: "single", borderColor: isErr ? "red" : "green" },
      React.createElement(Text, { color: isErr ? "red" : "green" }, `${result}  [any key to dismiss]`),
    );
  }
  return React.createElement(Box, { gap: 1, paddingX: 1, borderStyle: "single", borderColor: color },
    React.createElement(Text, { color }, `${verb} PR #${state.prNumber} (${state.repo})?`),
    React.createElement(Text, { color: "white" }, " [y/n]"),
  );
}

// ── Interactive MailPanel ──────────────────────────────────────────────────────

interface MailPanelInteractiveProps {
  messages: MailMessage[];
  selectedIdx: number;
  onSelectChange: (idx: number) => void;
}

function MailPanelInteractive({ messages, selectedIdx, onSelectChange: _onSelectChange }: MailPanelInteractiveProps) {
  if (messages.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── Mail  [c: compose  r: reply] ──"),
      React.createElement(Text, { color: "gray" }, "(inbox empty)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── Mail  [c: compose  r: reply  ↑↓: select] ──"),
    ...messages.slice(0, 8).map((m, i) =>
      React.createElement(Box, { key: m.id, flexDirection: "column", marginBottom: 1 },
        React.createElement(Box, { gap: 2 },
          React.createElement(Text, { color: i === selectedIdx ? "cyan" : "gray" }, i === selectedIdx ? "▶" : " "),
          React.createElement(Text, { color: m.read ? "gray" : "cyan", bold: !m.read }, m.from),
          React.createElement(Text, { color: "gray" }, m.timestamp.slice(5, 16)),
        ),
        React.createElement(Text, { wrap: "truncate", color: i === selectedIdx ? "white" : "gray" },
          `  ${m.body.split("\n")[0]?.slice(0, 88) ?? ""}`),
      ),
    ),
  );
}

// ── Interactive PRsPanel ───────────────────────────────────────────────────────

interface PRsPanelInteractiveProps {
  prs: PullRequest[];
  selectedIdx: number;
  onSelectChange: (idx: number) => void;
}

function PRsPanelInteractive({ prs, selectedIdx }: PRsPanelInteractiveProps) {
  if (prs.length === 0) {
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { bold: true, color: "cyan" }, "── PRs  [a: approve  m: merge] ──"),
      React.createElement(Text, { color: "gray" }, "(none open)"),
    );
  }
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { bold: true, color: "cyan" }, "── PRs  [a: approve  m: merge  ↑↓: select] ──"),
    ...prs.map((pr, i) => {
      const rollup = pr.statusCheckRollup;
      const state = Array.isArray(rollup)
        ? rollup[0]?.state
        : (rollup as { state?: string } | null)?.state;
      const ciColor = state === "SUCCESS" ? "green" : state === "FAILURE" ? "red" : "gray";
      const ciSym = state === "SUCCESS" ? "✓" : state === "FAILURE" ? "✗" : "·";
      const selected = i === selectedIdx;
      return React.createElement(Box, { key: pr.number, gap: 1 },
        React.createElement(Text, { color: selected ? "cyan" : "gray" }, selected ? "▶" : " "),
        React.createElement(Text, { color: ciColor }, ciSym),
        React.createElement(Text, { color: "yellow", bold: selected }, `#${pr.number}`),
        React.createElement(Text, { wrap: "truncate", color: selected ? "white" : "gray" }, pr.title.slice(0, 56)),
      );
    }),
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

function StatusBar({
  lastRefresh,
  error,
  panel,
}: {
  lastRefresh: Date | null;
  error: string | null;
  panel: Panel;
}) {
  const hints =
    panel === "mail" ? "Tab/1-5  r: refresh  c: compose  r: reply  q: quit" :
    panel === "prs"  ? "Tab/1-5  r: refresh  a: approve  m: merge  q: quit" :
    "Tab/1-5: panel  r: refresh  q: quit";
  return React.createElement(Box, { gap: 3, marginTop: 1 },
    React.createElement(Text, { color: "gray" }, hints),
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const refreshing = useRef(false);

  // Selection
  const [mailIdx, setMailIdx] = useState(0);
  const [prIdx, setPRIdx] = useState(0);

  // Compose state
  const [composeState, setComposeState] = useState<ComposeState>("idle");
  const [composeData, setComposeData] = useState<ComposeData>({ to: "", body: "", focusField: "to" });
  const [composeError, setComposeError] = useState<string | null>(null);

  // PR action state
  const [prActionState, setPRActionState] = useState<PRActionState | null>(null);
  const [prActionResult, setPRActionResult] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (refreshing.current) return;
    refreshing.current = true;
    setFetchError(null);
    try {
      setAgents(fetchAgents());
      setMail(fetchMail(mailDir, agentId));
      setPRs(fetchPRs(repo));
      setLogs(fetchLogs("ember"));
      setTasks(fetchTasks());
      setLastRefresh(new Date());
    } catch (e: unknown) {
      setFetchError((e as Error).message ?? "refresh failed");
    } finally {
      refreshing.current = false;
    }
  }, [mailDir, agentId, repo]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Compose submit
  const handleComposeSubmit = useCallback(() => {
    if (!composeData.to.trim() || !composeData.body.trim()) return;
    if (!KNOWN_AGENTS.includes(composeData.to.trim())) {
      setComposeState("error");
      setComposeError(`Unknown agent: ${composeData.to}`);
      return;
    }
    setComposeState("sending");
    const result = sendMailAction(agentId, composeData.to.trim(), composeData.body.trim());
    if (result.ok) {
      setComposeState("done");
      setTimeout(() => {
        setComposeState("idle");
        setComposeData({ to: "", body: "", focusField: "to" });
        refresh();
      }, 1500);
    } else {
      setComposeState("error");
      setComposeError(result.err ?? "send failed");
    }
  }, [composeData, agentId, refresh]);

  // PR action confirm
  const handlePRActionConfirm = useCallback((yes: boolean) => {
    if (!prActionState) return;
    if (!yes) {
      setPRActionState(null);
      setPRActionResult(null);
      return;
    }
    const { action, prNumber, repo: prRepo } = prActionState;
    const result = action === "approve"
      ? approvePRAction(prRepo, prNumber)
      : mergePRAction(prRepo, prNumber);
    const msg = result.ok
      ? `✓ ${action === "approve" ? "Approved" : "Merged"} #${prNumber}`
      : `✗ ${result.err}`;
    setPRActionResult(msg);
    if (result.ok) {
      setTimeout(() => {
        setPRActionState(null);
        setPRActionResult(null);
        refresh();
      }, 2000);
    }
  }, [prActionState, refresh]);

  const resetCompose = useCallback(() => {
    setComposeState("idle");
    setComposeData({ to: "", body: "", focusField: "to" });
    setComposeError(null);
  }, []);

  const handleNav = useCallback((input: string, key: { tab: boolean; upArrow: boolean; downArrow: boolean }) => {
    if (input === "q") exit();
    if (input === "r") refresh();
    if (key.tab) setPanel((p) => PANELS[(PANELS.indexOf(p) + 1) % PANELS.length]);
    const mapped = PANEL_KEYS[input];
    if (mapped) setPanel(mapped);
    if (key.upArrow) {
      if (panel === "mail") setMailIdx((i) => Math.max(0, i - 1));
      if (panel === "prs") setPRIdx((i) => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      if (panel === "mail") setMailIdx((i) => Math.min(mail.length - 1, i + 1));
      if (panel === "prs") setPRIdx((i) => Math.min(prs.length - 1, i + 1));
    }
  }, [exit, refresh, panel, mail.length, prs.length]);

  const handleMailHotkeys = useCallback((input: string) => {
    if (input === "c") {
      setComposeData({ to: "", body: "", focusField: "to" });
      setComposeState("composing");
      return true;
    }
    if (input === "r") {
      const selected = mail[mailIdx];
      if (selected) {
        setComposeData({ to: selected.from, body: "", focusField: "body" });
        setComposeState("composing");
        return true;
      }
    }
    return false;
  }, [mail, mailIdx]);

  const handlePRHotkeys = useCallback((input: string) => {
    const selectedPR = prs[prIdx];
    if (selectedPR && (input === "a" || input === "m")) {
      setPRActionResult(null);
      setPRActionState({
        action: input === "a" ? "approve" : "merge",
        prNumber: selectedPR.number,
        repo,
        confirming: true,
      });
      return true;
    }
    return false;
  }, [prs, prIdx, repo]);

  /** Returns true if the input was consumed by a modal overlay. */
  const handleOverlayInput = useCallback((input: string, key: { escape: boolean }): boolean => {
    if (prActionResult && !prActionState?.confirming) {
      setPRActionState(null); setPRActionResult(null); return true;
    }
    if (prActionState && !prActionResult) {
      if (input === "y" || input === "Y") { handlePRActionConfirm(true); return true; }
      handlePRActionConfirm(false); return true;
    }
    if (composeState === "composing") {
      if (key.escape) resetCompose();
      return true;
    }
    if (composeState === "error" || composeState === "done") {
      if (key.escape || input === "q") resetCompose();
      return true;
    }
    return false;
  }, [prActionResult, prActionState, handlePRActionConfirm, composeState, resetCompose]);

  useInput((input, key) => {
    if (handleOverlayInput(input, key)) return;
    handleNav(input, key);
    if (panel === "mail") handleMailHotkeys(input);
    if (panel === "prs") handlePRHotkeys(input);
  });

  const content =
    panel === "agents" ? React.createElement(AgentsPanel, { agents }) :
    panel === "mail"   ? React.createElement(MailPanelInteractive, { messages: mail, selectedIdx: mailIdx, onSelectChange: setMailIdx }) :
    panel === "tasks"  ? React.createElement(TasksPanel, { tasks }) :
    panel === "prs"    ? React.createElement(PRsPanelInteractive, { prs, selectedIdx: prIdx, onSelectChange: setPRIdx }) :
                         React.createElement(LogsPanel, { lines: logs });

  // Overlay: compose bar or PR action bar
  const overlay =
    composeState !== "idle"
      ? React.createElement(ComposeBar, {
          data: composeData,
          state: composeState,
          error: composeError,
          onToChange: (v: string) => setComposeData((d) => ({ ...d, to: v })),
          onBodyChange: (v: string) => setComposeData((d) => ({ ...d, body: v })),
          onTabField: () => setComposeData((d) => ({ ...d, focusField: d.focusField === "to" ? "body" : "to" })),
          onSubmit: handleComposeSubmit,
          onCancel: () => { setComposeState("idle"); setComposeData({ to: "", body: "", focusField: "to" }); },
        })
      : prActionState
        ? React.createElement(PRActionBar, {
            state: prActionState,
            result: prActionResult,
            onConfirm: handlePRActionConfirm,
          })
        : null;

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(TabBar, { active: panel }),
    React.createElement(Box, { flexGrow: 1, paddingTop: 1, paddingX: 2 }, content),
    overlay,
    React.createElement(StatusBar, { lastRefresh, error: fetchError, panel }),
  );
}
