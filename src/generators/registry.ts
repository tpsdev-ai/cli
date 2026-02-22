/**
 * Generator registry — unified interface for all runtime generators.
 * Hire calls the registry instead of if/else chains.
 */
import type { TPSReport } from "../schema/report.js";
import { generateWorkspace, writeWorkspace, type GeneratedWorkspace } from "./openclaw.js";
import { generateClaudeCode, writeClaudeCode } from "./claude-code.js";
import { generateOllama, writeOllama } from "./ollama.js";
import { generateCodex, writeCodex } from "./codex.js";

export type Runtime = "openclaw" | "claude-code" | "ollama" | "codex";

export interface GeneratorResult {
  /** Files that were generated (name → content) */
  files: Record<string, string>;
  /** Where the workspace lives */
  workspacePath: string;
  /** Sanitized agent ID */
  agentId: string;
  /** Display name */
  agentName: string;
  /** OpenClaw config entry (only for openclaw runtime) */
  openclawConfig?: Record<string, unknown>;
  /** Ollama model tag (only for ollama runtime) */
  modelTag?: string;
  /** Next steps hint for the user */
  nextSteps: string[];
}

export interface GeneratorOptions {
  name?: string;
  workspace?: string;
  branch?: boolean;
  baseModel?: string;
}

interface Generator {
  generate(report: TPSReport, options: GeneratorOptions): GeneratorResult;
  write(result: GeneratorResult): void;
}

function makeOpenClawGenerator(): Generator {
  return {
    generate(report, options) {
      const gen = generateWorkspace(report, options);
      return {
        files: gen.files,
        workspacePath: gen.workspacePath,
        agentId: String(gen.config.id),
        agentName: String(gen.config.name || gen.config.id),
        openclawConfig: gen.config,
        nextSteps: ["openclaw gateway restart"],
      };
    },
    write(result) {
      // writeWorkspace expects the original GeneratedWorkspace shape
      // We reconstruct it from the result
      writeWorkspace({
        files: result.files,
        workspacePath: result.workspacePath,
        config: result.openclawConfig!,
      });
    },
  };
}

function makeClaudeCodeGenerator(): Generator {
  return {
    generate(report, options) {
      const gen = generateClaudeCode(report, options);
      return {
        files: gen.files,
        workspacePath: gen.workspacePath,
        agentId: gen.agentId,
        agentName: gen.agentName,
        nextSteps: [`cd ${gen.workspacePath}`, "claude"],
      };
    },
    write(result) {
      writeClaudeCode({ files: result.files, workspacePath: result.workspacePath, agentId: result.agentId, agentName: result.agentName });
    },
  };
}

function makeOllamaGenerator(): Generator {
  return {
    generate(report, options) {
      const gen = generateOllama(report, options);
      return {
        files: gen.files,
        workspacePath: gen.workspacePath,
        agentId: gen.agentId,
        agentName: gen.agentName,
        modelTag: gen.modelTag,
        nextSteps: [
          `cd ${gen.workspacePath}`,
          `ollama create ${gen.modelTag} -f Modelfile`,
          `ollama run ${gen.modelTag}`,
        ],
      };
    },
    write(result) {
      writeOllama({ files: result.files, workspacePath: result.workspacePath, agentId: result.agentId, agentName: result.agentName, modelTag: result.modelTag! });
    },
  };
}

function makeCodexGenerator(): Generator {
  return {
    generate(report, options) {
      const gen = generateCodex(report, options);
      return {
        files: gen.files,
        workspacePath: gen.workspacePath,
        agentId: gen.agentId,
        agentName: gen.agentName,
        nextSteps: [`cd ${gen.workspacePath}`, "codex"],
      };
    },
    write(result) {
      writeCodex({ files: result.files, workspacePath: result.workspacePath, agentId: result.agentId, agentName: result.agentName });
    },
  };
}

const generators: Record<Runtime, Generator> = {
  "openclaw": makeOpenClawGenerator(),
  "claude-code": makeClaudeCodeGenerator(),
  "ollama": makeOllamaGenerator(),
  "codex": makeCodexGenerator(),
};

export function getGenerator(runtime: Runtime): Generator {
  const gen = generators[runtime];
  if (!gen) {
    throw new Error(`Unknown runtime: ${runtime}. Valid: ${Object.keys(generators).join(", ")}`);
  }
  return gen;
}

export const VALID_RUNTIMES = Object.keys(generators) as Runtime[];
