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
import { catchUpTopics, createTopic, publishToTopic, subscribe, updateCursor } from "../src/utils/mail-topics.js";
import { MailClient } from "../../agent/src/io/mail.js";

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

function cursorBytes() {
  return readFileSync(join(home, ".tps", "agents", "kern", "topic-cursors.json"), "utf8");
}

test("native MailClient delivers publisher-signed topic fan-out", async () => {
  createTopic("alerts", "", ["flint"]);
  subscribe("alerts", "kern", true);
  const entry = publishToTopic("alerts", "flint", "original");
  const client = new MailClient(join(home, "mail"), undefined, "kern", {
    async getAgent(name) { return name === "flint" ? { publicKey: Buffer.from(ed.getPublicKey(seed)) } : null; },
  });
  const messages = await client.checkNewMail();
  expect(messages).toHaveLength(1);
  expect(messages[0]!.from).toBe("flint");
  expect(messages[0]!.verifiedEnvelope).toEqual(JSON.parse(entry.envelope!));
  expect(readdirSync(getInbox("kern").fresh)).toEqual([]);
  expect(readdirSync(getInbox("kern").cur)).toHaveLength(1);
});

for (const policy of ["unsubscribed", "disallowed-publisher", "ordinary-recipient", "invalid-topic", "unreadable-meta"] as const) {
  test(`native MailClient rejects topic policy violation: ${policy}`, async () => {
    createTopic("alerts", "", policy === "disallowed-publisher" ? ["local-agent"] : ["flint"]);
    if (policy !== "unsubscribed") subscribe("alerts", "kern", true);
    if (policy === "unreadable-meta") writeFileSync(join(home, ".tps", "topics", "alerts", "meta.json"), "{");
    const to = policy === "ordinary-recipient" ? "local-agent" : policy === "invalid-topic" ? "topic:../alerts" : "topic:alerts";
    const sent = sendMessage("kern", signOutboundBody("flint", to, "original", { requireKey: true }), "flint");
    const client = new MailClient(join(home, "mail"), undefined, "kern", {
      async getAgent() { return { publicKey: Buffer.from(ed.getPublicKey(seed)) }; },
    });
    expect(await client.checkNewMail()).toEqual([]);
    expect(readdirSync(getInbox("kern").cur)).toEqual([]);
    const file = sent.filePath.split("/").pop()!;
    expect(readFileSync(join(home, "mail", "kern", "dlq", `${file}.reason`), "utf8")).toContain("class: wrong-recipient");
  });
}

for (const status of [401, 403, 500]) {
  test(`catch-up preserves its cursor when healthy Flair rejects lookup with ${status}`, async () => {
    createTopic("alerts");
    publishToTopic("alerts", "flint", "first");
    publishToTopic("alerts", "flint", "second");
    subscribe("alerts", "kern", true);
    updateCursor("kern", "alerts", "1970-01-01T00:00:00Z");
    const before = cursorBytes();
    const healthy = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/Health") return new Response("ok");
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^TPS-Ed25519 kern:/);
      return new Response("lookup refused", { status });
    });
    expect(await fetch("http://flair.test/Health").then((r) => r.ok)).toBe(true);
    expect(await catchUpTopics("kern")).toBe(0);
    expect(cursorBytes()).toBe(before);
    expect(readdirSync(getInbox("kern").fresh)).toEqual([]);
    expect(warnings).toContain("topic-catch-up-verification-unavailable");
    expect(warnings).not.toContain("skipping");
    fetchSpy.mockImplementation(healthy);
    expect(await catchUpTopics("kern")).toBe(2);
  });
}

