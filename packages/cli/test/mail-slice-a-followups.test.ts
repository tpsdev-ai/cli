import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import * as ed from "@noble/ed25519";
import { SnoopLogg } from "snooplogg";
import { routeHandlerAction } from "../src/commands/branch.js";
import { getInbox, MAX_INBOX_MESSAGES, promote, recoverPromoted, sendMessage } from "../src/utils/mail.js";
import { signOutboundBody } from "../src/utils/mail-sign.js";
import { catchUpTopics, createTopic, publishToTopic, subscribe } from "../src/utils/mail-topics.js";

const seed = Buffer.alloc(32, 0x11);
let home: string;
let keys: string;
let savedEnv: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn>;
let warnings: string;
let output: Writable;
let logger: SnoopLogg;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mail-followups-"));
  keys = join(home, "keys");
  mkdirSync(keys);
  savedEnv = {};
  for (const name of ["HOME", "TPS_HOME", "TPS_MAIL_DIR", "TPS_TEST_KEYS_DIR", "TPS_AGENT_ID", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
    savedEnv[name] = process.env[name];
  }
  process.env.HOME = home;
  process.env.TPS_HOME = join(home, ".tps");
  process.env.TPS_MAIL_DIR = join(home, "mail");
  process.env.TPS_TEST_KEYS_DIR = keys;
  process.env.TPS_AGENT_ID = "local-agent";
  process.env.FLAIR_URL = "http://flair.test";
  process.env.FLAIR_KEY_PATH = join(keys, "reader.key");
  writeFileSync(process.env.FLAIR_KEY_PATH, seed);
  writeFileSync(join(keys, "flint.key"), seed);
  writeFileSync(join(keys, "local-agent.key"), seed);
  const publicKey = Buffer.from(ed.getPublicKey(seed)).toString("base64");
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== "http://flair.test") throw new Error(`unexpected request: ${url.origin}`);
    if (url.pathname === "/Health") return new Response("ok");
    const name = url.pathname.match(/^\/Agent\/(.+)$/)?.[1];
    return name && ["flint", "local-agent", "resident"].includes(name)
      ? Response.json({ id: name, publicKey })
      : new Response("not found", { status: 404 });
  });
  warnings = "";
  output = new Writable({ write(chunk, _encoding, done) { warnings += chunk.toString(); done(); } });
  logger = new SnoopLogg().enable("tps:mail").snoop().pipe(output, { colors: false });
});

afterEach(() => {
  fetchSpy.mockRestore();
  logger.unsnoop().unpipe(output);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function logPath() { return join(home, ".tps", "topics", "alerts", "log.jsonl"); }
function stored() { return JSON.parse(readFileSync(logPath(), "utf8").trim()); }
function replaceEntry(entry: unknown) { writeFileSync(logPath(), JSON.stringify(entry) + "\n"); }

async function promotedBodies() {
  const inbox = getInbox("kern");
  const results = await Promise.all(readdirSync(inbox.fresh).map((file) => promote("kern", join(inbox.fresh, file))));
  return results.flatMap((result) => result.ok ? [result.message.body] : []);
}

test("catch-up rejects a log body altered after publication", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  const entry = stored();
  entry.body = "altered";
  replaceEntry(entry);
  const delivered = await catchUpTopics("kern");
  expect(await promotedBodies()).not.toContain("altered");
  expect(delivered).toBe(0);
  expect(warnings).toContain("topic-catch-up-invalid-envelope");
});

test("catch-up promotes the untouched stored envelope without the publisher key", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  const entry = stored();
  rmSync(join(keys, "flint.key"));
  expect(await catchUpTopics("kern")).toBe(1);
  const inbox = getInbox("kern");
  const [file] = readdirSync(inbox.fresh);
  const path = join(inbox.fresh, file!);
  expect(JSON.parse(readFileSync(path, "utf8")).body).toBe(entry.envelope);
  const result = await promote("kern", path);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.message.body).toBe("original");
  expect(result.message.from).toBe("flint");
  expect(result.message.envelope).toEqual(JSON.parse(entry.envelope));
  expect((await recoverPromoted("kern", join(inbox.cur, file!))).ok).toBe(true);
  expect(await catchUpTopics("kern")).toBe(0);
});

