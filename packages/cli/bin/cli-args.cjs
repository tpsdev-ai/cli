// @ts-check
const launchFlagDefinitions = /** @type {const} */ ({
  sandboxRequired: { type: "boolean", default: false },
});

const cliFlagDefinitions = /** @type {const} */ ({
  reason: { type: "string" },
  expiresIn: { type: "string" },
  trust: { type: "string" },
  pubkey: { type: "string" },
  encPubkey: { type: "string" },
  name: { type: "string" },
  workspace: { type: "string" },
  dryRun: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  config: { type: "string" },
  deep: { type: "boolean", default: false },
  summary: { type: "string" },
  channel: { type: "string" },
  branch: { type: "boolean", default: false },
  manifest: { type: "string" },
  soundstage: { type: "boolean", default: false },
  quietNonoCheck: { type: "boolean", default: false },
  nonono: { type: "boolean", default: false },
  ...launchFlagDefinitions,
  inject: { type: "boolean", default: true },
  runtime: { type: "string", default: "openclaw" },
  baseModel: { type: "string" },
  since: { type: "string" },
  limit: { type: "number" },
  interval: { type: "number" },
  daemon: { type: "string" },
  from: { type: "string" },
  clone: { type: "boolean", default: false },
  overwrite: { type: "boolean", default: false },
  schedule: { type: "string" },
  keep: { type: "number" },
  sanitize: { type: "boolean", default: true },
  listen: { type: "number" },
  host: { type: "string" },
  force: { type: "boolean", default: false },
  follow: { type: "boolean", default: false },
  lines: { type: "number" },
  transport: { type: "string" },
  port: { type: "number" },
  autoPrune: { type: "boolean", default: false },
  prune: { type: "boolean", default: false },
  staleMinutes: { type: "number" },
  offlineHours: { type: "number" },
  shared: { type: "boolean", default: false },
  cost: { type: "boolean", default: false },
  costs: { type: "boolean", default: false },
  today: { type: "boolean", default: false },
  agent: { type: "string" },
  statusOverride: { type: "string" },
  desc: { type: "string" },
  id: { type: "string" },
  fromBeginning: { type: "boolean", default: false },
  count: { type: "boolean", default: false },
  priority: { type: "string" },
  version: { type: "string" },
  verbose: { type: "boolean", default: false },
  tunnelVia: { type: "string" },
  keepUnits: { type: "boolean", default: false },
  noFlair: { type: "boolean", default: false },
  forceReinstallFlair: { type: "boolean", default: false },
  purgeFlair: { type: "boolean", default: false },
  apply: { type: "boolean", default: false },
  expires: { type: "string" },
  expiresWithin: { type: "string" },
  fix: { type: "boolean", default: false },
  flairKeysDir: { type: "string" },
  identityDir: { type: "string" },
  keysDir: { type: "string" },
  nonInteractive: { type: "boolean", default: false },
  owner: { type: "string" },
  path: { type: "string" },
  scope: { type: "string" },
  secretsDir: { type: "string" },
  sensitivity: { type: "string" },
  credType: { type: "string" },
  check: { type: "boolean", default: false },
  noGuard: { type: "boolean", default: false },
  staleOnly: { type: "boolean", default: false },
  root: { type: "string" },
  failOnDrift: { type: "boolean", default: false },
  noVerify: { type: "boolean", default: false },
  verifyPreview: { type: "boolean", default: false },
  task: { type: "string" },
  taskId: { type: "string" },
  title: { type: "string" },
  spec: { type: "string" },
  output: { type: "string" },
  taskContext: { type: "string" },
  stdin: { type: "boolean", default: false },
  unsigned: { type: "boolean", default: false },
  replyTo: { type: "string" },
  messageId: { type: "string" },
});

const cliOptionTypes = new Map(
  Object.entries(cliFlagDefinitions).flatMap(([name, flag]) =>
    [...new Set([name, name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)])]
      .map((spelling) => [`--${spelling}`, flag.type])
  )
);

/** @param {string} arg @param {string | undefined} next */
function cliOptionConsumesValue(arg, next) {
  const type = cliOptionTypes.get(arg);
  return type !== undefined && type !== "boolean" && next !== undefined &&
    (!next.startsWith("-") || /^-([0-9]+(\.[0-9]+)?|\.[0-9]+)$/.test(next) || next === "--help" || next === "-h" || next === "--version" || next === "-v");
}

/** @type {Record<string, readonly string[]>} */
const RAW_VALUE_FLAGS = {
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

/** @param {readonly string[]} argv */
function parseCliArgs(argv) {
  let check = false;
  let noGuard = false;
  /** @type {string[]} */
  const parsed = [];
  /** @type {string[]} */
  const positionals = [];
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


module.exports = { launchFlagDefinitions, cliFlagDefinitions, cliOptionTypes, cliOptionConsumesValue, parseCliArgs };