test("catch-up skips a verifiably absent principal with its named warning", async () => {
  createTopic("alerts");
  const entry = publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  updateCursor("kern", "alerts", "1970-01-01T00:00:00Z");
  fetchSpy.mockImplementation(async (input) => new URL(String(input)).pathname === "/Health"
    ? new Response("ok") : new Response("not found", { status: 404 }));
  expect(await catchUpTopics("kern")).toBe(0);
  expect(JSON.parse(cursorBytes()).alerts).toBe(`@${entry.id}`);
  expect(readdirSync(getInbox("kern").fresh)).toEqual([]);
  expect(warnings).toContain("topic-catch-up-unresolvable-principal");
  expect(warnings).not.toContain("topic-catch-up-invalid-envelope");
});

test("catch-up authenticates with the runtime's configured endpoint and key", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  const runtimeSeed = Buffer.alloc(32, 0x22);
  const flairKeyPath = join(keys, "runtime.key");
  writeFileSync(flairKeyPath, runtimeSeed);
  const requests: string[] = [];
  fetchSpy.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.origin);
    const auth = new Headers(init?.headers).get("Authorization")!;
    const [agent, timestamp, nonce, signature] = auth.slice("TPS-Ed25519 ".length).split(":");
    const payload = Buffer.from(`${agent}:${timestamp}:${nonce}:GET:${url.pathname}`);
    if (url.origin !== "http://runtime-flair.test" || agent !== "kern"
      || !ed.verify(Buffer.from(signature!, "base64"), payload, ed.getPublicKey(runtimeSeed))) {
      return new Response("invalid credential", { status: 401 });
    }
    return Response.json({ id: "flint", publicKey: Buffer.from(ed.getPublicKey(seed)).toString("base64") });
  });
  expect(await catchUpTopics("kern", undefined, { flairUrl: "http://runtime-flair.test", flairKeyPath })).toBe(1);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => url === "http://runtime-flair.test")).toBe(true);
});

for (const record of [null, {}, { publicKey: "bad-key" }]) {
  test(`catch-up keeps its cursor for an indeterminate principal record: ${JSON.stringify(record)}`, async () => {
    createTopic("alerts");
    publishToTopic("alerts", "flint", "original");
    subscribe("alerts", "kern", true);
    updateCursor("kern", "alerts", "1970-01-01T00:00:00Z");
    const before = cursorBytes();
    fetchSpy.mockImplementation(async () => Response.json(record));
    expect(await catchUpTopics("kern")).toBe(0);
    expect(cursorBytes()).toBe(before);
    expect(warnings).toContain("topic-catch-up-verification-unavailable");
    expect(warnings).not.toContain("skipping");
  });
}

test("indeterminate verification stops catch-up before any later topic", async () => {
  for (const topic of ["alerts", "later"]) {
    createTopic(topic);
    publishToTopic(topic, "flint", "original");
    subscribe(topic, "kern", true);
    updateCursor("kern", topic, "1970-01-01T00:00:00Z");
  }
  const before = cursorBytes();
  const healthy = fetchSpy.getMockImplementation()!;
  fetchSpy.mockImplementationOnce(async () => new Response("unauthorized", { status: 401 }));
  expect(await catchUpTopics("kern", ["alerts", "later"])).toBe(0);
  expect(cursorBytes()).toBe(before);
  expect(readdirSync(getInbox("kern").fresh)).toEqual([]);
  fetchSpy.mockImplementation(healthy);
  expect(await catchUpTopics("kern", ["alerts", "later"])).toBe(2);
});

test("catch-up keeps its cursor when local topic policy cannot be read", async () => {
  createTopic("alerts");
  publishToTopic("alerts", "flint", "original");
  subscribe("alerts", "kern", true);
  updateCursor("kern", "alerts", "1970-01-01T00:00:00Z");
  const before = cursorBytes();
  writeFileSync(join(home, ".tps", "topics", "alerts", "meta.json"), "{");
  expect(await catchUpTopics("kern", ["alerts"])).toBe(0);
  expect(cursorBytes()).toBe(before);
  expect(warnings).toContain("topic-catch-up-recipient-policy-unavailable");
});

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
