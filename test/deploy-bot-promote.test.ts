/**
 * deploy-bot-promote.test.ts — cli#380: the deploy bot's inbound path promotes.
 *
 * The old deploy bot accepted forged commands after a parse check.
 *
 * The script resolves its mailbox at module load, so HOME and the env are set
 * before the dynamic import.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { hashes } from "@noble/ed25519";
import {
  buildSignedEnvelope,
  startStubFlair,
  writeKeyFile,
  type StubFlair,
} from "../packages/cli/test/helpers/stub-flair.js";

hashes.sha512 = (m: Uint8Array) => new Uint8Array(createHash("sha512").update(m).digest());

const BOT = "deploybot";
const BOT_SEED = Buffer.alloc(32, 7);
const SENDER = "flint";
const SENDER_SEED = Buffer.alloc(32, 8);
const IMPOSTOR_SEED = Buffer.alloc(32, 9);

type BotModule = {
  pollNewMail: () => Promise<Array<{ id: string; from: string; body: string }>>;
};

// bun caches os.homedir(), so the mailbox root is the launcher's throwaway
// isolated HOME (never override HOME here: the resolved root would diverge).
const ROOT = homedir();
let stub: StubFlair;
let bot: BotModule;

const inbox = (d: "new" | "cur" | "dlq") => join(ROOT, ".tps", "mail", BOT, d);
const files = (d: "new" | "cur" | "dlq") =>
  existsSync(inbox(d)) ? readdirSync(inbox(d)).filter((f) => f.endsWith(".json")) : [];

beforeAll(async () => {
  const keyPath = writeKeyFile(join(ROOT, "keys"), BOT, BOT_SEED);
  stub = startStubFlair({ [BOT]: BOT_SEED, [SENDER]: SENDER_SEED });

  process.env.DEPLOY_BOT_AGENT = BOT;
  process.env.DEPLOY_BOT_HOST_AGENT = SENDER;
  process.env.FLAIR_URL = stub.url;
  process.env.FLAIR_KEY_PATH = keyPath;

  // The script computes its mailbox dirs from homedir() at module load.
  bot = (await import("../scripts/deploy-bot.js")) as BotModule;

  for (const d of ["new", "cur", "dlq"] as const) mkdirSync(inbox(d), { recursive: true });
});

afterAll(() => {
  stub?.stop();
  rmSync(join(ROOT, ".tps", "mail", BOT), { recursive: true, force: true });
  rmSync(join(ROOT, "keys"), { recursive: true, force: true });
});

function plant(name: string, envelopeFrom: string, signWith: Buffer, body: string): void {
  const envelope = buildSignedEnvelope(envelopeFrom, BOT, body, { [envelopeFrom]: signWith });
  writeFileSync(
    join(inbox("new"), name),
    JSON.stringify({ id: envelope.messageId, from: envelopeFrom, to: BOT, body: JSON.stringify(envelope) }),
    "utf-8",
  );
}

describe("the deploy bot promotes inbound mail through promote() (cli#380)", () => {
  test("a verified command is promoted to cur/ and returned", async () => {
    plant("ok.json", SENDER, SENDER_SEED, "status");

    const rows = await bot.pollNewMail();

    expect(rows.map((r) => r.body)).toEqual(["status"]);
    expect(rows[0]!.from).toBe(SENDER);
    expect(files("cur")).toContain("ok.json");
    expect(files("new")).not.toContain("ok.json");
  });

  test("a forged record never reaches cur/ — it is dead-lettered, not returned", async () => {
    // Signed with a key that is not the sender's principal key.
    plant("forged.json", SENDER, IMPOSTOR_SEED, "run rm -rf /");

    const rows = await bot.pollNewMail();

    expect({ rows, inCur: files("cur").includes("forged.json") }).toEqual({ rows: [], inCur: false });
    expect(files("dlq")).toContain("forged.json");
  });

  test("a record the verifier cannot run on is not promoted, and the next poll after recovery delivers it", async () => {
    const goodUrl = process.env.FLAIR_URL;
    process.env.FLAIR_URL = "http://127.0.0.1:1"; // no listener: a retryable outage
    try {
      plant("outage.json", SENDER, SENDER_SEED, "status");
      const rows = await bot.pollNewMail();
      expect(rows).toEqual([]);
      expect(files("cur")).not.toContain("outage.json");
      expect(files("dlq")).toContain("outage.json");
    } finally {
      process.env.FLAIR_URL = goodUrl;
    }

    rmSync(inbox("new"), { recursive: true });
    const recovered = await bot.pollNewMail();
    expect(recovered.map((r) => r.body)).toEqual(["status"]);
    expect(files("cur")).toContain("outage.json");
    expect(files("dlq")).not.toContain("outage.json");
  });
});