test("catch-up skips a pre-change plain entry with a named warning", async () => {
  createTopic("alerts");
  replaceEntry({ id: "legacy-message", topic: "alerts", from: "flint", body: "legacy", timestamp: new Date().toISOString() });
  subscribe("alerts", "kern", true);
  const delivered = await catchUpTopics("kern");
  expect(await promotedBodies()).toEqual([]);
  expect(delivered).toBe(0);
  expect(warnings).toContain("topic-catch-up-unsigned-entry");
  expect(JSON.parse(readFileSync(join(home, ".tps", "agents", "kern", "topic-cursors.json"), "utf8")).alerts).toBe("@legacy-message");
});

for (const type of ["reply", "forward"] as const) {
  test(`branch ${type} to a logical alias promotes under the local identity`, async () => {
    rmSync(join(keys, "flint.key"));
    rmSync(join(keys, "reader.key"));
    process.env.FLAIR_KEY_PATH = join(keys, "local-agent.key");
    expect(readdirSync(keys)).toEqual(["local-agent.key"]);
    const queued: Array<{ to: string; body: string; from: string }> = [];
    const route = routeHandlerAction(
      { type, to: "kern", ...(type === "reply" ? { body: "response" } : {}) },
      { id: "incoming", from: "kern", to: "logical-alias", body: "original" },
      (to, body, from) => queued.push({ to, body, from }),
    );
    expect(route).toEqual({ kind: type, to: "kern" });
    expect(queued).toHaveLength(1);
    const record = queued[0]!;
    expect(record.from).toBe("local-agent");
    const sent = sendMessage(record.to, record.body, record.from);
    const result = await promote("kern", sent.filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.from).toBe("local-agent");
      expect(result.message.body).toBe(type === "reply" ? "response" : "original");
    }
  });
}

test("catch-up rejects altered signed content even when the plain fields agree", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  const entry = stored();
  const envelope = JSON.parse(entry.envelope);
  envelope.body = entry.body = "altered";
  entry.envelope = JSON.stringify(envelope);
  replaceEntry(entry);
  expect(await catchUpTopics("kern")).toBe(0);
  expect(await promotedBodies()).toEqual([]);
  expect(warnings).toContain("topic-catch-up-invalid-envelope");
});

test("fan-out delivers the stored envelope unchanged to each subscriber", async () => {
  createTopic("alerts");
  subscribe("alerts", "kern", true);
  subscribe("alerts", "local-agent", true);
  publishToTopic("alerts", "flint", "original");
  const entry = stored();
  for (const agent of ["kern", "local-agent"]) {
    const inbox = getInbox(agent);
    const [file] = readdirSync(inbox.fresh);
    const path = join(inbox.fresh, file!);
    expect(JSON.parse(readFileSync(path, "utf8")).body).toBe(entry.envelope);
    expect((await promote(agent, path)).ok).toBe(true);
  }
});

test("topic envelopes cannot promote in a non-subscriber's mailbox", async () => {
  createTopic("alerts");
  const signed = signOutboundBody("flint", "topic:alerts", "original", { requireKey: true });
  const sent = sendMessage("kern", signed, "flint");
  const result = await promote("kern", sent.filePath);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.class).toBe("wrong-recipient");
});

test("topic subscriptions do not allow ordinary wrong-recipient envelopes", async () => {
  createTopic("alerts");
  subscribe("alerts", "kern", true);
  const signed = signOutboundBody("flint", "local-agent", "original", { requireKey: true });
  const sent = sendMessage("kern", signed, "flint");
  const result = await promote("kern", sent.filePath);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.class).toBe("wrong-recipient");
});

