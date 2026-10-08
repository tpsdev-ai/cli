import { cliOptionConsumesValue, cliOptionTypes } from "./cli-flags.js";

const RAW_VALUE_FLAGS: Record<string, readonly string[]> = {
  init: ["model", "flair-url"],
  agent: ["model", "flair-url", "display-name", "soul-file", "repo", "message", "pr-title", "scope-warn-threshold"],
  mail: ["type", "retry-after", "max-age", "pr", "status"],
  facts: ["command", "args"],
  memory: ["focus", "tag", "older-than", "flair-url", "durability"],
  bridge: ["adapter", "openclaw-url", "discord-token", "discord-token-file", "discord-channel", "webhook-url", "bridge-agent-id", "default-agent", "mail-dir", "bot-user-id", "require-mention", "discord-poll-ms", "discord-prompt"],
  skill: ["flair-url", "include-rules", "rule-name-format", "registry"],
  flair: ["flair-dir", "auth-mode", "auth-path", "flair-url"],
  secrets: ["window"],
};

export function parseCliArgs(argv: readonly string[]): { requested: boolean; versionRequested: boolean; argv: string[]; guardMode: { check: boolean; noGuard: boolean } } {
  let check = false;
  let noGuard = false;
  const parsed: string[] = [];
  const positionals: string[] = [];
  let requested = false;
  let versionRequested = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [cmd, action] = positionals;
    if (arg === "--") {
      parsed.push(...argv.slice(i));
      break;
    }
    if ((cmd === "secrets-guard" && !arg.startsWith("-")) || (cmd === "office" && action === "exec" && positionals.length === 3)) {
      parsed.push("--", ...argv.slice(i));
      break;
    }
    if ((cmd === "mail" && action === "watch" && arg === "--exec") ||
        (cmd === "agent" && action === "run" && arg === "--message")) {
      parsed.push(arg, "--", ...argv.slice(i + 1));
      break;
    }
    if (cmd === "secrets-guard") {
      if (arg === "--check") check = true;
      else if (arg === "--no-guard") noGuard = true;
      else if (/^--(?:check|no-check|no-guard|no-no-guard|guard|noGuard|no-noGuard|noCheck)(?:=|$)/.test(arg)) {
        throw new Error(`InvalidSecretsGuardMode: ${arg}; use bare --check or --no-guard`);
      }
      if (check && noGuard) throw new Error("InvalidSecretsGuardMode: --check and --no-guard conflict");
      if ((arg === "--check" || arg === "--no-guard") && (argv[i + 1] === "true" || argv[i + 1] === "false")) {
        throw new Error(`InvalidSecretsGuardMode: ${arg} ${argv[i + 1]}; use bare --check or --no-guard`);
      }
    }
    parsed.push(arg);
    if (arg === "--help" || arg === "-h") {
      requested = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      versionRequested = true;
    }
    const rawValue = RAW_VALUE_FLAGS[cmd ?? ""]?.some((name) => arg === `--${name}`);
    const author = cmd === "agent" && action === "commit" && arg === "--author";
    const branch = cmd === "agent" && action === "commit" && arg === "--branch";
    if (cliOptionConsumesValue(arg, argv[i + 1]) || rawValue || author || branch || (cmd === "secrets" && arg === "-n")) {
      if (argv[i + 1] === "--") {
        parsed.push(...argv.slice(i + 1));
        break;
      }
      if (!author && ["-h", "--help", "-v", "--version"].includes(argv[i + 1])) {
        parsed[parsed.length - 1] = `${arg}=${argv[i + 1]}`;
      } else {
        parsed.push(...argv.slice(i + 1, i + (author ? 3 : 2)));
      }
      i += author ? 2 : 1;
    } else if (cliOptionTypes.get(arg) === "boolean") {
      if (argv[i + 1] === "true" || argv[i + 1] === "false") parsed.push(argv[++i]);
    } else if (cmd !== "secrets-guard" && arg.startsWith("-") && !arg.startsWith("--no-") && !arg.includes("=") &&
               argv[i + 1] && !argv[i + 1].startsWith("-")) {
      parsed.push(argv[++i]);
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  return { requested, versionRequested, argv: parsed, guardMode: { check, noGuard } };
}

