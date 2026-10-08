import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSignedEnvelope, pubkeyFromSeed, writeKeyFile } from "./helpers/stub-flair.js";

const BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const SEEDS = { sender: Buffer.alloc(32, 0x61), demo: Buffer.alloc(32, 0x62) };

function fixture(auth?: "missing" | "invalid" | "unknown") {
  const root = mkdtempSync(join(tmpdir(), "tps-flag-dispatch-"));
  const preload = join(root, "transport.mjs");
  const request = join(root, "request.json");
  const keys = Object.fromEntries(Object.entries(SEEDS).map(([name, seed]) => [name, pubkeyFromSeed(seed).toString("base64")]));
  if (auth === "unknown") delete keys.demo;
  writeFileSync(preload, `import fs, { writeFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
fs.watch = () => ({ close() {} });
syncBuiltinESMExports();
const keys = ${JSON.stringify(keys)};
const nonces = new Set();
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "provider.test" && url.pathname === "/proxy/openai/v1/chat/completions") {
    writeFileSync(${JSON.stringify(request)}, init.body);
    return Response.json({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
  if (url.hostname === "flair.test") {
    if (url.pathname === "/Health") return new Response("ok");
    if (url.pathname.startsWith("/Agent/") && init?.method === "GET") {
      const headers = new Headers(init.headers);
      if (${JSON.stringify(auth)} === "missing") headers.delete("Authorization");
      const header = headers.get("Authorization") ?? "";
      const parsed = header.length <= 4096 && /^TPS-Ed25519\\s+([^:\\s]+):(\\d+):([^:\\s]+):(.+)$/.exec(header);
      if (!parsed) return Response.json({ type: "error:AccessViolation", error: "forbidden", instance: url.pathname }, { status: 403 });
      const [, caller, ts, nonce, signature] = parsed;
      const refuse = (error) => Response.json({ error }, { status: 401 });
      if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > 30_000) return refuse("timestamp_out_of_window");
      const replayKey = caller + ":" + nonce;
      if (nonces.has(replayKey)) return refuse("nonce_replay_detected");
      if (!Object.hasOwn(keys, caller)) return refuse("unknown_agent");
      try {
        const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keys[caller], "base64")]), format: "der", type: "spki" });
        const payload = caller + ":" + ts + ":" + nonce + ":" + init.method + ":" + url.pathname + url.search;
        if (!verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64"))) return refuse("invalid_signature");
      } catch (err) {
        return Response.json({ error: "signature_verification_failed", detail: err.message }, { status: 401 });
      }
      nonces.add(replayKey);
      const name = decodeURIComponent(url.pathname.slice("/Agent/".length));
      if (!Object.hasOwn(keys, name)) return new Response("not found", { status: 404 });
      return Response.json({ id: name, publicKey: keys[name] });
    }
  }
  throw new Error("Unexpected transport request: " + url);
};
`);
  const key = writeKeyFile(join(root, ".tps", "identity"), "demo", auth === "invalid" ? SEEDS.sender : SEEDS.demo);
  return {
    root, request, preload,
    env: { ...process.env, HOME: root, TPS_HOME: root, TPS_MAIL_DIR: join(root, "mail"), FLAIR_URL: "http://flair.test", FLAIR_KEY_PATH: key, TPS_NONO_STRICT: "", TPS_LLM_PROXY_URL: "" },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(f: ReturnType<typeof fixture>, argv: string[]) {
  return spawnSync("node", ["--import", f.preload, BIN, ...argv], {
    encoding: "utf-8", timeout: 10_000, cwd: f.root, env: f.env,
  });
}

async function watchUntil(f: ReturnType<typeof fixture>, argv: string[], marker: string) {
  const child = spawn("node", ["--import", f.preload, BIN, ...argv], { cwd: f.root, env: f.env });
  const stopped = new Promise<void>((resolveStopped) => child.once("close", () => resolveStopped()));
  let output = "";
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${marker}: ${output}`)), 10_000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(marker)) { clearTimeout(timer); resolveReady(); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Watcher exited: ${output}`)); });
    });
    return output;
  } finally {
    child.kill("SIGTERM");
    await stopped;
  }
}

