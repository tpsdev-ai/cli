#!/usr/bin/env node
import meow from "meow";

const cli = meow(
  `
  Usage
    $ tps <command> [options]

  Commands
    hire <report>     Onboard a new agent from a .tps report or persona
    roster <action>   Agent directory (list/show/find)
    review <name>     Performance review for a specific agent
    office <action>   Branch office sandbox lifecycle (start/stop/list/status/kill)
    context <action>  Workstream context memory (read/update/list)
    mail <action>     Mailroom operations (send/check/list/search)
    identity <action> Key management (init/show/register/list/revoke/verify)
    secrets <action>  Secret management (set/list/remove)
    git <action>      Git utilities (worktree)
    branch <action>   Branch office node (init/start/stop/status/log)

  Options
    --help            Show this help text
    --version         Show version number
    --config <path>   Path to openclaw.json (default: auto-discover)

  Examples
    $ tps hire developer --name Fred
    $ tps hire ./reports/strategy-lead.tps --dry-run
    $ tps hire developer --name Scout --runtime claude-code
    $ tps hire ops --name Monitor --runtime ollama --base-model llama3.1:8b
    $ tps hire developer --name Coder --runtime codex
    $ tps roster list
    $ tps roster show flint --json
    $ tps roster find --channel discord
    $ tps roster list --config ~/custom/openclaw.json
    $ tps mail send kern "hi"
    $ tps mail check kern
    $ tps mail log --limit 10
    $ tps mail log flint --since 2026-02-20
    $ tps office start branch-a
    $ tps office status branch-a
    $ tps review flint

  Built-in personas: developer, designer, support, ea, ops, strategy, security

  If you could just go ahead and use the correct command, that'd be great.
`,
  {
    importMeta: import.meta,
    flags: {
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
      nonono: { type: "boolean", default: false },
      inject: { type: "boolean", default: true },
      runtime: { type: "string", default: "openclaw" },
      baseModel: { type: "string" },
      since: { type: "string" },
      limit: { type: "number" },
      listen: { type: "number" },
      host: { type: "string" },
      force: { type: "boolean", default: false },
      follow: { type: "boolean", default: false },
      lines: { type: "number" },
      transport: { type: "string" },
    },
  }
);

const [command, ...rest] = cli.input;

// nono availability check (skip for --no-nono or office/mail relay commands)
async function checkNono() {
  if (cli.flags.nonono) return;
  if (command === "office" && rest[0] === "relay") return; // relay runs in background
  const { findNono } = await import("../src/utils/nono.js");
  if (!findNono()) {
    console.warn(
      "⚠️  nono not found. Host agents will run without process isolation.\n" +
      "   Install nono for syscall filtering + filesystem boundaries.\n" +
      "   Use --nonono to run anyway (not recommended).\n"
    );
  }
}

