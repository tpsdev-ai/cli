import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMail } from "../src/commands/mail.js";
import { checkMessages, sendMessage, listMessages } from "../src/utils/mail.js";
import { startFetchFlair } from "./helpers/fetch-flair.js";
import { buildSignedEnvelope } from "./helpers/stub-flair.js";

for (const action of ["ack", "nack"] as const) {
  test(`mail ${action} verifies the signed tier before changing an external record`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mail-action-tier-"));
    const saved = { ...process.env };
    const seeds = { flint: Buffer.alloc(32, 9), kern: Buffer.alloc(32, 10) };
    const stub = startFetchFlair(seeds);
    try {
      process.env.TPS_MAIL_DIR = join(root, "mail"); process.env.TPS_AGENT_ID = "kern";
      process.env.FLAIR_KEY_PATH = join(root, "key"); process.env.FLAIR_URL = stub.url;
      writeFileSync(process.env.FLAIR_KEY_PATH, seeds.kern);
      sendMessage("kern", JSON.stringify(buildSignedEnvelope("flint", "kern", "external", seeds, { trust: "external" })), "flint");
      const [message] = await checkMessages("kern");
      expect(message).toBeDefined();
      await expect(runMail({ action, agent: "kern", messageId: message!.id, reason: "test" })).rejects.toThrow("external-tier");
      expect((await listMessages("kern"))[0]?.ackedAt).toBeUndefined();
      expect((await listMessages("kern"))[0]?.nackedAt).toBeUndefined();
    } finally { stub.stop(); process.env = saved; rmSync(root, { recursive: true, force: true }); }
  });
}