for (const flag of ["--version", "-v", "--help", "-h"]) {
  test(`real runAgent sends ${flag} through the config loader and runtime to the provider transport`, () => {
    const f = fixture();
    try {
      const config = join(f.root, "agent.yaml");
      writeFileSync(config, JSON.stringify({ agentId: "demo", workspace: f.root, mailDir: join(f.root, "mail"), tools: [], llm: { provider: "openai", model: "fixture-model", baseUrl: "http://provider.test" } }));
      const r = run(f, ["agent", "run", "--id", "demo", "--config", config, "--message", flag]);
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      const body = JSON.parse(readFileSync(f.request, "utf-8"));
      expect(body.model).toBe("fixture-model");
      expect(body.messages.filter((m: { role: string }) => m.role === "user")).toEqual([{ role: "user", content: flag }]);
    } finally { f.cleanup(); }
  });

  test(`real runMail watch passes ${flag} to a hook for preseeded signed mail`, async () => {
    const f = fixture();
    try {
      const fresh = join(f.root, "mail", "demo", "new");
      mkdirSync(fresh, { recursive: true });
      const envelope = buildSignedEnvelope("sender", "demo", "signed body", SEEDS);
      writeFileSync(join(fresh, "mail.json"), JSON.stringify({ id: "local-record", from: "sender", to: "demo", body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false }));
      const hook = join(f.root, "hook.mjs");
      const result = join(f.root, "hook.json");
      writeFileSync(hook, `import { writeFileSync } from "node:fs";
let body = "";
for await (const chunk of process.stdin) body += chunk;
writeFileSync(${JSON.stringify(result)}, JSON.stringify({ argv: process.argv.slice(2), body, id: process.env.TPS_MAIL_ID }));
console.log("HOOK_FINISHED");
`);
      await watchUntil(f, ["mail", "watch", "demo", "--sandbox-required", "--exec", "node", hook, flag], "HOOK_FINISHED");
      expect(JSON.parse(readFileSync(result, "utf-8"))).toEqual({ argv: [flag], body: "signed body", id: envelope.messageId });
      expect(existsSync(join(fresh, "mail.json"))).toBe(true);
    } finally { f.cleanup(); }
  }, 15_000);
}

test("real runAgent refuses a config whose agentId disagrees with --id", () => {
  const f = fixture();
  try {
    const config = join(f.root, "agent.yaml");
    writeFileSync(config, JSON.stringify({ agentId: "other", workspace: f.root }));
    const r = run(f, ["agent", "run", "--id", "demo", "--config", config, "--message", "--version"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not match the launch id");
    expect(existsSync(f.request)).toBe(false);
  } finally { f.cleanup(); }
});

test("real runAgent config loader refuses an unresolved environment variable", () => {
  const f = fixture();
  try {
    const config = join(f.root, "agent.yaml");
    delete (f.env as Record<string, string | undefined>).TPS_FLAG_PROBE_UNSET;
    writeFileSync(config, JSON.stringify({ agentId: "demo", workspace: "${TPS_FLAG_PROBE_UNSET}" }));
    const r = run(f, ["agent", "run", "--id", "demo", "--config", config, "--message", "-v"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Missing environment variable: TPS_FLAG_PROBE_UNSET");
    expect(existsSync(f.request)).toBe(false);
  } finally { f.cleanup(); }
});

test("real runMail watch withholds a record with a damaged signature from the hook", async () => {
  const f = fixture();
  try {
    const fresh = join(f.root, "mail", "demo", "new");
    mkdirSync(fresh, { recursive: true });
    const envelope = buildSignedEnvelope("sender", "demo", "signed body", SEEDS);
    envelope.body = "tampered";
    writeFileSync(join(fresh, "mail.json"), JSON.stringify({ id: "local-record", from: "sender", to: "demo", body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false }));
    const sentinel = join(f.root, "hook-ran");
    const hook = join(f.root, "hook.mjs");
    writeFileSync(hook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "ran");`);
    await watchUntil(f, ["mail", "watch", "demo", "--sandbox-required", "--exec", "node", hook, "--version"], "signature verification failed");
    expect(existsSync(sentinel)).toBe(false);
  } finally { f.cleanup(); }
}, 15_000);

for (const [auth, status, error] of [
  ["missing", 403, "AccessViolation"],
  ["invalid", 401, "invalid_signature"],
  ["unknown", 401, "unknown_agent"],
] as const) {
  test(`real runMail watch withholds signed mail when the Agent read refuses ${auth} caller credentials`, async () => {
    const f = fixture(auth);
    try {
      const fresh = join(f.root, "mail", "demo", "new");
      mkdirSync(fresh, { recursive: true });
      const envelope = buildSignedEnvelope("sender", "demo", "signed body", SEEDS);
      const record = join(fresh, "mail.json");
      writeFileSync(record, JSON.stringify({ id: "local-record", from: "sender", to: "demo", body: JSON.stringify(envelope), timestamp: envelope.timestamp, read: false }));
      const sentinel = join(f.root, "hook-ran");
      const hook = join(f.root, "hook.mjs");
      writeFileSync(hook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "ran");`);
      const output = await watchUntil(f, ["mail", "watch", "demo", "--sandbox-required", "--exec", "node", hook, "--version"], "verification error");
      expect(output).toContain(`→ ${status}:`);
      expect(output).toContain(error);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(record)).toBe(true);
      expect(existsSync(join(f.root, "mail", "demo", "cur", "mail.json"))).toBe(false);
    } finally { f.cleanup(); }
  }, 15_000);
}
