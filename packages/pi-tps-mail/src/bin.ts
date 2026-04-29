#!/usr/bin/env node
// CLI entrypoint for pi-tps-mail watcher

import { watchMail } from "./watcher.js";
import minimist from "minimist";

function usage(): never {
  console.error("Usage:");
  console.error("  tps-mail-watcher [options]");
  console.error("");
  console.error("Options:");
  console.error("  --agent <id>         Agent ID to watch (default: ember)");
  console.error("  --inbox <path>       Path to ~/.tps directory (default: $HOME)");
  console.error("  --launcher <path>    Path to launcher script (default: ~/agents/{agent}/bin/{agent})");
  console.error("  --timeout <ms>       Dispatch timeout in ms (default: 1800000 = 30 min)");
  console.error("  --help, -h           Show this help message");
  process.exit(0);
}

function parseArgs(args: string[]): { [key: string]: string | number | boolean } {
  const parsed = minimist(args, {
    string: ["agent", "inbox", "launcher"],
    alias: {
      h: "help",
    },
  });
  
  // Convert numeric fields
  const opts: { [key: string]: string | number | boolean } = parsed;
  if (opts.timeout !== undefined) {
    opts.timeout = Number(opts.timeout);
  }
  
  return opts;
}

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.help) usage();

  const options: { agent?: string; inboxRoot?: string; launcher?: string; timeoutMs?: number } = {};

  if (opts.agent) options.agent = String(opts.agent);
  if (opts.inbox) options.inboxRoot = String(opts.inbox);
  if (opts.launcher) options.launcher = String(opts.launcher);
  if (opts.timeout) options.timeoutMs = Number(opts.timeout);

  const watcher = watchMail(options);

  // Graceful shutdown
  const shutdown = () => {
    watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