async function main() {
  await checkNono();
  switch (command) {
    case "hire": {
      const reportPath = rest[0];
      if (!reportPath) {
        console.error(
          "I'm gonna need you to specify a TPS report file or persona.\n\n  tps hire <report.tps | persona> [--name Name]\n\nBuilt-in personas: developer, designer, support, ea, ops, strategy"
        );
        process.exit(1);
      }
      const { runHire } = await import("../src/cli/hire.js");
      runHire({
        reportPath,
        name: cli.flags.name,
        workspace: cli.flags.workspace,
        dryRun: cli.flags.dryRun,
        jsonOutput: cli.flags.json,
        configPath: cli.flags.config,
        branch: cli.flags.branch,
        inject: cli.flags.inject,
        runtime: cli.flags.runtime as any,
        baseModel: cli.flags.baseModel,
      });
      break;
    }
    case "roster": {
      // Backward-compatible path (keeps nono re-exec behavior used by existing tests):
      // `tps roster` with no subcommand routes to the legacy CLI implementation.
      if (!rest[0]) {
        const { runRoster } = await import("../src/cli/roster.js");
        runRoster({ configPath: cli.flags.config });
        break;
      }

      const action = rest[0] as "list" | "show" | "find";
      if (!["list", "show", "find"].includes(action)) {
        console.error(
          "Usage:\n  tps roster\n  tps roster list\n  tps roster show <agent> [--json]\n  tps roster find --channel <channel> [--json]"
        );
        process.exit(1);
      }
      const { runRoster } = await import("../src/commands/roster.js");
      runRoster({
        action,
        agent: rest[1],
        channel: cli.flags.channel || undefined,
        json: cli.flags.json,
        configPath: cli.flags.config,
      });
      break;
    }
    case "review": {
      const agentName = rest[0];
      if (!agentName) {
        console.error(
          "Review who? I'm gonna need a name.\n\n  tps review <agent-name>"
        );
        process.exit(1);
      }
      const { runReview } = await import("../src/cli/review.js");
      runReview({ agentName, configPath: cli.flags.config, deep: cli.flags.deep });
      break;
    }
    case "office": {
      const action = rest[0] as "start" | "stop" | "list" | "status" | "relay" | "exec" | "join" | "revoke" | "sync" | "connect" | "kill" | undefined;
      const validActions = ["start", "stop", "list", "status", "relay", "exec", "join", "revoke", "sync", "connect", "kill"];
      // Backward compatibility: `tps office <agent>` maps to `start <agent>`.
      const isLegacy = action && !validActions.includes(action);
      if ((!action && !isLegacy) || (!isLegacy && !validActions.includes(action!))) {
        console.error(
          "Usage:\n  tps office start <agent>\n  tps office stop <agent>\n  tps office list\n  tps office status [agent]\n  tps office exec <agent> -- <command...>\n  tps office join <name> <join-token>\n  tps office revoke <name>\n  tps office sync <name>\n  tps office connect <name>\n  tps office kill"
        );
        process.exit(1);
      }

      const { runOffice } = await import("../src/commands/office.js");
      if (isLegacy) {
        await runOffice({ action: "start", agent: rest[0] });
      } else if (action === "exec") {
        // Everything after "--" is the command
        const dashIdx = process.argv.indexOf("--");
        const execCmd = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : rest.slice(2);
        await runOffice({ action: "exec", agent: rest[1], command: execCmd });
      } else if (action === "join") {
        const joinToken = rest[2];
        if (!rest[1] || !joinToken) {
          console.error("Usage: tps office join <name> <join-token-url>");
          process.exit(1);
        }
        await runOffice({ action: "join", agent: rest[1], joinToken });
      } else if (action === "revoke") {
        if (!rest[1]) {
          console.error("Usage: tps office revoke <name>");
          process.exit(1);
        }
        await runOffice({ action: "revoke", agent: rest[1] });
      } else {
        const soundstageIdx = process.argv.indexOf("--soundstage");
        const isSoundstage = soundstageIdx >= 0 || cli.flags.soundstage;
        if (soundstageIdx >= 0) process.argv.splice(soundstageIdx, 1);

        await runOffice({ action: action!, agent: rest[1], manifest: cli.flags.manifest, soundstage: isSoundstage });
      }
      break;
    }
    case "context": {
      const action = rest[0] as "read" | "update" | "list" | undefined;
      const workstream = rest[1];
      if (!action || !["read", "update", "list"].includes(action)) {
        console.error(
          "Usage:\n  tps context read <workstream>\n  tps context update <workstream> --summary \"...\"\n  tps context list"
        );
        process.exit(1);
      }
      const { runContext } = await import("../src/commands/context.js");
      runContext({
        action,
        workstream,
        summary: cli.flags.summary,
        json: cli.flags.json,
      });
      break;
    }
    case "mail": {
      const action = rest[0] as "send" | "check" | "list" | "log" | "read" | "watch" | "search" | undefined;
      if (cli.flags.help || !action || !["send", "check", "list", "log", "read", "watch", "search"].includes(action)) {
        console.log(
          "Usage:\n  tps mail send <agent> <message>   Send mail to a local or remote agent\n  tps mail check [agent]             Read new messages (marks as read)\n  tps mail watch [agent]             Watch inbox for new messages\n  tps mail list [agent]              List all messages (read + unread)\n  tps mail read <agent> <id>         Show a specific message by ID (prefix ok)\n  tps mail search <query>            Search mail history using full-text search\n  tps mail log [agent]               Show audit log [--since YYYY-MM-DD] [--limit N]"
        );
        process.exit(cli.flags.help ? 0 : 1);
      }
      const { runMail } = await import("../src/commands/mail.js");
      await runMail({
        action,
        agent: rest[1],
        message: action === "send" ? rest.slice(2).join(" ") : undefined,
        messageId: action === "read" ? rest[2] : undefined,
        json: cli.flags.json,
        since: cli.flags.since,
        limit: cli.flags.limit ? Number(cli.flags.limit) : undefined,
      });
      break;
    }
    case "identity": {
      const action = rest[0] as "init" | "show" | "register" | "list" | "revoke" | "verify" | undefined;
      if (!action || !["init", "show", "register", "list", "revoke", "verify"].includes(action)) {
        console.error(
          "Usage:\n  tps identity init [--expires-in 90d]\n  tps identity show\n  tps identity register <branch> [--expires-in 90d] [--trust standard]\n  tps identity list\n  tps identity revoke <branch> --reason \"...\"\n  tps identity verify <branch>"
        );
        process.exit(1);
      }
      const { runIdentity } = await import("../src/commands/identity.js");
      await runIdentity({
        action,
        branch: rest[1],
        reason: cli.flags.reason,
        json: cli.flags.json,
        expiresIn: cli.flags.expiresIn,
        trust: cli.flags.trust as any,
        pubkey: cli.flags.pubkey,
        encPubkey: cli.flags.encPubkey,
      });
      break;
    }
    case "secrets": {
      const action = rest[0] as "set" | "list" | "remove" | undefined;
      if (!action || !["set", "list", "remove"].includes(action)) {
        console.error("Usage:\n  tps secrets set <KEY>=<VALUE>\n  tps secrets list\n  tps secrets remove <KEY>");
        process.exit(1);
      }
      const { runSecrets } = await import("../src/commands/secrets.js");
      let key: string | undefined;
      let value: string | undefined;
      if (action === "set") {
        const parts = rest[1]?.split("=");
        key = parts?.[0];
        value = parts?.slice(1).join("=");
      } else {
        key = rest[1];
      }
      await runSecrets({ action, key, value, json: cli.flags.json });
      break;
    }
    case "branch": {
      const action = rest[0] as "init" | "start" | "stop" | "status" | "log" | undefined;
      const valid = ["init", "start", "stop", "status", "log"];
      if (!action || !valid.includes(action)) {
        console.error("Usage:\n  tps branch init [--listen <port>] [--host <hostname>] [--transport ws|tcp]\n  tps branch start\n  tps branch stop\n  tps branch status\n  tps branch log [--lines N] [--follow]");
        process.exit(1);
      }
      const { runBranch } = await import("../src/commands/branch.js");
      await runBranch({
        action,
        port: typeof cli.flags.listen === "number" ? Number(cli.flags.listen) : undefined,
        host: cli.flags.host,
        transport: cli.flags.transport === "tcp" ? "tcp" : cli.flags.transport === "ws" ? "ws" : undefined,
        force: cli.flags.force,
        lines: typeof cli.flags.lines === "number" ? Number(cli.flags.lines) : undefined,
        follow: !!cli.flags.follow,
      });
      break;
    }
    case "git": {
      const action = rest[0];
      if (action === "worktree") {
        const agent = rest[1];
        const repoPath = rest[2];
        const branchName = rest[3];
        if (!agent || !repoPath) {
          console.error("Usage: tps git worktree <agent> <repo-path> [branch-name]");
          process.exit(1);
        }
        const { runGit } = await import("../src/commands/git.js");
        await runGit({ action, agent, repoPath, branchName });
      } else {
        console.error("Unknown git action. Supported: worktree");
        process.exit(1);
      }
      break;
    }
    default:
      cli.showHelp();
  }
}

main();
