// event-loop-child.mjs — cli#617 slice (c) test helper.
//
// Runs the REAL EventLoop against a REAL MailClient in a child process. Its
// provider blocks forever inside the handler, and writes TPS_MARKER first, so a
// test can SIGKILL the process at the moment the message is committed (its
// intent is `in_progress`) and being processed — never an injected error.
//
// argv:  <mailDir> <agentId>
// env:   TPS_FROM, TPS_SEED, TPS_MARKER, TPS_WORKSPACE
import { mkdirSync, writeFileSync } from "node:fs";
import * as ed from "@noble/ed25519";
import { MailClient } from "../../src/io/mail.js";
import { EventLoop } from "../../src/runtime/event-loop.js";

const [mailDir, agentId] = process.argv.slice(2);
const from = process.env.TPS_FROM;
const seed = Buffer.from(process.env.TPS_SEED, "base64");
const workspace = process.env.TPS_WORKSPACE;
mkdirSync(workspace, { recursive: true });

const client = new MailClient(mailDir, undefined, agentId, {
  async getAgent(name) {
    return name === from ? { publicKey: Buffer.from(ed.getPublicKey(seed)) } : null;
  },
});

const provider = {
  async complete() {
    // The hand-over returned before this call, so the message is committed and
    // its intent is in_progress right now.
    writeFileSync(process.env.TPS_MARKER, "in-handler");
    await new Promise(() => {}); // spin until SIGKILL
  },
};

const config = {
  agentId,
  name: "loop-child",
  mailDir,
  memoryPath: `${workspace}/mem.jsonl`,
  workspace,
  llm: { provider: "test", model: "test-model" },
  contextWindowTokens: 8000,
  maxToolTurns: 50,
};

const loop = new EventLoop({
  config,
  memory: { append: async () => {} },
  context: {},
  provider,
  tools: { list: () => [], execute: async () => ({ content: "ok" }) },
});

await loop.runDeliveries(client);
