import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailClient } from "../src/io/mail.js";
import { relayAcceptanceLockRoot } from "../src/lib/relay-lock.js";
import { senderKeyResolver, signedRelayRecord } from "./helpers/signed-relay-record.js";

let root: string;
let savedMailDir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-relay-reservation-"));
  savedMailDir = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = root;
});
afterEach(() => {
  if (savedMailDir === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = savedMailDir;
  rmSync(root, { recursive: true, force: true });
});

// These reservation cases align TPS_MAIL_DIR with MailClient.mailDir.
for (const valid of [true, false]) {
  test(`MailClient ${valid ? "promotion" : "dead-lettering"} leaves a same-id source in place while its stripe is reserved`, async () => {
    const client = new MailClient(root, undefined, "mailbox", senderKeyResolver());
    const source = join(root, "mailbox", "new", "m1.json");
    const relayDelivery = { branchId: "remote", id: "reserved" };
    const raw = valid
      ? signedRelayRecord("mailbox", "reserved", relayDelivery)
      : JSON.stringify({ from: "sender", body: "invalid", relayDelivery });
    writeFileSync(source, raw);
    const script = join(root, "holder.ts");
    writeFileSync(script, `
const { acquireMailLockSync } = await import(${JSON.stringify(new URL("../src/lib/mail-lock.js", import.meta.url).href)});
const lock = acquireMailLockSync(${JSON.stringify(relayAcceptanceLockRoot("remote", "reserved"))});
if (!lock) throw new Error("holder could not acquire");
process.stdout.write("ready");
process.stdin.once("data", () => { lock.release(); process.exit(0); });
`);
    const child = spawn("bun", [script], { env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
      child.once("exit", () => reject(new Error("holder exited before ready")));
    });
    try {
      expect(await client.checkNewMail()).toEqual([]);
      expect(readFileSync(source, "utf8")).toBe(raw);
      expect(existsSync(join(root, "mailbox", "cur", "m1.json"))).toBe(false);
      expect(existsSync(join(root, "mailbox", "dlq", "m1.json"))).toBe(false);
    } finally {
      child.stdin.end("release");
      expect(await exited).toBe(0);
    }
    expect(await client.checkNewMail()).toHaveLength(valid ? 1 : 0);
    expect(existsSync(join(root, "mailbox", valid ? "cur" : "dlq", "m1.json"))).toBe(true);
  });
}
