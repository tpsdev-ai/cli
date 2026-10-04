import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { signEnvelope } from "../src/lib/signEnvelope.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import type { MailClient } from "../src/io/mail.js";

hashes.sha512 = (message: Uint8Array) => new Uint8Array(createHash("sha512").update(message).digest());

const SENDER_SEED = Buffer.alloc(32, 0xfb);
const PUBLIC_KEY = Buffer.from(ed.getPublicKey(SENDER_SEED));
let root: string;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-key-"));
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

for (const [format, key] of [
  ["malformed", "not-a-key!!"],
  ["unreachable", ""],
  ["lowercase hex", PUBLIC_KEY.toString("hex")],
  ["uppercase hex", PUBLIC_KEY.toString("hex").toUpperCase()],
  ["base64url", PUBLIC_KEY.toString("base64url")],
  ["padded base64url", PUBLIC_KEY.toString("base64url") + "="],
  ["base64", PUBLIC_KEY.toString("base64")],
  ["unpadded base64", PUBLIC_KEY.toString("base64").replace(/=+$/, "")],
] as const) {
  test(`AgentRuntime handles a ${format} Flair key`, async () => {
    expect(PUBLIC_KEY.toString("base64url")).toMatch(/[-_]/);
    const keyPath = join(root, "reader.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    let reads = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://flair.test");
      if (format === "unreachable") { reads++; throw new Error("Flair unreachable"); }
      if (url.pathname === "/Health") return new Response("ok");
      expect(url.pathname).toBe("/Agent/flint");
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^TPS-Ed25519 anvil:/);
      reads++;
      return Response.json({ id: "flint", name: "flint", publicKey: key });
    });
    const runtime = new AgentRuntime({
      agentId: "anvil",
      name: "anvil",
      mailDir: join(root, "mail"),
      memoryPath: join(root, "memory.jsonl"),
      workspace: root,
      llm: { provider: "ollama", model: "stub" },
      flair: { url: "http://flair.test", keyPath },
    });
    const timestamp = new Date().toISOString();
    const envelope = signEnvelope({
      v: 1,
      from: "flint",
      to: "anvil",
      body: "verified delivery",
      messageId: "runtime-key",
      timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: "flint", kind: "agent", timestamp, rationale: "sends", signature: null },
      ],
    }, { flint: SENDER_SEED });
    const inbox = join(root, "mail", "anvil");
    mkdirSync(join(inbox, "new"), { recursive: true });
    writeFileSync(join(inbox, "new", "message.json"), JSON.stringify({
      from: "flint", to: "anvil", body: JSON.stringify(envelope),
    }));
    const messages = await (runtime as unknown as { mail: MailClient }).mail.checkNewMail();
    expect(reads).toBeGreaterThan(0);
    if (format === "malformed" || format === "unreachable") {
      expect(messages).toEqual([]);
      expect(readdirSync(join(inbox, "cur"))).toEqual([]);
      if (format === "malformed") {
        expect(readdirSync(join(inbox, "new"))).toEqual([]);
        expect(readdirSync(join(inbox, "dlq")).sort()).toEqual(["message.json", "message.json.reason"]);
        const reason = readFileSync(join(inbox, "dlq", "message.json.reason"), "utf8");
        expect(reason).toContain("class: invalid");
        expect(reason).toContain("malformed public key for flint");
      } else {
        expect(readdirSync(join(inbox, "new"))).toEqual(["message.json"]);
        expect(readdirSync(join(inbox, "dlq")).sort()).toEqual([]);
      }
      return;
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]?.verifiedEnvelope?.body).toBe("verified delivery");
    expect(readdirSync(join(inbox, "new"))).toEqual([]);
    expect(readdirSync(join(inbox, "cur"))).toEqual(["message.json"]);
    expect(readdirSync(join(inbox, "dlq")).sort()).toEqual([]);
  });
}
