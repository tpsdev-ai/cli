import { startFetchFlair } from "./helpers/fetch-flair.js";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getInbox, sendMessage, checkMessages } from "../src/utils/mail.js";
import { externalDispatchRefusal } from "../src/utils/mail-tier.js";
import { claudeCodeDispatchRefusal } from "../src/utils/claude-code-runtime.js";
import { codexDispatchRefusal } from "../src/utils/codex-runtime.js";
import { geminiDispatchRefusal } from "../src/utils/gemini-runtime.js";
import { signedTrustTier } from "@tpsdev-ai/agent";
import { writeKeyFile, buildSignedEnvelope, type StubFlair } from "./helpers/stub-flair.js";

const KERN_SEED = Buffer.alloc(32, 0x41);
const FLINT_SEED = Buffer.alloc(32, 0x42);
const BRIDGE_SEED = Buffer.alloc(32, 0x43); // the default openclaw bridge identity
const CUSTOM_SEED = Buffer.alloc(32, 0x44); // a configured bridge identity
const SEEDS = { kern: KERN_SEED, flint: FLINT_SEED, "openclaw-bridge": BRIDGE_SEED, "custom-bridge": CUSTOM_SEED };

describe("trust ceiling at promotion (cli#433 slice B2-1)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-trust-ceiling-"));
    keysDir = join(tempRoot, "keys");
    stub = startFetchFlair(SEEDS);
    writeKeyFile(keysDir, "kern", KERN_SEED);
    writeKeyFile(keysDir, "flint", FLINT_SEED);

    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "TPS_AGENT_ID", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_BRIDGE_AGENT_ID"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, "kern.key");
    delete process.env.TPS_BRIDGE_AGENT_ID;
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function jsonFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }
  function reasonFor(agent: string, filename: string): string | null {
    try {
      return readFileSync(join(process.env.TPS_MAIL_DIR!, agent, "dlq", `${filename}.reason`), "utf-8");
    } catch {
      return null;
    }
  }

  test("a bridge-principal envelope signed internal receives the external tier", async () => {
    const env = buildSignedEnvelope("openclaw-bridge", "kern", "from the channel", SEEDS, { trust: "internal" });
    sendMessage("kern", JSON.stringify(env), "openclaw-bridge");

    const inbox = getInbox("kern");
    const [file] = jsonFiles(inbox.fresh);
    const msgs = await checkMessages("kern");

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.trustTier).toBe("external");
    expect(msgs[0]!.envelope?.trust).toBe("internal");
  });

  test("a bridge-principal envelope signed external is promoted (the allowed tier)", async () => {
    const env = buildSignedEnvelope("openclaw-bridge", "kern", "from the channel", SEEDS, { trust: "external" });
    sendMessage("kern", JSON.stringify(env), "openclaw-bridge");

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.envelope?.trust).toBe("external");
  });

  test("an unknown signed trust value is refused, never defaulted", async () => {
    const env = buildSignedEnvelope("flint", "kern", "hello", SEEDS, { trust: "superuser" });
    sendMessage("kern", JSON.stringify(env), "flint");

    const inbox = getInbox("kern");
    const [file] = jsonFiles(inbox.fresh);
    const msgs = await checkMessages("kern");

    expect(msgs.length).toBe(0);
    expect(jsonFiles(inbox.dlq).length).toBe(1);
    const reason = reasonFor("kern", file!);
    expect(reason).toContain("class: invalid");
    expect(reason).toContain("invalid trust value");
  });

  test("a configured bridge principal (resolved by the one bridge rule) is capped too", async () => {
    process.env.TPS_BRIDGE_AGENT_ID = "custom-bridge";
    const env = buildSignedEnvelope("custom-bridge", "kern", "from a custom bridge", SEEDS, { trust: "internal" });
    sendMessage("kern", JSON.stringify(env), "custom-bridge");

    const msgs = await checkMessages("kern");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.trustTier).toBe("external");
  });

  test("a wrapper X-TPS-Trust: internal on external mail confers nothing", async () => {
    const env = buildSignedEnvelope("flint", "kern", "external body", SEEDS, { trust: "external" });
    const inbox = getInbox("kern");
    // The WRAPPER carries a header claiming internal; the header sits outside
    // the signature and must not change the signed tier.
    const file = join(inbox.fresh, "wrapped.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "wrapped",
        from: "flint",
        to: "kern",
        timestamp: new Date().toISOString(),
        read: false,
        headers: { "X-TPS-Trust": "internal", "X-TPS-Sender": "flint" },
        body: JSON.stringify(env),
      }),
    );

    const msgs = await checkMessages("kern");
    expect(msgs.length).toBe(1);
    // The SIGNED tier is unchanged, and the consumer gate still treats it as
    // external — the wrapper conferred nothing.
    expect(msgs[0]!.envelope?.trust).toBe("external");
    expect(externalDispatchRefusal(msgs[0]!.envelope, msgs[0]!.from)).not.toBeNull();
  });

  test("a wrapper cannot alter a bridge principal tier", async () => {
    const env = buildSignedEnvelope("openclaw-bridge", "kern", "escalated", SEEDS, { trust: "internal" });
    sendMessage("kern", JSON.stringify(env), "openclaw-bridge");
    const inbox = getInbox("kern");
    const [file] = jsonFiles(inbox.fresh);
    // The bridge ceiling caps the claimed internal tier at external.
    const record = JSON.parse(readFileSync(join(inbox.fresh, file!), "utf-8"));
    record.headers = { "X-TPS-Trust": "external" };
    writeFileSync(join(inbox.fresh, file!), JSON.stringify(record));

    const msgs = await checkMessages("kern");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.trustTier).toBe("external");
  });
});

