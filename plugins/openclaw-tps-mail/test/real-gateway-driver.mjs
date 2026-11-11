#!/usr/bin/env node
/**
 * real-gateway-driver.mjs — the gateway half of the cli#874 real-dispatch lane.
 *
 * It runs under node (OpenClaw's plugin loader needs node:sqlite) and in one
 * process:
 *   1. starts a loopback-only model stub (Anthropic Messages wire shape) that
 *      emits a progress text and a tool call, then — after the tool result — the
 *      final text;
 *   2. starts a loopback Flair stub that serves the two test agents' public
 *      keys;
 *   3. launches the pinned real `openclaw gateway run` with an isolated HOME,
 *      TMPDIR and state dir, loads the BUILT openclaw-tps-mail plugin, and writes
 *      one signed mail into the agent's new/;
 *   4. waits (every wait has a named deadline) for the reply, the cur/ move and
 *      the ack, then writes a JSON report for the Bun test that spawned it.
 *
 * No external network is used: every HTTP target is 127.0.0.1 and every model
 * and Flair answer is generated here.
 *
 * usage: node real-gateway-driver.mjs <spec.json>
 */
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const ROOT = resolve(spec.root);
const HOME = join(ROOT, "home");
const MAIL = join(ROOT, "mail");
const WORKSPACE = join(HOME, "workspace");
const LOG = join(ROOT, "openclaw.log");
const REPORT = join(ROOT, "report.json");
const PLUGIN = resolve(spec.pluginDir);
const OPENCLAW = join(PLUGIN, "node_modules", "openclaw", "openclaw.mjs");

// ── named deadlines ─────────────────────────────────────────────────────────
const GATEWAY_BOOT_DEADLINE_MS = 30_000;
const REPLY_DEADLINE_MS = 45_000;
const ACK_DEADLINE_MS = 15_000;
const STOP_DEADLINE_MS = 5_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, deadlineMs, label) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(25);
  }
  throw new Error(`timed out after ${deadlineMs}ms waiting for ${label}`);
}

const report = {
  status: "error",
  node: process.version,
  openclawVersion: null,
  modelCalls: 0,
  modelTurnTexts: [],
  unexpected: [],
  dispatchStarts: 0,
  replyCount: 0,
  replyBody: null,
  replyHeaders: null,
  curFiles: [],
  inboundId: null,
  ackTimedOut: false,
  ackLines: [],
  logs: [],
};

function writeReport() {
  writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");
}

// ── prerequisites: node must satisfy the pinned OpenClaw's engines ─────────
const openclawPkg = JSON.parse(readFileSync(join(PLUGIN, "node_modules", "openclaw", "package.json"), "utf8"));
report.openclawVersion = openclawPkg.version;
function satisfies(version, range) {
  const v = version.replace(/^v/, "").split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return range.split("||").some((clause) =>
    clause
      .trim()
      .split(/\s+/)
      .every((c) => {
        const m = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(c);
        if (!m) throw new Error(`unparsed engines clause "${c}"`);
        const d = cmp(v, [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]);
        return m[1] === ">=" ? d >= 0 : m[1] === ">" ? d > 0 : m[1] === "<=" ? d <= 0 : m[1] === "<" ? d < 0 : d === 0;
      }),
  );
}
const engines = openclawPkg.engines?.node ?? "";
if (engines && !satisfies(process.version, engines)) {
  report.error = `node ${process.version} does not satisfy openclaw ${openclawPkg.version} engines "${engines}"`;
  writeReport();
  console.error(`real-gateway-driver: ${report.error}`);
  process.exit(3);
}

// ── test agents: keys and signed mail ──────────────────────────────────────
const seedA = Buffer.alloc(32, 0x11);
const seedB = Buffer.alloc(32, 0x22);
const publicKey = (seed) => {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32).toString("hex");
};
const pubA = publicKey(seedA);
const pubB = publicKey(seedB);

