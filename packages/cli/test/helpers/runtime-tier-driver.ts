import { mock } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startUnverifiedFetchFlair } from "./fetch-flair.js";
import { buildSignedEnvelope } from "./stub-flair.js";

const [runtime, root] = process.argv.slice(2);
const utils = resolve(import.meta.dir, "../../src/utils");
mock.module(join(utils, "agent-lifecycle.ts"), () => ({
  bootContext: async () => ({ systemPrompt: "test", identitySource: "test" }),
  searchPastExperience: async () => "", snapshotSoulToDisk: async () => {},
  writeTaskMemory: async () => {}, catchUpTopics: async () => 0,
  onBoot: async () => ({}), onTaskStart: async () => ({}),
  onTaskComplete: async () => {}, onTaskFailure: async () => {},
}));
mock.module(join(utils, "flair-task-loop.ts"), () => ({ startTaskLoop: () => () => {} }));
const seeds = { flint: Buffer.alloc(32, 1), "openclaw-bridge": Buffer.alloc(32, 2), kern: Buffer.alloc(32, 3) };
const stub = startUnverifiedFetchFlair(seeds);
process.env.TPS_MAIL_DIR = join(root!, "mail");
process.env.FLAIR_URL = stub.url;
process.env.FLAIR_KEY_PATH = join(root!, "kern.key");
writeFileSync(process.env.FLAIR_KEY_PATH, seeds.kern);
for (const id of ["kern", "flint"]) mkdirSync(join(process.env.TPS_MAIL_DIR, id, "new"), { recursive: true });
const bin = join(root!, "bin"); mkdirSync(bin);
const launchLog = join(root!, "launches");
const result = runtime === "claude-code" ? '{"type":"result","result":"done"}'
  : runtime === "codex" ? '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}' : 'done';
for (const cmd of ["claude", "codex", "gemini"]) {
  const path = join(bin, cmd);
  writeFileSync(path, `#!/bin/sh\necho call >> '${launchLog}'\ncat >/dev/null\nprintf '%s\\n' '${result}'\n`);
  chmodSync(path, 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH}`;
for (const [id, from, trust] of [["bridge", "openclaw-bridge", undefined], ["ordinary", "flint", "internal"]] as const) {
  const envelope = buildSignedEnvelope(from, "kern", id, seeds, { messageId: id, trust });
  writeFileSync(join(process.env.TPS_MAIL_DIR, "kern", "new", `${id}.json`), JSON.stringify({
    id, from, to: "kern", body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false,
  }));
}
const module = await import(join(utils, `${runtime}-runtime.ts`));
const fn = runtime === "claude-code" ? module.runClaudeCodeRuntime : runtime === "codex" ? module.runCodexRuntime : module.runGeminiRuntime;
let error: string | undefined;
void fn({ agentId: "kern", workspace: root, mailDir: process.env.TPS_MAIL_DIR,
  flairUrl: stub.url, flairKeyPath: process.env.FLAIR_KEY_PATH,
  sessionLogPath: join(root!, "session.log"), pollIntervalMs: 10, taskTimeoutMs: 500,
}).catch((e: Error) => { error = e.message; });
const deadline = Date.now() + 3000;
while (Date.now() < deadline && existsSync(join(process.env.TPS_MAIL_DIR, "kern", "new", "ordinary.json"))) {
  await new Promise((r) => setTimeout(r, 10));
}
await new Promise((r) => setTimeout(r, 300));
console.log("MEASURED " + JSON.stringify({
  launches: existsSync(launchLog) ? readFileSync(launchLog, "utf8").trim().split("\n").length : 0,
  bridgeStill: existsSync(join(process.env.TPS_MAIL_DIR, "kern", "cur", "bridge.json")),
  ordinaryGone: !existsSync(join(process.env.TPS_MAIL_DIR, "kern", "cur", "ordinary.json")),
  replies: readdirSync(join(process.env.TPS_MAIL_DIR, "flint", "new")).length, error,
}));
process.exit(0);