test("catch-up keeps its cursor on a verification outage and retries", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  const implementation = fetchSpy.getMockImplementation()!;
  fetchSpy.mockImplementation(async () => { throw new Error("offline"); });
  expect(await catchUpTopics("kern")).toBe(0);
  expect(warnings).toContain("topic-catch-up-verification-unavailable");
  fetchSpy.mockImplementation(implementation);
  expect(await catchUpTopics("kern")).toBe(1);
  expect(await promotedBodies()).toEqual(["original"]);
});

test("branch replies retain the identity of a resident recipient", async () => {
  getInbox("resident");
  writeFileSync(join(keys, "resident.key"), seed);
  const queued: Array<{ to: string; body: string; from: string }> = [];
  expect(routeHandlerAction(
    { type: "reply", body: "response" },
    { id: "incoming", from: "kern", to: "resident", body: "original" },
    (to, body, from) => queued.push({ to, body, from }),
  )).toEqual({ kind: "reply", to: "kern" });
  expect(queued[0]!.from).toBe("resident");
});

test("catch-up skips a malformed envelope and still delivers the following publication", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "malformed");
  const entry = stored();
  const envelope = JSON.parse(entry.envelope);
  envelope.delegationChain = [null];
  entry.envelope = JSON.stringify(envelope);
  replaceEntry(entry);
  publishToTopic("alerts", "flint", "valid");
  subscribe("alerts", "kern", true);
  expect(await catchUpTopics("kern")).toBe(1);
  expect(warnings).toContain("topic-catch-up-invalid-envelope");
  expect(await promotedBodies()).toEqual(["valid"]);
});

test("catch-up keeps its cursor before failed delivery and retries", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  const inbox = getInbox("kern");
  for (let i = 0; i < MAX_INBOX_MESSAGES; i++) sendMessage("kern", "occupied", "flint");
  expect(await catchUpTopics("kern")).toBe(0);
  rmSync(inbox.fresh, { recursive: true });
  expect(await catchUpTopics("kern")).toBe(1);
  expect(await promotedBodies()).toEqual(["original"]);
});

test("copying a signed entry into another topic does not deliver it", async () => {
  createTopic("source");
  createTopic("alerts");
  const entry = publishToTopic("source", "flint", "original");
  replaceEntry({ ...entry, topic: "alerts" });
  subscribe("alerts", "kern", true);
  expect(await catchUpTopics("kern")).toBe(0);
  expect(await promotedBodies()).toEqual([]);
  expect(warnings).toContain("topic-catch-up-invalid-envelope");
});

test("topic recipient policy enforces the topic's publisher allowlist", async () => {
  createTopic("alerts", "", ["local-agent"]);
  subscribe("alerts", "kern", true);
  const signed = signOutboundBody("flint", "topic:alerts", "original", { requireKey: true });
  const sent = sendMessage("kern", signed, "flint");
  const result = await promote("kern", sent.filePath);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.class).toBe("wrong-recipient");
});

test("branch aliases use the explicitly configured local identity", () => {
  delete process.env.TPS_AGENT_ID;
  const queued: string[] = [];
  expect(routeHandlerAction(
    { type: "reply", body: "response" },
    { id: "incoming", from: "kern", to: "logical-alias", body: "original" },
    (_to, _body, from) => queued.push(from),
    "local-agent",
  )).toEqual({ kind: "reply", to: "kern" });
  expect(queued).toEqual(["local-agent"]);
});

test("a resident without a signing key refuses instead of falling back", () => {
  getInbox("resident");
  const queued: unknown[] = [];
  const result = routeHandlerAction(
    { type: "reply", body: "response" },
    { id: "incoming", from: "kern", to: "resident", body: "original" },
    (...args) => queued.push(args),
  );
  expect(result.kind).toBe("refused");
  expect(queued).toEqual([]);
});
