import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FlairClient } from "../packages/cli/src/utils/flair-client.js";
import { buildSignedEnvelope, pubkeyFromSeed } from "../packages/cli/test/helpers/stub-flair.js";

const BOT = "deploybot";
const ROOT = join(homedir(), ".tps", "mail", BOT);
const SEED = Buffer.alloc(32, 8);
type Bot = { pollNewMail(): Promise<Array<{ body: string }>> };
let bots: Array<[string, Bot]>;
let verifier: ReturnType<typeof spyOn>;

beforeAll(async () => {
  const previous = process.env.DEPLOY_BOT_AGENT;
  const previousHost = process.env.DEPLOY_BOT_HOST_AGENT;
  process.env.DEPLOY_BOT_AGENT = BOT;
  process.env.DEPLOY_BOT_HOST_AGENT = "flint";
  try {
    bots = [
      ["scripts", await import("../scripts/deploy-bot.js")],
      ["packages/cli/scripts", await import("../packages/cli/scripts/deploy-bot.js")],
    ];
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_BOT_AGENT;
    else process.env.DEPLOY_BOT_AGENT = previous;
    if (previousHost === undefined) delete process.env.DEPLOY_BOT_HOST_AGENT;
    else process.env.DEPLOY_BOT_HOST_AGENT = previousHost;
  }
});

beforeEach(() => {
  mkdirSync(join(ROOT, "dlq"), { recursive: true });
  verifier = spyOn(FlairClient.prototype, "getAgentForVerification").mockImplementation(async (name: string) => (
    name === "flint" ? { id: name, name, publicKey: pubkeyFromSeed(SEED).toString("base64") } : null
  ));
});

afterEach(() => {
  verifier.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

for (const index of [0, 1]) {
  test(`deploy-bot copy ${index} re-drives dlq/ with new/ absent`, async () => {
    const envelope = buildSignedEnvelope("flint", BOT, "status", { flint: SEED });
    writeFileSync(join(ROOT, "dlq", "retry.json"), JSON.stringify({
      id: "retry", from: "flint", to: BOT, body: JSON.stringify(envelope),
    }));
    writeFileSync(join(ROOT, "dlq", "retry.json.reason"), "class: verify-unavailable\n");
    expect(existsSync(join(ROOT, "new"))).toBe(false);
    const [, bot] = bots[index]!;
    expect((await bot.pollNewMail()).map((row) => row.body)).toEqual(["status"]);
    expect(JSON.parse(readFileSync(join(ROOT, "cur", "retry.json"), "utf-8")).envelopeId).toBe(envelope.messageId);
    expect(existsSync(join(ROOT, "dlq", "retry.json"))).toBe(false);
    expect(await bot.pollNewMail()).toEqual([]);
  });
}

for (const index of [0, 1]) {
  test(`deploy-bot copy ${index} leaves non-message files in new/ beside promoted mail`, async () => {
    const newDir = join(ROOT, "new");
    mkdirSync(newDir, { recursive: true });
    const envelope = buildSignedEnvelope("flint", BOT, "status", { flint: SEED });
    writeFileSync(join(newDir, ".x.json"), "{ not mail");
    writeFileSync(join(newDir, "message.txt"), "not mail");
    writeFileSync(join(newDir, "message.json"), JSON.stringify({
      id: "message", from: "flint", to: BOT, body: JSON.stringify(envelope),
    }));

    const rows = await bots[index]![1].pollNewMail();

    expect(rows.map((row) => row.body)).toEqual(["status"]);
    expect(readdirSync(newDir).sort()).toEqual([".x.json", "message.txt"]);
    expect(readFileSync(join(newDir, ".x.json"), "utf8")).toBe("{ not mail");
    expect(readFileSync(join(newDir, "message.txt"), "utf8")).toBe("not mail");
    expect(existsSync(join(ROOT, "cur", "message.json"))).toBe(true);
    expect(readdirSync(join(ROOT, "dlq"))).toEqual([]);
  });
}
