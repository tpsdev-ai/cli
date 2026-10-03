import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { FlairContextProvider } from "../src/io/flair.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { MailClient } from "../src/io/mail.js";
import { signEnvelope } from "../src/lib/signEnvelope.js";

let root: string;
let fault: ReturnType<typeof spyOn>;
afterEach(() => { fault?.mockRestore(); if (root) rmSync(root, { recursive: true, force: true }); });

for (const response of [401, 403, 500, null, {}]) {
  test(`healthy Health with indeterminate Agent response ${JSON.stringify(response)} stays retryable`, async () => {
    root = mkdtempSync(join(tmpdir(), "partial-flair-"));
    const keyPath = join(root, "reader.key");
    writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const seed = Buffer.alloc(32, 3);
    let recovered = false;
    fault = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (new URL(String(input)).pathname === "/Health") return new Response("ok");
      if (recovered) return Response.json({ id: "flint", publicKey: Buffer.from(ed.getPublicKey(seed)).toString("base64") });
      return typeof response === "number" ? new Response("failure", { status: response }) : Response.json(response);
    });
    expect((await fetch("http://flair.test/Health")).ok).toBe(true);
    const provider = new FlairContextProvider("kern", { url: "http://flair.test", keyPath });
    await expect(provider.getAgent("flint")).rejects.toThrow();
    const runtime = new AgentRuntime({ agentId: "kern", name: "kern", workspace: root,
      mailDir: root, memoryPath: join(root, "memory.jsonl"),
      llm: { provider: "anthropic", model: "test", apiKey: "test" },
      flair: { url: "http://flair.test", keyPath } });
    const client = (runtime as unknown as { mail: MailClient }).mail;
    const timestamp = new Date().toISOString();
    const envelope = signEnvelope({ v: 1, from: "flint", to: "kern", body: "retry", messageId: "partial-outage", timestamp,
      delegationChain: [{ agent: "flint", kind: "agent", rationale: "sends", timestamp, signature: null }] }, { flint: seed });
    const fresh = join(root, "kern", "new");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "mail.json"), JSON.stringify({ from: "flint", body: JSON.stringify(envelope) }));
    expect(await client.checkNewMail()).toEqual([]);
    expect(readdirSync(fresh)).toEqual(["mail.json"]);
    expect(readdirSync(join(root, "kern", "dlq"))).toEqual([]);
    recovered = true;
    expect(await client.checkNewMail()).toHaveLength(1);
  });
}

test("AgentRuntime authenticates registry reads with an agent-create raw private seed", async () => {
  root = mkdtempSync(join(tmpdir(), "raw-seed-runtime-"));
  const keyPath = join(root, "reader.key");
  const reader = Buffer.alloc(32, 2);
  const sender = Buffer.alloc(32, 3);
  writeFileSync(keyPath, reader);
  let authenticated = 0;
  fault = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/Health") return new Response("ok");
    const auth = new Headers(init?.headers).get("Authorization")!;
    const [agent, timestamp, nonce, signature] = auth.slice("TPS-Ed25519 ".length).split(":");
    const payload = Buffer.from(`${agent}:${timestamp}:${nonce}:GET:${path}`);
    if (agent !== "kern" || !ed.verify(Buffer.from(signature!, "base64"), payload, ed.getPublicKey(reader))) {
      return new Response("invalid credential", { status: 403 });
    }
    authenticated++;
    return Response.json({ id: "flint", publicKey: Buffer.from(ed.getPublicKey(sender)).toString("hex") });
  });
  const runtime = new AgentRuntime({ agentId: "kern", name: "kern", workspace: root,
    mailDir: root, memoryPath: join(root, "memory.jsonl"),
    llm: { provider: "anthropic", model: "test", apiKey: "test" }, flair: { url: "http://flair.test", keyPath } });
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope({ v: 1, from: "flint", to: "kern", body: "raw-seed", messageId: "raw-seed", timestamp,
    delegationChain: [{ agent: "flint", kind: "agent", rationale: "sends", timestamp, signature: null }] }, { flint: sender });
  writeFileSync(join(root, "kern", "new", "mail.json"), JSON.stringify({ from: "flint", body: JSON.stringify(envelope) }));
  const mail = (runtime as unknown as { mail: MailClient }).mail;
  expect(await mail.checkNewMail()).toHaveLength(1);
  expect(authenticated).toBeGreaterThan(0);
  for (const [index, invalid] of [{ ...envelope, v: 2 }, { ...envelope, signature: "bad" }, { ...envelope, delegationChain: [] }].entries()) {
    writeFileSync(join(root, "kern", "new", `invalid-${index}.json`), JSON.stringify({ from: "flint", body: JSON.stringify(invalid) }));
    expect(await mail.checkNewMail()).toEqual([]);
    expect(fs.readFileSync(join(root, "kern", "dlq", `invalid-${index}.json.reason`), "utf8")).toContain("class: invalid");
  }
  const next = signEnvelope({ ...envelope, messageId: "after-key-fault", signature: undefined,
    delegationChain: envelope.delegationChain.map(hop => ({ ...hop, signature: null })) }, { flint: sender });
  writeFileSync(join(root, "kern", "new", "next.json"), JSON.stringify({ from: "flint", body: JSON.stringify(next) }));
  const read = fs.readFileSync;
  const unreadable = spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
    if (args[0] === keyPath) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return read(...args);
  });
  try { expect(await mail.checkNewMail()).toEqual([]); }
  finally { unreadable.mockRestore(); }
  writeFileSync(keyPath, "torn private key");
  expect(await mail.checkNewMail()).toEqual([]);
  rmSync(keyPath);
  expect(await mail.checkNewMail()).toEqual([]);
  expect(readdirSync(join(root, "kern", "new"))).toEqual(["next.json"]);
  writeFileSync(keyPath, reader);
  expect(await mail.checkNewMail()).toHaveLength(1);
});
