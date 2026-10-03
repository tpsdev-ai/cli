import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { verifyEnvelope } from "@tpsdev-ai/agent";
import { defaultMailSender, handleTransition, type PulseConfig, type PrInstance } from "../src/commands/pulse.js";

test("pulse notification delivers an envelope signed by pulse", async () => {
  const home = mkdtempSync(join(tmpdir(), "pulse-signature-"));
  const saved = Object.fromEntries(["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR"].map((k) => [k, process.env[k]]));
  const seed = Buffer.alloc(32, 0x65);
  const publicKey = Buffer.from(ed.getPublicKey(seed));
  try {
    process.env.HOME = home;
    process.env.TPS_MAIL_DIR = join(home, "mail");
    process.env.TPS_TEST_KEYS_DIR = join(home, "keys");
    mkdirSync(process.env.TPS_TEST_KEYS_DIR);
    writeFileSync(join(process.env.TPS_TEST_KEYS_DIR, "pulse.key"), seed);
    writeFileSync(join(process.env.TPS_TEST_KEYS_DIR, "flint.key"), Buffer.alloc(32, 0x66));
    const config = { ghAgent: "flint", mergeAuthority: "recipient", reviewers: [] } as unknown as PulseConfig;
    const instance = { state: "reviewing", history: [], prNumber: 42, title: "Signature test", repo: "example/repo" } as unknown as PrInstance;
    handleTransition("pr:example/repo#42", instance, "approved", config, defaultMailSender);
    const dir = join(process.env.TPS_MAIL_DIR, "recipient", "new");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    const envelope = JSON.parse(record.body);
    expect(record.from).toBe("pulse");
    expect(envelope.from).toBe("pulse");
    expect(envelope.to).toBe("recipient");
    expect(await verifyEnvelope(envelope, { getAgent: async (id) => id === "pulse" ? { publicKey } : null })).toEqual({ ok: true });
    expect(await verifyEnvelope({ ...envelope, from: "flint" }, { getAgent: async () => ({ publicKey }) })).toMatchObject({ ok: false });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});
