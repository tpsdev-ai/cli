import React from "react";
import { render, Text, Box } from "ink";
import { spawnSync } from "node:child_process";
import { resolveConfigPath, readOpenClawConfig, getAgentList, resolveWorkspace } from "../utils/config.js";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { formatBytes, randomQuip } from "../utils/output.js";
import { findNono, isNonoStrict, buildNonoArgs, type NonoProfile } from "../utils/nono.js";
import { getAgentInfo } from "../utils/agent-info.js";

interface ReviewProps {
  agentName: string;
  configPath?: string;
  /** Use tps-review-deep profile (LLM-assisted, network allowed). Default: tps-review-local. */
  deep?: boolean;
}

function ReviewCommand({ agentName, configPath: explicitConfig }: ReviewProps) {
  let configPath: string | null;
  try {
    configPath = resolveConfigPath(explicitConfig);
  } catch (e: any) {
    return (
      <Box padding={1}>
        <Text color="red">❌ {e.message}</Text>
      </Box>
    );
  }

  if (!configPath) {
    return (
      <Box padding={1}>
        <Text color="red">No openclaw.json found. {randomQuip("error")}</Text>
      </Box>
    );
  }

  const config = readOpenClawConfig(configPath);
  const agents = getAgentList(config);
  const agent = agents.find(
    (a) =>
      a.id?.toLowerCase() === agentName.toLowerCase() ||
      a.name?.toLowerCase() === agentName.toLowerCase()
  );

  if (!agent) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Agent "{agentName}" not found in roster.</Text>
        <Text dimColor>What exactly would you say... {agentName} does here?</Text>
      </Box>
    );
  }

  const ws = resolveWorkspace(agent, config);
  const wsExists = ws ? existsSync(ws) : false;

  let files: { name: string; size: number }[] = [];
  if (ws && wsExists) {
    try {
      const entries = readdirSync(ws);
      files = entries
        .filter((e) => {
          try { return statSync(join(ws, e)).isFile(); } catch { return false; }
        })
        .map((e) => ({
          name: e,
          size: statSync(join(ws, e)).size,
        }));
    } catch { /* ignore */ }
  }

  const info = getAgentInfo(agent.id, ws || undefined);
  const label = info.profile.emoji
    ? `${info.profile.emoji} ${agent.name || agent.id}`
    : agent.name || agent.id;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>📋 Performance Review — {label}</Text>
      <Text> </Text>
      <Text>ID: {agent.id}</Text>
      {agent.name && <Text>Name: {agent.name}</Text>}
      {info.profile.role && <Text>Role: {info.profile.role}</Text>}
      {info.profile.vibe && <Text>Vibe: {info.profile.vibe}</Text>}
      {agent.model && <Text>Model: {typeof agent.model === "object" ? JSON.stringify(agent.model) : agent.model}</Text>}
      <Text>Workspace: {ws || "—"}</Text>
      <Text> </Text>

      <Box flexDirection="column">
        <Text bold>📬 Mail:</Text>
        {info.mail.total > 0 ? (
          <Text>  {info.mail.unread} unread, {info.mail.read} read ({info.mail.total} total)</Text>
        ) : (
          <Text dimColor>  No messages</Text>
        )}
      </Box>
      <Text> </Text>

      <Box flexDirection="column">
        <Text bold>🧠 Memory:</Text>
        {info.memory.fileCount > 0 ? (
          <Box flexDirection="column">
            <Text>  {info.memory.fileCount} journal{info.memory.fileCount !== 1 ? "s" : ""}</Text>
            {info.memory.latestDate && <Text>  Latest: {info.memory.latestDate}</Text>}
          </Box>
        ) : (
          <Text dimColor>  No journal files</Text>
        )}
      </Box>
      <Text> </Text>

      {files.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>📁 Files:</Text>
          {files.map((f, i) => (
            <Text key={i}>
              {"  "}<Text color="green">✅</Text> {f.name} <Text dimColor>({formatBytes(f.size)})</Text>
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>No workspace files found. {randomQuip("empty")}</Text>
      )}
    </Box>
  );
}

export function runReview(args: ReviewProps) {
  // ── Nono re-exec guard ─────────────────────────────────────────────────────
  // TPS_NONO_ACTIVE is set when this process was already re-exec'd under nono.
  // This prevents double-wrapping. It is NOT a security boundary — the nono
  // kernel-level sandbox enforces the actual policy via the tps-review-* profile.
  if (!process.env.TPS_NONO_ACTIVE) {
    // Pre-resolve agent workspace BEFORE re-exec so path errors surface outside
    // the sandbox with a clear message (Sherlock: validate workspace path first).
    let agentWorkspace: string | undefined;
    try {
      const configPath = resolveConfigPath(args.configPath);
      if (configPath) {
        const config = readOpenClawConfig(configPath);
        const agents = getAgentList(config);
        const agent = agents.find(
          (a) =>
            a.id?.toLowerCase() === args.agentName.toLowerCase() ||
            a.name?.toLowerCase() === args.agentName.toLowerCase()
        );
        if (agent) {
          const ws = resolveWorkspace(agent, config);
          if (ws && existsSync(ws)) {
            agentWorkspace = ws;
          } else if (ws) {
            // Workspace referenced in config but directory is missing — fail now,
            // not silently inside the sandbox where the error is harder to read.
            console.error(`❌ Agent workspace does not exist: ${ws}`);
            process.exit(1);
          }
        }
      }
    } catch {
      // Config resolution failed — let ReviewCommand render the proper error UI
    }

    const profile: NonoProfile = args.deep ? "tps-review-deep" : "tps-review-local";
    const nono = findNono();
    if (nono) {
      const nonoArgs = buildNonoArgs(profile, { workdir: agentWorkspace }, process.argv);
      const result = spawnSync(nono, nonoArgs, {
        stdio: "inherit",
        env: { ...process.env, TPS_NONO_ACTIVE: "1" },
      });
      process.exit(result.status ?? 1);
    } else if (isNonoStrict()) {
      console.error(
        "❌ nono is not installed but TPS_NONO_STRICT=1. Install nono: https://nono.sh"
      );
      process.exit(1);
    } else {
      console.warn(
        `⚠️  nono not found — running tps-review WITHOUT isolation. Install nono: https://nono.sh`
      );
    }
  }

  render(<ReviewCommand {...args} />);
}
