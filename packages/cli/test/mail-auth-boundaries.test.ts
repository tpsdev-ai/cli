/** Real promote() policy with an in-process public-key provider; no socket bind. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";

hashes.sha512 = (data) => new Uint8Array(createHash("sha512").update(data).digest());
const seeds: Record<string, Buffer> = {
  anvil: Buffer.alloc(32, 0x22),
  host: Buffer.alloc(32, 0x33),
};
mock.module("../src/utils/mail-verify.js", () => ({
  createMailVerifyClient: async () => ({
    getAgent: async (name: string) => seeds[name]
      ? { publicKey: Buffer.from(ed.getPublicKey(seeds[name]!)) }
      : null,
  }),
}));
const { promote, sendMessage } = await import("../src/utils/mail.js");
const { routeHandlerAction } = await import("../src/commands/branch.js");
const { healthMail } = await import("../src/commands/bootstrap.js");
const { MailClient } = await import("../../agent/src/io/mail.js");

let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auth-boundary-"));
  const keys = join(root, "keys");
  mkdirSync(keys);
  for (const [name, seed] of Object.entries(seeds)) writeFileSync(join(keys, `${name}.key`), seed);
  saved = {};
  for (const name of ["HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR"]) saved[name] = process.env[name];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
  process.env.TPS_TEST_KEYS_DIR = keys;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function promoteOne(recipient: string) {
  const dir = join(root, "mail", recipient, "new");
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  return promote(recipient, join(dir, files[0]!));
}

test("unchanged branch forward is re-signed by the forwarder and really promotes", async () => {
  const queued: Array<{ to: string; body: string; from: string }> = [];
  const original = '{"signed":"original"}';
  const result = routeHandlerAction(
    { type: "forward", to: "kern", body: original },
    { id: "m1", from: "flint", to: "anvil", body: original },
    (to, body, from) => queued.push({ to, body, from }),
  );
  expect(result.kind).toBe("forward");
  expect(queued).toHaveLength(1);
  sendMessage(queued[0]!.to, queued[0]!.body, queued[0]!.from);
  const accepted = await promoteOne("kern");
  expect(accepted.ok).toBe(true);
  if (accepted.ok) {
    expect(accepted.message.from).toBe("anvil");
    expect(accepted.message.body).toBe(original);
  }
});

test("MailClient output passes the same promote policy", async () => {
  const client = new MailClient(join(root, "mail"), undefined, "anvil");
  await client.sendMail("kern", "runtime mail");
  const outbox = join(root, "mail", "anvil", "outbox");
  const file = readdirSync(outbox).find((f) => f.endsWith(".json"))!;
  const record = JSON.parse(readFileSync(join(outbox, file), "utf8"));
  sendMessage("kern", record.body, record.from);
  const accepted = await promoteOne("kern");
  expect(accepted.ok).toBe(true);
});

test("bootstrap health requires actual promotion and fails a wrong registered key", async () => {
  expect(await healthMail("kern", "host")).toBe(true);
  writeFileSync(join(root, "keys", "host.key"), Buffer.alloc(32, 0x55));
  expect(await healthMail("kern", "host")).toBe(false);
  const cur = join(root, ".tps", "branch-office", "kern", "mail", "cur");
  expect(existsSync(cur) ? readdirSync(cur).filter((f) => f.endsWith(".json")) : []).toHaveLength(1);
});
