import React from "react";
import { render, Text, Box } from "ink";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveConfigPath, readOpenClawConfig, getAgentList, resolveWorkspace } from "../utils/config.js";
import { randomQuip } from "../utils/output.js";
import { findNono, isNonoStrict, buildNonoArgs } from "../utils/nono.js";

interface RosterProps {
  configPath?: string;
}

function RosterCommand({ configPath: explicitConfig }: RosterProps) {
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
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">📋 No openclaw.json found.</Text>
        <Text dimColor>{randomQuip("empty")}</Text>
      </Box>
    );
  }

  const config = readOpenClawConfig(configPath);
  const agents = getAgentList(config);

  if (agents.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">📋 No agents in roster.</Text>
        <Text dimColor>{randomQuip("empty")}</Text>
      </Box>
    );
  }

  const displayName = (a: typeof agents[0]) => a.name || a.id || "unknown";
  const nameW = Math.max(6, ...agents.map((a) => displayName(a).length + 2));

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>📋 Org Chart</Text>
      <Text> </Text>
      <Box flexDirection="column">
        <Text bold>
          {"  "}
          {"Name".padEnd(nameW)}
          {"Status".padEnd(10)}
          {"Workspace"}
        </Text>
        <Text dimColor>
          {"  "}
          {"─".repeat(nameW)}
          {"─".repeat(10)}
          {"─".repeat(30)}
        </Text>
        {agents.map((agent, i) => {
          const ws = resolveWorkspace(agent, config) || "";
          const wsExists = ws ? existsSync(ws) : false;
          const status = wsExists ? "Active" : ws ? "Missing" : "—";
          const statusColor = wsExists ? "green" : "yellow";
          return (
            <Text key={i}>
              {"  "}
              {displayName(agent).padEnd(nameW)}
              <Text color={statusColor}>{status.padEnd(10)}</Text>
              {ws || "—"}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

export function runRoster(args: RosterProps = {}) {
  // ── Nono re-exec guard ─────────────────────────────────────────────────────
  // TPS_NONO_ACTIVE is set when this process was already re-exec'd under nono.
  // This prevents double-wrapping. It is NOT a security boundary — the nono
  // kernel-level sandbox enforces the actual policy via the tps-roster profile.
  if (!process.env.TPS_NONO_ACTIVE) {
    const nono = findNono();
    if (nono) {
      // roster is read-only; no workdir needed
      const nonoArgs = buildNonoArgs("tps-roster", {}, process.argv);
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
        "⚠️  nono not found — running tps-roster WITHOUT isolation. Install nono: https://nono.sh"
      );
    }
  }

  render(<RosterCommand {...args} />);
}
