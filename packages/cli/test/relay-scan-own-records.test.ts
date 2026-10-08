/**
 * relay-scan-own-records.test.ts — cli#560.
 *
 * The relay scan that dedupes a relayed delivery used to read every mailbox
 * under the mail root and quarantine every record it could not parse as its
 * own relay format. A record written by the agent runtime's own mail writer
 * (`{from,to,body,sentAt}`, no relay fields) is valid mail but not relay mail,
 * so an unrelated relay accept moved a runtime-written message out of its
 * recipient's `new/` and into `quarantine/`.
 *
 * The first two tests write the message with the REAL agent MailClient, accept one
 * unrelated relayed delivery, and assert the runtime message is still in
 * `new/` and is received.
 * The third writes a malformed relay record directly in another agent's mailbox
 * and checks that it stays in place.
 */
import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MailClient } from "@tpsdev-ai/agent";
import { deliverRelayedToLocal } from "../src/utils/relay.js";
import { getInbox } from "../src/utils/mail.js";
import { buildSignedEnvelope, pubkeyFromSeed, writeKeyFile } from "./helpers/stub-flair.js";

const SEEDS = {
  alice: Buffer.alloc(32, 0x31),
  bob: Buffer.alloc(32, 0x32),
  carol: Buffer.alloc(32, 0x33),
  remote: Buffer.alloc(32, 0x34),
};

describe("relay acceptance leaves runtime-written records in place (cli#560)", () => {
  let root: string;
  let mail: string;
  let keys: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-relay-scan-"));
    mail = join(root, "mail");
    keys = join(root, "keys");
    writeKeyFile(keys, "alice", SEEDS.alice);
    writeKeyFile(keys, "bob", SEEDS.bob);
    savedEnv = {};
    for (const key of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) savedEnv[key] = process.env[key];
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = mail;
    process.env.FLAIR_URL = "http://flair.invalid";
    process.env.FLAIR_KEY_PATH = writeKeyFile(keys, "signer", SEEDS.remote);
  });

  afterEach(() => {
    mock.restore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function verifier() {
    return {
      async getAgent(id: string): Promise<{ publicKey: Buffer } | null> {
        const seed = SEEDS[id as keyof typeof SEEDS];
        return seed ? { publicKey: pubkeyFromSeed(seed) } : null;
      },
    };
  }

  function jsonFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  /** A runtime-written message: the agent MailClient writes it, deliverOutbox moves it to bob/new. */
  async function runtimeWriteToBob(body: string): Promise<string> {
    const alice = new MailClient(mail, undefined, "alice", verifier(), join(keys, "alice.key"));
    await alice.sendMail("bob", body);
    alice.deliverOutbox();
    const [file] = jsonFiles(getInbox("bob").fresh);
    expect(file).toBeDefined();
    return readFileSync(join(getInbox("bob").fresh, file!), "utf8");
  }

  test("a runtime-written message survives an unrelated relay accept for another recipient and is received", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const written = await runtimeWriteToBob("hello bob");
    const envelope = JSON.parse(written);
    expect(envelope.sentAt).toBeString();
    expect(envelope.relayDelivery).toBeUndefined();

    const accepted = deliverRelayedToLocal("remote", {
      id: randomUUID(),
      from: "remote",
      to: "carol",
      content: "x",
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    expect(accepted).toBe(true);

    // bob's runtime-written message is untouched: still in new/, nothing quarantined.
    const bob = getInbox("bob");
    expect(jsonFiles(bob.fresh)).toHaveLength(1);
    expect(readFileSync(join(bob.fresh, jsonFiles(bob.fresh)[0]!), "utf8")).toBe(written);
    expect(existsSync(join(bob.root, "quarantine"))).toBe(false);
    expect(errors).not.toHaveBeenCalled();

    // ... and bob's runtime receives it.
    const bobClient = new MailClient(mail, undefined, "bob", verifier(), join(keys, "bob.key"));
    const received = await bobClient.checkNewMail();
    expect(received).toHaveLength(1);
    expect(received[0]!.from).toBe("alice");
    expect(JSON.parse(JSON.parse(received[0]!.body).body).body).toBe("hello bob");
  });

  test("a runtime-written record in the recipient's own inbox survives a relay accept to that recipient", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const written = await runtimeWriteToBob("keep me");
    const relayed = JSON.stringify(buildSignedEnvelope("remote", "bob", "relayed to bob", SEEDS));

    const accepted = deliverRelayedToLocal("remote", {
      id: randomUUID(),
      from: "remote",
      to: "bob",
      content: relayed,
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    expect(accepted).toBe(true);

    // The runtime-written record is untouched; the relayed delivery is added.
    const bob = getInbox("bob");
    const records = jsonFiles(bob.fresh).map((file) => JSON.parse(readFileSync(join(bob.fresh, file), "utf8")));
    expect(records).toHaveLength(2);
    const survivor = records.find((record) => record.sentAt !== undefined);
    expect(survivor).toMatchObject({ from: "alice", to: "bob" });
    expect(survivor!.relayDelivery).toBeUndefined();
    const survivorFile = jsonFiles(bob.fresh).find((f) => JSON.parse(readFileSync(join(bob.fresh, f), "utf8")).sentAt !== undefined)!;
    expect(readFileSync(join(bob.fresh, survivorFile), "utf8")).toBe(written);
    expect(records.some((record) => record.relayDelivery?.branchId === "remote")).toBe(true);

    // bob's runtime receives the runtime-written message.
    const bobClient = new MailClient(mail, undefined, "bob", verifier(), join(keys, "bob.key"));
    const received = await bobClient.checkNewMail();
    expect(received).toHaveLength(2);
    expect(received.map((message) => JSON.parse(JSON.parse(message.body).body).body)).toContain("keep me");
  });

  test("a malformed relay record in another agent's mailbox is left where it is", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const inbox = getInbox("bob");
    const foreign = `{"relayDelivery":{"branchId":"remote","id":"${randomUUID()}"},`;
    const source = join(inbox.fresh, "foreign.json");
    writeFileSync(source, foreign);

    const accepted = deliverRelayedToLocal("remote", {
      id: randomUUID(),
      from: "remote",
      to: "carol",
      content: "x",
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    expect(accepted).toBe(true);

    expect(readFileSync(source, "utf8")).toBe(foreign);
    expect(existsSync(join(inbox.root, "quarantine"))).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });
});
