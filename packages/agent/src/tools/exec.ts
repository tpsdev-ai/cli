import { spawn } from "node:child_process";
import { BoundaryManager } from "../governance/boundary.js";
import type { Tool } from "./registry.js";
import type { ToolResult } from "../runtime/types.js";

interface ExecArgs {
  command: string;
  args?: string[];
  cwd?: string;
}

function sanitizeOutput(data: unknown): string {
  if (!data) return "";
  return String(data);
}

export function makeExecTool(boundary: BoundaryManager, allowlist: string[] = []): Tool {
  const safeAllow = allowlist.map((c) => c.toLowerCase());

  return {
    name: "exec",
    description: "Execute a command.\nInput: {\"command\": string, \"args\": string[] (optional)",
    input_schema: {
      command: { type: "string", description: "Executable name" },
      args: { type: "array", description: "Arguments to pass" },
      cwd: { type: "string", description: "Optional cwd relative to workspace" },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const payload = (args as unknown) as unknown as ExecArgs;
      if (typeof payload.command !== "string") {
        return { content: "exec tool requires command string", isError: true };
      }

      const command = payload.command;
      const cmdArgs = Array.isArray(payload.args)
        ? payload.args.map((entry) => String(entry))
        : [];

      const normalized = command.toLowerCase();
      if (safeAllow.length > 0 && !safeAllow.includes(normalized)) {
        return { content: `Command not allowed: ${command}`, isError: true };
      }

      try {
        boundary.validateCommand(normalized, cmdArgs);
      } catch (err: any) {
        return { content: `exec blocked: ${err?.message ?? String(err)}`, isError: true };
      }

      const cwd = payload.cwd ? boundary.resolveWorkspacePath(payload.cwd) : undefined;
      const env = boundary.scrubEnvironment(["ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST", "OLLAMA_API_KEY"]);

      return new Promise<ToolResult>((resolve) => {
        const child = spawn(normalized, cmdArgs, {
          cwd,
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk) => {
          stdout += sanitizeOutput(chunk);
        });

        child.stderr?.on("data", (chunk) => {
          stderr += sanitizeOutput(chunk);
        });

        child.on("error", (err) => {
          resolve({
            content: `exec failed: ${sanitizeOutput(err?.message)}`,
            isError: true,
          });
        });

        child.on("close", (code) => {
          if (code === 0) {
            resolve({ content: stdout || "(no output)", isError: false });
          } else {
            resolve({
              content: `exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              isError: true,
            });
          }
        });
      });
    },
  };
}