for (const dir of [
  HOME,
  MAIL,
  WORKSPACE,
  join(HOME, ".openclaw"),
  join(HOME, ".flair", "keys"),
  join(MAIL, "agent-a", "new"),
  join(MAIL, "agent-b", "new"),
  join(ROOT, "tmp"),
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(HOME, ".flair", "keys", "agent-a.key"), seedA);
writeFileSync(join(HOME, ".flair", "keys", "agent-b.key"), seedB);

// ── model stub (Anthropic Messages) ────────────────────────────────────────
const requests = [];
let modelCalls = 0;
const model = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    requests.push({ method: req.method, url: req.url });
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      report.unexpected.push({ method: req.method, url: req.url });
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    modelCalls += 1;
    const input = Array.isArray(parsed?.input) ? parsed.input : [];
    const sawToolOutput = input.some((item) => item?.type === "function_call_output");
    const messages = sawToolOutput
      ? [{ id: "msg_2", text: "FINAL: the task is complete", phase: "final_answer" }]
      : [{ id: "msg_1", text: "PROGRESS: drafting the answer", phase: "final_answer" }];
    report.modelTurnTexts.push(...messages.map((item) => item.text));

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const responseBase = { id: "resp_1", object: "response", created_at: Math.floor(Date.now() / 1000), model: "stub-model" };
    send({ type: "response.created", response: { ...responseBase, status: "in_progress", output: [] } });
    let index = 0;
    const output = [];
    const sendMessage = (it) => {
      const item = {
        type: "message",
        id: it.id,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: it.text, annotations: [] }],
        phase: it.phase,
      };
      send({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "message", id: it.id, status: "in_progress", role: "assistant", content: [], phase: it.phase },
      });
      send({
        type: "response.content_part.added",
        item_id: it.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      send({ type: "response.output_text.delta", item_id: it.id, output_index: index, content_index: 0, delta: it.text });
      send({ type: "response.output_text.done", item_id: it.id, output_index: index, content_index: 0, text: it.text });
      send({
        type: "response.content_part.done",
        item_id: it.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: it.text, annotations: [] },
      });
      send({ type: "response.output_item.done", output_index: index, item });
      output.push(item);
      index += 1;
    };
    for (const it of messages) sendMessage(it);
    if (!sawToolOutput) {
      const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "session_status", arguments: "{}", status: "completed" };
      send({ type: "response.output_item.added", output_index: index, item: { ...call, status: "in_progress", arguments: "" } });
      send({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: index, delta: "{}" });
      send({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: index, arguments: "{}" });
      send({ type: "response.output_item.done", output_index: index, item: call });
      output.push(call);
    }
    send({
      type: "response.completed",
      response: {
        ...responseBase,
        status: "completed",
        output,
        output_text: messages[0].text,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });
    res.end();
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const modelPort = model.address().port;
report.modelPort = modelPort;

// ── Flair stub ──────────────────────────────────────────────────────────────
const flair = createServer((req, res) => {
  const m = /^\/Agent\/([^/]+)$/.exec(req.url ?? "");
  if (req.method === "GET" && m) {
    const id = decodeURIComponent(m[1]);
    const pk = id === "agent-a" ? pubA : id === "agent-b" ? pubB : null;
    if (pk) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, name: id, publicKey: pk }));
      return;
    }
  }
  report.unexpected.push({ method: req.method, url: req.url });
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise((r) => flair.listen(0, "127.0.0.1", r));
const flairPort = flair.address().port;
report.flairPort = flairPort;

// A free loopback port for the gateway: bind, read, close. The window is only
// used to choose the port; the gateway binds it immediately afterwards.
const gatewayProbe = createServer(() => {});
await new Promise((r) => gatewayProbe.listen(0, "127.0.0.1", r));
const gatewayPort = gatewayProbe.address().port;
await new Promise((r) => gatewayProbe.close(r));

// ── gateway config ────────────────────────────────────────────────────────
const config = {
  logging: { file: LOG },
  gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
  agents: {
    defaults: {
      workspace: WORKSPACE,
      blockStreamingDefault: "on",
      blockStreamingBreak: "message_end",
      blockStreamingChunk: { minChars: 1, maxChars: 1000 },
      model: { primary: "stub/stub-model" },
    },
    entries: { "agent-a": { workspace: WORKSPACE } },
  },
  models: {
    providers: {
      stub: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        apiKey: "stub-key",
        api: "openai-responses",
        models: [{ id: "stub-model", name: "Stub", contextWindow: 200000, maxTokens: 8192 }],
      },
    },
  },
  plugins: {
    allow: ["openclaw-tps-mail"],
    load: { paths: [PLUGIN] },
    entries: { "openclaw-tps-mail": { enabled: true, config: { mailDir: MAIL } } },
  },
  channels: {
    "tps-mail": { enabled: true, streaming: { block: { enabled: true } }, accounts: { default: { mailDir: MAIL } } },
  },
  bindings: [{ agentId: "agent-a", match: { channel: "tps-mail", accountId: "default" } }],
};
writeFileSync(join(HOME, ".openclaw", "openclaw.json"), JSON.stringify(config, null, 2));

