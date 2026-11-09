import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkMessages, getInbox, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal, relayAcceptanceReceiptPath } from "../src/utils/relay.js";
import { startUnverifiedFetchFlair } from "./helpers/fetch-flair.js";
import { buildSignedEnvelope } from "./helpers/stub-flair.js";

test("checkMessages leaves a dot-file beside a promoted message (cli#870)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mail-dot-files-"));
  const saved = { ...process.env };
  const seeds = { flint: Buffer.alloc(32, 9), kern: Buffer.alloc(32, 10) };
  const flair = startUnverifiedFetchFlair(seeds);
  try {
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.TPS_AGENT_ID = "kern";
    process.env.FLAIR_URL = flair.url;
    process.env.FLAIR_KEY_PATH = join(root, "key");
    writeFileSync(process.env.FLAIR_KEY_PATH, seeds.kern);
    const envelope = buildSignedEnvelope("flint", "kern", "hello", seeds);
    sendMessage("kern", JSON.stringify(envelope), "flint");
    const inbox = getInbox("kern");
    const scratch = join(inbox.fresh, ".x.json");
    writeFileSync(scratch, "{ not mail");

    const messages = await checkMessages("kern");

    expect(messages.map((message) => message.envelopeId)).toEqual([envelope.messageId]);
    expect(readdirSync(inbox.fresh)).toEqual([".x.json"]);
    expect(readFileSync(scratch, "utf8")).toBe("{ not mail");
    expect(readdirSync(inbox.cur)).toHaveLength(1);
    expect(readdirSync(inbox.dlq)).toEqual([]);
  } finally {
    flair.stop();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the relay undo leaves a dot-file in new/ beside the record it removes (cli#870)", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-dot-undo-"));
  const saved = { ...process.env };
  try {
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = join(root, "mail");
    const delivery = { id: randomUUID(), from: "remote", to: "local", content: "payload", timestamp: "2026-01-01T00:00:00.000Z" };
    // Occupy the receipt's exclusive temp path, for the bucket of this run and
    // the next day's, so the acceptance write fails after the relayed record is
    // published and the undo scans new/.
    for (const at of [Date.now(), Date.now() + 86_400_000]) {
      const marker = relayAcceptanceReceiptPath("remote", delivery.id, at);
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(`${marker}.tmp`, "occupied");
    }
    const inbox = getInbox("local");
    const scratch = join(inbox.fresh, ".x.json");
    writeFileSync(scratch, "{ not mail");

    expect(() => deliverRelayedToLocal("remote", delivery)).toThrow("relay acceptance receipt write failed; retry delivery");

    expect(readdirSync(inbox.fresh)).toEqual([".x.json"]);
    expect(readFileSync(scratch, "utf8")).toBe("{ not mail");
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
