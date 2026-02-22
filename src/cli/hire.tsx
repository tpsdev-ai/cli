import React, { useState, useEffect } from "react";
import { render, Text, Box } from "ink";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseTPSReport } from "../schema/report.js";
import { getGenerator, type Runtime, VALID_RUNTIMES } from "../generators/registry.js";
import { randomQuip, resolveReportPath } from "../utils/output.js";
import { findNono, isNonoStrict, buildNonoArgs } from "../utils/nono.js";
import { injectAgent } from "../utils/config-inject.js";
import { findOpenClawConfig } from "../utils/config.js";
import { sendMessage } from "../utils/mail.js";

interface HireProps {
  reportPath: string;
  name?: string;
  workspace?: string;
  dryRun: boolean;
  jsonOutput: boolean;
  configPath?: string;
  branch?: boolean;
  inject?: boolean;
  runtime?: Runtime;
  baseModel?: string;
}

interface Step {
  label: string;
  done: boolean;
}

function HireCommand({ reportPath, name, workspace, dryRun, jsonOutput, branch, inject, runtime = "openclaw", baseModel }: HireProps) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [done, setDone] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [injected, setInjected] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);

  const isOpenClaw = runtime === "openclaw";
  const shouldInject = inject !== false && !dryRun && !branch && isOpenClaw;

  useEffect(() => {
    try {
      const resolvedPath = resolveReportPath(reportPath);
      const generator = getGenerator(runtime);

      const allSteps: Step[] = [
        { label: "Parsing TPS report", done: false },
        { label: "Validating schema", done: false },
        { label: `Generating ${runtime} workspace`, done: false },
        { label: dryRun ? "Dry run — skipping write" : "Writing workspace", done: false },
      ];
      if (shouldInject) {
        allSteps.push({ label: "Injecting into openclaw.json", done: false });
        allSteps.push({ label: "Sending onboarding mail", done: false });
      }
      setSteps([...allSteps]);

      const parsed = parseTPSReport(resolvedPath);
      allSteps[0]!.done = true;
      setSteps([...allSteps]);
      setReport(parsed);

      allSteps[1]!.done = true;
      setSteps([...allSteps]);

      // Generate via registry
      const result = generator.generate(parsed, { name, workspace, branch, baseModel });
      allSteps[2]!.done = true;
      setSteps([...allSteps]);

      // Write
      if (!dryRun) {
        generator.write(result);

        // Branch office config (OpenClaw-specific post-write)
        if (branch && result.openclawConfig) {
          const branchRoot = join(process.env.HOME || homedir(), ".tps", "branch-office", result.agentId);
          const dotOpenClaw = join(branchRoot, ".openclaw");
          mkdirSync(dotOpenClaw, { recursive: true });
          const sandboxConfig = { agents: { list: [result.openclawConfig] } };
          writeFileSync(join(dotOpenClaw, "openclaw.json"), JSON.stringify(sandboxConfig, null, 2), "utf-8");
        }
      }
      allSteps[3]!.done = true;
      setSteps([...allSteps]);

      // Config injection + onboarding (OpenClaw only)
      if (shouldInject) {
        const configPath = findOpenClawConfig();
        if (!configPath) throw new Error("Cannot inject — no openclaw.json found");

        const injectResult = injectAgent(configPath, result.openclawConfig as any);
        if (!injectResult.success) throw new Error(`Config injection failed: ${injectResult.error}`);

        setInjected(true);
        setBackupPath(injectResult.backupPath);
        allSteps[4]!.done = true;
        setSteps([...allSteps]);

        // Onboarding mail
        try {
          sendMessage(result.agentId, [
            `Subject: Welcome to the team, ${result.agentName}!`,
            "",
            `You've been hired as a ${parsed.name}. Your workspace is set up at ${result.workspacePath}.`,
            "",
            "Your first steps:",
            "1. Read your SOUL.md — it defines who you are",
            "2. Read your AGENTS.md — it defines how you work",
            `3. Check your mail regularly with: tps mail check ${result.agentId}`,
            `4. Reply to confirm you're online: tps mail send tps-onboard "ready"`,
            "",
            "Welcome aboard.",
            "— TPS",
          ].join("\n"), "tps-onboard");
          setOnboarded(true);
        } catch { /* best-effort */ }
        allSteps[5]!.done = true;
        setSteps([...allSteps]);
      }

      setConfig(isOpenClaw
        ? result.openclawConfig || {}
        : { runtime, agentId: result.agentId, agentName: result.agentName, workspacePath: result.workspacePath, files: Object.keys(result.files), ...(result.modelTag ? { modelTag: result.modelTag } : {}), nextSteps: result.nextSteps }
      );
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">❌ {error}</Text>
        <Text dimColor>{"\n"}{randomQuip("error")}</Text>
      </Box>
    );
  }

  if (jsonOutput && done && config) {
    return <Text>{JSON.stringify(config, null, 2)}</Text>;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>🏢 Onboarding new agent...</Text>
      <Text> </Text>

      {report && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>Name: <Text bold>{name || report.identity.default_name}</Text></Text>
          <Text>Role: <Text bold>{report.name}</Text></Text>
          {report.flair.length > 0 && (
            <Text>Flair: <Text color="yellow">{report.flair.length} pieces</Text> ({report.flair.join(", ")})</Text>
          )}
        </Box>
      )}

      {steps.map((step, i) => (
        <Text key={i}>
          {step.done ? <Text color="green">✅</Text> : <Text color="gray">⏳</Text>}
          {" "}{step.label}
        </Text>
      ))}

      {done && config && !injected && isOpenClaw && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>📋 Add this to your openclaw.json agents.list array:</Text>
          <Text> </Text>
          <Text>{JSON.stringify(config, null, 2)}</Text>
          <Text> </Text>
          <Text dimColor italic>{randomQuip("success")}</Text>
        </Box>
      )}

      {done && config && injected && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green" bold>✅ Agent config injected into openclaw.json</Text>
          {backupPath && <Text dimColor>   Backup: {backupPath}</Text>}
          {onboarded && <Text color="green">✅ Onboarding mail sent</Text>}
          <Text> </Text>
          <Text bold>Next: restart OpenClaw gateway to activate the agent.</Text>
          <Text dimColor>   openclaw gateway restart</Text>
          <Text> </Text>
          <Text dimColor italic>{randomQuip("success")}</Text>
        </Box>
      )}

      {done && config && !isOpenClaw && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green" bold>✅ {runtime} workspace ready</Text>
          <Text dimColor>   Path: {(config as any).workspacePath}</Text>
          <Text dimColor>   Files: {((config as any).files || []).join(", ")}</Text>
          {((config as any).nextSteps || []).length > 0 && (
            <Box flexDirection="column">
              <Text> </Text>
              <Text bold>Next:</Text>
              {((config as any).nextSteps as string[]).map((step: string, i: number) => (
                <Text key={i} dimColor>   {step}</Text>
              ))}
            </Box>
          )}
          <Text> </Text>
          <Text dimColor italic>{randomQuip("success")}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Built-in persona names — not file paths, no existence check needed. */
const BUILTIN_PERSONAS = ["developer", "designer", "support", "ea", "ops", "strategy", "security"];

export function runHire(args: HireProps) {
  // Always enforce --branch boundary, even if TPS_NONO_ACTIVE is externally set.
  // Branch mode has no nono fallback, so this validation cannot depend on re-exec state.
  if (args.workspace && args.branch) {
    const resolved = resolve(args.workspace);
    const boundary = resolve(homedir() + "/.tps/branch-office");
    if (!resolved.startsWith(boundary + "/")) {
      console.error(`❌ Workspace must be inside ~/.tps/branch-office/ (subdirectory only). Got: ${args.workspace}`);
      process.exit(1);
    }
  }

  // ── Nono re-exec guard ─────────────────────────────────────────────────────
  // TPS_NONO_ACTIVE is set when this process was already re-exec'd under nono.
  // This prevents double-wrapping. It is NOT a security boundary — the nono
  // kernel-level sandbox enforces the actual policy via the tps-hire profile.
  if (!process.env.TPS_NONO_ACTIVE) {
    // Validate report path BEFORE re-exec so errors surface outside the sandbox
    if (args.reportPath && !BUILTIN_PERSONAS.includes(args.reportPath)) {
      const resolved = resolve(args.reportPath);
      if (!existsSync(resolved)) {
        console.error(`❌ TPS report not found: ${args.reportPath}`);
        process.exit(1);
      }
    }

    // Validate non-branch workspace boundary.
    if (args.workspace && !args.branch) {
      const resolved = resolve(args.workspace);
      const boundary = resolve(homedir() + "/.openclaw");
      if (!resolved.startsWith(boundary + "/")) {
        console.error(`❌ Workspace must be inside ~/.openclaw/ (subdirectory only). Got: ${args.workspace}`);
        process.exit(1);
      }
    }

    // --branch runs inside sandbox model; skip nono re-exec.
    if (args.branch) {
      render(<HireCommand {...args} />);
      return;
    }

    const nono = findNono();
    if (nono) {
      const workdir = args.workspace ? resolve(args.workspace) : undefined;
      const nonoArgs = buildNonoArgs("tps-hire", { workdir }, process.argv);
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
        "⚠️  nono not found — running tps-hire WITHOUT isolation. Install nono: https://nono.sh"
      );
    }
  }

  render(<HireCommand {...args} />);
}
