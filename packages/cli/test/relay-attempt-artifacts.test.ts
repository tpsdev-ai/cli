import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInbox, MAX_INBOX_MESSAGES, sendMessage } from "../src/utils/mail.js";
import { deliverRelayedToLocal, relayAcceptanceReceiptPath } from "../src/utils/relay.js";

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "relay-attempt-artifacts-"));
  saved = Object.fromEntries(["HOME", "TPS_MAIL_DIR"].map((key) => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = join(root, "mail");
});

afterEach(() => { mock.restore(); });

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function body() {
  return { id: randomUUID(), from: "remote", to: "local", content: "payload", timestamp: new Date().toISOString() };
}

function records(): string[] {
  return fs.readdirSync(getInbox("local").fresh).filter((file) => file.endsWith(".json"));
}

function failOn(name: "renameSync" | "unlinkSync", match: (path: string) => boolean, message: string) {
  const real = fs[name] as (...args: any[]) => unknown;
  return spyOn(fs, name).mockImplementation(((...args: any[]) => {
    if (match(String(args[name === "renameSync" ? 1 : 0]))) throw new Error(message);
    return real(...args);
  }) as any);
}

function refusalOf(item: ReturnType<typeof body>): string {
  try { deliverRelayedToLocal("remote", item); } catch (error) { return String(error); }
  return "";
}

test("receipt temp: rename fails and the temp delete fails -> incomplete-recovery refusal", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  const rename = failOn("renameSync", (path) => path === marker, "injected receipt rename failure");
  const unlink = failOn("unlinkSync", (path) => path === `${marker}.tmp`, "injected temp delete failure");
  let refusal = "";
  try { refusal = refusalOf(item); }
  finally { unlink.mockRestore(); rename.mockRestore(); }
  expect(refusal).toContain("relay receipt recovery incomplete");
  expect(refusal).toContain("retry may duplicate");
  expect(refusal).not.toContain("retry delivery");
});

test("receipt temp: rename fails and the temp delete succeeds -> retryable refusal, no temp left", () => {
  const item = body();
  const marker = relayAcceptanceReceiptPath("remote", item.id);
  const rename = failOn("renameSync", (path) => path === marker, "injected receipt rename failure");
  let refusal = "";
  try { refusal = refusalOf(item); }
  finally { rename.mockRestore(); }
  expect(refusal).toContain("relay acceptance receipt write failed; retry delivery");
  expect(fs.existsSync(`${marker}.tmp`)).toBe(false);
  expect(records()).toEqual([]);
});

function fillInbox(): void {
  for (let i = 0; i < MAX_INBOX_MESSAGES; i++) sendMessage("local", `filler-${i}`, "seeder");
}

test("dead-letter sidecar: publish fails and the sidecar delete fails -> incomplete-recovery refusal", () => {
  const item = body();
  fillInbox();
  const dlq = getInbox("local").dlq;
  const rename = failOn("renameSync", (path) => path.startsWith(dlq), "injected dead-letter publish failure");
  const unlink = failOn("unlinkSync", (path) => path.endsWith(".reason"), "injected sidecar delete failure");
  let refusal = "";
  try { refusal = refusalOf(item); }
  finally { unlink.mockRestore(); rename.mockRestore(); }
  expect(refusal).toContain("relay record recovery incomplete");
  expect(refusal).toContain("retry may duplicate");
  expect(refusal).not.toContain("retry delivery");
});

test("dead-letter sidecar: publish fails and the sidecar delete succeeds -> no sidecar left", () => {
  const item = body();
  fillInbox();
  const dlq = getInbox("local").dlq;
  const rename = failOn("renameSync", (path) => path.startsWith(dlq), "injected dead-letter publish failure");
  let refusal = "";
  try { refusal = refusalOf(item); }
  finally { rename.mockRestore(); }
  expect(refusal).toContain("relay dead-letter failed; retry delivery");
  expect(fs.readdirSync(dlq).filter((file) => file.endsWith(".reason"))).toEqual([]);
  expect(records()).toHaveLength(MAX_INBOX_MESSAGES);
});