const env = {
  PATH: process.env.PATH ?? "",
  HOME,
  TMPDIR: join(ROOT, "tmp"),
  FLAIR_URL: `http://127.0.0.1:${flairPort}`,
  OPENCLAW_STATE_DIR: join(HOME, ".openclaw"),
  OPENCLAW_CONFIG_PATH: join(HOME, ".openclaw", "openclaw.json"),
  OPENCLAW_TEST_FAST: "0",
};

let child;
let logs = "";
try {
  child = spawn(
    process.execPath,
    [OPENCLAW, "gateway", "run", "--port", String(gatewayPort), "--auth", "none", "--allow-unconfigured", "--verbose"],
    { env, cwd: HOME, stdio: ["ignore", "pipe", "pipe"] },
  );
  const onData = (chunk) => {
    logs += String(chunk);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  await until(
    () => logs.includes("watching 1 agent inbox") || logs.includes("http server listening"),
    GATEWAY_BOOT_DEADLINE_MS,
    "gateway boot",
  );

  // ── one signed mail ─────────────────────────────────────────────────────
  const { signEnvelope } = await import(
    pathToFileURL(join(PLUGIN, "node_modules", "@tpsdev-ai", "agent", "dist", "index.js")).href
  );
  const noblePath = createRequire(join(PLUGIN, "package.json")).resolve("@noble/ed25519");
  const { hashes } = await import(pathToFileURL(noblePath).href);
  hashes.sha512 = (message) => new Uint8Array(createHash("sha512").update(message).digest());

  const inboundId = `msg-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope(
    {
      v: 1,
      from: "agent-b",
      to: "agent-a",
      body: "please handle this",
      messageId: inboundId,
      timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: "agent-b", kind: "agent", timestamp, rationale: "agent agent-b dispatches", signature: null },
      ],
    },
    { "agent-b": seedB },
  );
  report.inboundId = inboundId;
  writeFileSync(
    join(MAIL, "agent-a", "new", `${timestamp.replace(/[:.]/g, "-")}-${inboundId}.json`),
    JSON.stringify({ id: inboundId, from: "agent-b", to: "agent-a", body: JSON.stringify(envelope), timestamp, read: false }, null, 2),
  );

  await until(
    () => readdirSync(join(MAIL, "agent-b", "new")).some((f) => f.endsWith(".json")),
    REPLY_DEADLINE_MS,
    "reply mail",
  );
  const replyFiles = readdirSync(join(MAIL, "agent-b", "new")).filter((f) => f.endsWith(".json"));
  report.replyCount = replyFiles.length;
  if (replyFiles.length > 0) {
    const reply = JSON.parse(readFileSync(join(MAIL, "agent-b", "new", replyFiles[0]), "utf8"));
    report.replyBody = JSON.parse(reply.body).body;
    report.replyFrom = reply.from;
    report.replyTo = reply.to;
    report.replyHeaders = reply.headers ?? null;
  }

  await until(() => readdirSync(join(MAIL, "agent-a", "cur")).length > 0, 5_000, "cur/ move");
  report.curFiles = readdirSync(join(MAIL, "agent-a", "cur"));

  try {
    await until(
      () => existsSync(LOG) && readFileSync(LOG, "utf8").includes("receipt found"),
      ACK_DEADLINE_MS,
      "ack log line",
    );
  } catch {
    // A missing ack is an ASSERTION in the Bun test, not a driver failure: the
    // report still carries the reply and the log so the failing line is named.
    report.ackTimedOut = true;
  }
  report.modelCalls = modelCalls;
  report.status = "ok";
} catch (err) {
  report.error = err?.message ?? String(err);
} finally {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(STOP_DEADLINE_MS)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await new Promise((r) => model.close(r));
  await new Promise((r) => flair.close(r));
  let logMessages = [];
  try {
    if (existsSync(LOG)) {
      logMessages = readFileSync(LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            const record = JSON.parse(line);
            return typeof record["1"] === "string" ? record["1"] : String(record.message ?? "");
          } catch {
            return line;
          }
        })
        .filter(Boolean);
    }
  } catch {}
  report.logs = logs.split("\n").slice(-40);
  report.logTail = logMessages.slice(-120);
  const dispatchFromStdout = (logs.match(/message dispatch started: channel=tps-mail/g) ?? []).length;
  const dispatchFromLogFile = logMessages.filter((message) => message.includes("message dispatch started: channel=tps-mail")).length;
  report.dispatchStarts = Math.max(dispatchFromStdout, dispatchFromLogFile);
  report.ackLines = logMessages.filter((message) => message.includes("acked "));
  writeReport();
}
process.exit(0);