describe("consumer tier gate (cli#433 slice B2-1)", () => {
  const bridgeEnvelope = { trust: "external" } as const;
  const internalEnvelope = { trust: "internal" } as const;
  const userEnvelope = { trust: "user" } as const;

  test("signedTrustTier maps only a signed internal to internal", () => {
    expect(signedTrustTier("internal")).toBe("internal");
    expect(signedTrustTier("external")).toBe("external");
    expect(signedTrustTier("user")).toBe("external");
    expect(signedTrustTier("nonsense")).toBe("external");
    expect(signedTrustTier(undefined)).toBe("external");
  });

  test("the Claude Code runtime's dispatch gate refuses external-tier mail; internal and no-claim mail proceed", () => {
    expect(claudeCodeDispatchRefusal(bridgeEnvelope, "openclaw-bridge")).toContain("external-tier");
    expect(claudeCodeDispatchRefusal(userEnvelope, "flint")).toContain("external-tier");
    expect(claudeCodeDispatchRefusal(internalEnvelope, "flint")).toBeNull();
    expect(claudeCodeDispatchRefusal(undefined, "flint")).toBeNull();
  });

  test("the Codex runtime's dispatch gate refuses external-tier mail; internal and no-claim mail proceed", () => {
    expect(codexDispatchRefusal(bridgeEnvelope, "openclaw-bridge")).toContain("external-tier");
    expect(codexDispatchRefusal(userEnvelope, "flint")).toContain("external-tier");
    expect(codexDispatchRefusal(internalEnvelope, "flint")).toBeNull();
    expect(codexDispatchRefusal(undefined, "flint")).toBeNull();
  });

  test("the Gemini runtime's dispatch gate refuses external-tier mail; internal and no-claim mail proceed", () => {
    expect(geminiDispatchRefusal(bridgeEnvelope, "openclaw-bridge")).toContain("external-tier");
    expect(geminiDispatchRefusal(userEnvelope, "flint")).toContain("external-tier");
    expect(geminiDispatchRefusal(internalEnvelope, "flint")).toBeNull();
    expect(geminiDispatchRefusal(undefined, "flint")).toBeNull();
  });

  test("an unknown value maps to external, never internal", () => {
    for (const v of ["superuser", "root", 1, null, {}, []]) {
      expect(signedTrustTier(v)).toBe("external");
    }
  });
});
