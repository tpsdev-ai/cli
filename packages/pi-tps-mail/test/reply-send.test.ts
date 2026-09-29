// Test: the watcher's inbound and reply path (cli#429).
//
//   - The inbound is VERIFIED before any field is used: the watcher dispatches
//     only what `tps mail check --json` (the CLI's promotion path) returns. An
//     unsigned or forged inbound is dead-lettered by the CLI and never
//     dispatched or answered.
//   - The reply goes on STDIN, threaded (`--reply-to`) to the inbound's
//     VERIFIED envelope messageId, signed with a messageId the reply journal
//     fixes (`--message-id`), and the inbound is acknowledged only after a
//     successful send.
//   - A send whose outcome is unknown (a non-zero exit or a timeout AFTER the
//     CLI delivered) is re-sent as the SAME message (same messageId, text and
//     thread), which the recipient's replay gate discards.
//   - An ack that fails is retried without re-sending; a restart finishes the
//     journal (re-ack, or re-send the same message); an inbound stranded in
//     cur/ with no journal entry is re-presented when its lease expires.
//
// Everything runs against the REAL `tps` CLI (through an argv-recording
// wrapper that can inject a fault once) and a stub Flair, inside a throwaway
// root: HOME, the maildirs and the key dirs are all under it, so nothing
// touches a real ~/.tps or ~/.flair.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyEnvelope, type Envelope } from "@tpsdev-ai/agent";
import { buildSignedEnvelope, pubkeyFromSeed, startStubFlair, type StubFlair } from "../../cli/test/helpers/stub-flair.js";
import { watchMail } from "../src/index.js";

const TPS_TS = resolve(import.meta.dir, "../../cli/bin/tps.ts");
const THREAD = "5f0c8a52-3d1e-4b7a-9c2f-7e6d5c4b3a21"; // the inbound envelope's signed messageId
const FLINT_SEED = Buffer.alloc(32, 0x0f); // the sender
const EMBER_SEED = Buffer.alloc(32, 0x0e); // the watched agent (signs replies)
const OTHER_SEED = Buffer.alloc(32, 0x0d); // a key nobody registered
const ENV_KEYS = [
  "HOME",
  "TPS_MAIL_DIR",
  "TPS_TEST_KEYS_DIR",
  "TPS_BIN",
  "TPS_VAULT_KEY",
  "TPS_AGENT_ID",
  "FLAIR_URL",
  "FLAIR_KEY_PATH",
] as const;

let root: string;
let stub: StubFlair;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let stop: (() => Promise<void>) | null = null;

const p = {
  mail: () => join(root, ".tps", "mail"),
  emberNew: () => join(root, ".tps", "mail", "ember", "new"),
  emberCur: () => join(root, ".tps", "mail", "ember", "cur"),
  emberDlq: () => join(root, ".tps", "mail", "ember", "dlq"),
  journal: () => join(root, ".tps", "mail", "ember", ".pi-tps-mail", "replies"),
  flintNew: () => join(root, ".tps", "mail", "flint", "new"),
  flintDlq: () => join(root, ".tps", "mail", "flint", "dlq"),
  keys: () => join(root, "keys"),
  argvLog: () => join(root, "tps-argv.log"),
  launcherLog: () => join(root, "agents", "ember", "launcher-calls.log"),
  launcher: () => join(root, "agents", "ember", "bin", "ember"),
  marker: (name: string) => join(root, name),
};

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
}
function jsonFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}
const sends = () => lines(p.argvLog()).filter((l) => l.startsWith("mail send"));
const acks = () => lines(p.argvLog()).filter((l) => l.startsWith("mail ack"));
const messageIdOf = (argv: string) => /--message-id (\S+)/.exec(argv)?.[1];
async function until(pred: () => boolean, ms = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}
async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-tps-mail-reply-"));
  mkdirSync(p.emberNew(), { recursive: true });
  mkdirSync(p.emberCur(), { recursive: true });
  mkdirSync(p.flintNew(), { recursive: true }); // flint is a LOCAL agent
  mkdirSync(p.keys(), { recursive: true });
  mkdirSync(join(root, "agents", "ember", "bin"), { recursive: true });
  // The key the verifying Flair client authenticates its reads with (the stub
  // ignores it). Separate from ember's SIGNING key, which a test may withhold.
  writeFileSync(join(root, "flair-auth.key"), Buffer.alloc(32, 0x0c));
  stub = startStubFlair({ flint: FLINT_SEED, ember: EMBER_SEED });

  // The launcher: records each call and the body it was given, answers with a fixed reply.
  writeFileSync(p.launcher(), `#!/bin/sh\nprintf 'call %s\\n' "$1" >> "${p.launcherLog()}"\nprintf 'reply from ember'\n`);
  chmodSync(p.launcher(), 0o755);

  // TPS_BIN: records argv (so the test can prove the reply is NOT in it), can
  // inject ONE fault per marker file, then runs the real CLI.
  const bun = process.execPath;
  const wrapper = join(root, "tps-wrapper.sh");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `echo "$*" >> "${p.argvLog()}"`,
      `if [ "$1 $2" = "mail send" ] && [ -f "${p.marker("fail-send-once")}" ]; then`,
      `  rm -f "${p.marker("fail-send-once")}"; "${bun}" "${TPS_TS}" "$@"; exit 1`,
      "fi",
      `if [ "$1 $2" = "mail send" ] && [ -f "${p.marker("hang-send-once")}" ]; then`,
      `  rm -f "${p.marker("hang-send-once")}"; "${bun}" "${TPS_TS}" "$@"; exec sleep 30`,
      "fi",
      `if [ "$1 $2" = "mail ack" ] && [ -f "${p.marker("fail-ack-once")}" ]; then`,
      `  rm -f "${p.marker("fail-ack-once")}"; exit 1`,
      "fi",
      `exec "${bun}" "${TPS_TS}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);

  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = root;
  process.env.TPS_MAIL_DIR = p.mail();
  process.env.TPS_TEST_KEYS_DIR = p.keys();
  process.env.TPS_BIN = wrapper;
  process.env.TPS_VAULT_KEY = "test-vault-key";
  process.env.FLAIR_URL = stub.url;
  process.env.FLAIR_KEY_PATH = join(root, "flair-auth.key");
  delete process.env.TPS_AGENT_ID;
});

afterEach(async () => {
  await stop?.();
  stop = null;
  stub.stop();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const provisionEmberKey = () => writeFileSync(join(p.keys(), "ember.key"), EMBER_SEED);

/** Plant an inbound in ember's new/: by default a GENUINE envelope flint signed. */
function plantInbound(body?: string): string {
  const envelopeBody = body ?? JSON.stringify(buildSignedEnvelope("flint", "ember", "please answer", { flint: FLINT_SEED }, { messageId: THREAD }));
  const file = join(p.emberNew(), "2026-09-28T00-00-00-in-1.json");
  writeFileSync(file, JSON.stringify({ id: "in-1", from: "flint", to: "ember", body: envelopeBody, timestamp: new Date().toISOString(), read: false }));
  return file;
}

/** The real CLI, as `agent`, against this root (for fixtures and for reading flint's side). */
async function cli(agent: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TPS_TS, ...args], {
    cwd: root,
    env: { ...process.env, TPS_AGENT_ID: agent, TPS_MAIL_DIR: p.mail() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { status, stdout, stderr };
}

/** Promote the planted inbound into cur/ exactly as the CLI does (verified). */
async function promoteInbound(): Promise<string> {
  const r = await cli("ember", ["mail", "check", "ember", "--json"]);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).map((m: any) => m.id)).toEqual(["in-1"]);
  const [cur] = jsonFiles(p.emberCur());
  return join(p.emberCur(), cur!);
}

function writeJournalEntry(entry: Record<string, unknown>): void {
  mkdirSync(p.journal(), { recursive: true });
  writeFileSync(join(p.journal(), "in-1.json"), JSON.stringify({ v: 1, inboundId: "in-1", to: "flint", threadId: THREAD, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...entry }));
}

function start(opts: { retryBackoffMs?: number; sendTimeoutMs?: number; rescanIntervalMs?: number } = {}): void {
  const w = watchMail({
    agent: "ember",
    inboxRoot: root,
    launcher: p.launcher(),
    timeoutMs: 10_000,
    pollIntervalMs: 50,
    retryBackoffMs: opts.retryBackoffMs ?? 200,
    sendTimeoutMs: opts.sendTimeoutMs,
    rescanIntervalMs: opts.rescanIntervalMs,
  });
  stop = async () => {
    w.stop();
    await w.drain(); // nothing the watcher started outlives the test's root
  };
}

/** The replies flint has received, as their signed envelopes. */
function flintReplies(): Envelope[] {
  return jsonFiles(p.flintNew()).map((f) => JSON.parse(JSON.parse(readFileSync(join(p.flintNew(), f), "utf-8")).body) as Envelope);
}

async function expectVerifiedReply(env: Envelope): Promise<void> {
  expect(env.from).toBe("ember");
  expect(env.to).toBe("flint");
  expect(env.body).toBe("reply from ember");
  expect(env.replyToId, "threaded to the VERIFIED inbound envelope id").toBe(THREAD);
  const v = await verifyEnvelope(env, {
    async getAgent(name: string) {
      return name === "ember" ? { publicKey: pubkeyFromSeed(EMBER_SEED) } : null;
    },
  });
  expect(v).toEqual({ ok: true });
}

/** Wait until the inbound is fully done: replied, acked, nothing left in cur/ or the journal. */
async function expectDone(): Promise<void> {
  expect(await until(() => acks().length > 0 && jsonFiles(p.emberCur()).length === 0), "acked and gone from cur/").toBe(true);
  expect(await until(() => jsonFiles(p.journal()).length === 0), "the journal entry is removed").toBe(true);
}

describe("watcher: the inbound is VERIFIED before any field is used (cli#429)", () => {
  it("a genuine inbound: the launcher gets the VERIFIED body; the reply is signed, on stdin, threaded, with the journal's messageId; then acked", async () => {
    provisionEmberKey();
    plantInbound();
    start();
    expect(await until(() => flintReplies().length === 1), "the reply was delivered").toBe(true);
    await expectDone();

    expect(lines(p.launcherLog()), "the launcher ran once, on the verified plaintext body").toEqual(["call please answer"]);
    const [send] = sends();
    expect(sends().length).toBe(1);
    expect(send).toContain("--stdin");
    expect(send).toContain(`--reply-to ${THREAD}`);
    expect(send!.includes("reply from ember"), "the reply body is never in argv").toBe(false);
    const [env] = flintReplies();
    await expectVerifiedReply(env!);
    expect(env!.messageId, "signed with the journal's messageId").toBe(messageIdOf(send!));
    // The ack came AFTER the send.
    const argv = lines(p.argvLog());
    expect(argv.findIndex((l) => l.startsWith("mail ack"))).toBeGreaterThan(argv.indexOf(send!));
  }, 40000);

  const forgeries: Array<[string, () => string]> = [
    [
      "UNSIGNED (an envelope-shaped body claiming a messageId, no signature)",
      () => JSON.stringify({ v: 1, from: "flint", to: "ember", body: "please answer", messageId: THREAD, timestamp: new Date().toISOString() }),
    ],
    [
      "FORGED (claims flint, signed with a key Flair does not hold for flint)",
      () => JSON.stringify(buildSignedEnvelope("flint", "ember", "please answer", { flint: OTHER_SEED }, { messageId: THREAD })),
    ],
  ];
  for (const [label, body] of forgeries) {
    it(`an ${label} inbound is dead-lettered by the CLI — never dispatched, never answered, never acked`, async () => {
      // CONTROL: before this change the watcher read new/ itself and replied to
      // the messageId an unverified body claimed.
      provisionEmberKey();
      plantInbound(body());
      start({ rescanIntervalMs: 100 });
      expect(await until(() => jsonFiles(p.emberDlq()).length === 1), "dead-lettered").toBe(true);
      await settle(800); // several polls and rescans
      expect(lines(p.launcherLog()), "the launcher never ran").toEqual([]);
      expect(sends(), "no reply was ever sent").toEqual([]);
      expect(acks(), "never acknowledged").toEqual([]);
      expect(jsonFiles(p.flintNew())).toEqual([]);
      expect(jsonFiles(p.journal())).toEqual([]);
    }, 40000);
  }
});

describe("watcher: a reply is sent as ONE message, whatever the send's outcome (cli#429)", () => {
  it("NO signing key: the send is refused, the inbound is NOT acked; once the key exists the SAME message is re-sent (launcher not re-run)", async () => {
    plantInbound();
    start({ retryBackoffMs: 300 });
    // Wait for the first attempt to have FAILED (the journal records the
    // attempt only then), not merely started — a key provisioned while the
    // first CLI run is still starting would let that run sign.
    const journaled = () => {
      try {
        return JSON.parse(readFileSync(join(p.journal(), "in-1.json"), "utf-8"));
      } catch {
        return null;
      }
    };
    expect(await until(() => journaled()?.attempts >= 1 && journaled()?.state === "prepared"), "the first send failed").toBe(true);
    expect(sends().length).toBe(1);
    expect(acks(), "NEVER acknowledged after a refused send").toEqual([]);
    expect(jsonFiles(p.flintNew()), "nothing was delivered").toEqual([]);
    expect(jsonFiles(p.emberCur()), "the inbound waits, unacked, in cur/").toHaveLength(1);
    expect(jsonFiles(p.journal()), "its reply is journaled").toEqual(["in-1.json"]);

    provisionEmberKey();
    expect(await until(() => flintReplies().length === 1), "the reply was delivered").toBe(true);
    await expectDone();
    expect(lines(p.launcherLog()).length, "the launcher ran ONCE across the retry").toBe(1);
    const ids = sends().map(messageIdOf);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size, "every attempt carried the same messageId").toBe(1);
    await expectVerifiedReply(flintReplies()[0]!);
    expect(flintReplies()[0]!.messageId).toBe(ids[0]);
  }, 40000);

  for (const [fault, opts] of [
    ["exits NON-ZERO after it delivered", { marker: "fail-send-once", sendTimeoutMs: undefined }],
    ["TIMES OUT after it delivered", { marker: "hang-send-once", sendTimeoutMs: 4000 }],
  ] as const) {
    it(`a send that ${fault} is re-sent as the SAME message — the recipient's replay gate keeps exactly one`, async () => {
      provisionEmberKey();
      writeFileSync(p.marker(opts.marker), "");
      plantInbound();
      start({ retryBackoffMs: 200, sendTimeoutMs: opts.sendTimeoutMs });
      expect(await until(() => flintReplies().length === 2, 30000), "the unknown-outcome send was repeated").toBe(true);
      await expectDone();

      expect(lines(p.launcherLog()).length, "the launcher ran once").toBe(1);
      const ids = sends().map(messageIdOf);
      expect(ids.length).toBe(2);
      expect(ids[0], "the re-send carried the same messageId").toBe(ids[1]);
      const [a, b] = flintReplies();
      expect(a!.messageId).toBe(ids[0]);
      expect(b!.messageId).toBe(ids[0]);
      expect(b!.body).toBe(a!.body);
      expect(b!.replyToId).toBe(a!.replyToId);
      await expectVerifiedReply(a!);
      await expectVerifiedReply(b!);

      // The recipient's own promotion: ONE message is presented, the copy is a replay.
      const checked = await cli("flint", ["mail", "check", "flint", "--json"]);
      expect(checked.status).toBe(0);
      expect(JSON.parse(checked.stdout).map((m: any) => m.envelopeId)).toEqual([ids[0]]);
      const dlq = jsonFiles(p.flintDlq());
      expect(dlq).toHaveLength(1);
      expect(readFileSync(join(p.flintDlq(), `${dlq[0]}.reason`), "utf-8")).toContain("class: replay");
    }, 60000);
  }

  it("an ACK that fails is retried on the next check — without re-sending and without re-running the launcher", async () => {
    // CONTROL: before this change a failed ack left the inbound in cur/ and
    // nothing ever looked at it again.
    provisionEmberKey();
    writeFileSync(p.marker("fail-ack-once"), "");
    plantInbound();
    start();
    expect(await until(() => acks().length >= 2), "the ack was retried").toBe(true);
    await expectDone();
    expect(sends().length, "sent once").toBe(1);
    expect(flintReplies()).toHaveLength(1);
    expect(lines(p.launcherLog()).length).toBe(1);
  }, 40000);
});

describe("watcher: recovery of an inbound left unacknowledged in cur/ (cli#429)", () => {
  it("a restart after the send but before the ack: the journal says `sent` → acked, NOT re-sent, launcher not run", async () => {
    provisionEmberKey();
    plantInbound();
    await promoteInbound();
    writeJournalEntry({ reply: "reply from ember", replyMessageId: "reply-msg-0001", state: "sent" });
    start();
    await expectDone();
    expect(sends(), "nothing re-sent").toEqual([]);
    expect(lines(p.launcherLog()), "the launcher never ran").toEqual([]);
  }, 40000);

  it("a restart before the send was confirmed: the journal says `prepared` → the SAME message is sent (its messageId, its text), launcher not run", async () => {
    provisionEmberKey();
    plantInbound();
    await promoteInbound();
    writeJournalEntry({ reply: "reply from ember", replyMessageId: "reply-msg-0002", state: "prepared" });
    start();
    expect(await until(() => flintReplies().length === 1)).toBe(true);
    await expectDone();
    expect(lines(p.launcherLog()), "the launcher never ran").toEqual([]);
    expect(sends().map(messageIdOf)).toEqual(["reply-msg-0002"]);
    const [env] = flintReplies();
    await expectVerifiedReply(env!);
    expect(env!.messageId).toBe("reply-msg-0002");
  }, 40000);

  it("an inbound re-presented (lease expired) while its reply is still owed is left to the JOURNAL — the launcher never runs a second time", async () => {
    // No signing key: the journaled reply's send fails and backs off, so the
    // entry is still owed when the CLI re-presents the inbound.
    plantInbound();
    const curPath = await promoteInbound();
    const rec = JSON.parse(readFileSync(curPath, "utf-8"));
    rec.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(curPath, JSON.stringify(rec, null, 2));
    writeJournalEntry({ reply: "reply from ember", replyMessageId: "reply-msg-0003", state: "prepared" });
    start({ retryBackoffMs: 60_000, rescanIntervalMs: 50 });
    expect(await until(() => sends().length === 1)).toBe(true);
    expect(await until(() => lines(p.argvLog()).filter((l) => l.startsWith("mail check")).length >= 3), "the inbound was re-presented and more checks ran").toBe(true);
    expect(lines(p.launcherLog()), "the launcher never ran").toEqual([]);
    expect(sends().map(messageIdOf), "one attempt, the journaled message").toEqual(["reply-msg-0003"]);
    const entry = JSON.parse(readFileSync(join(p.journal(), "in-1.json"), "utf-8"));
    expect(entry.replyMessageId, "the journal entry is intact").toBe("reply-msg-0003");
    expect(entry.reply).toBe("reply from ember");
  }, 40000);

  it("a crash while the launcher ran (no journal entry): the inbound is re-presented, re-verified, when its lease expires — and answered", async () => {
    provisionEmberKey();
    plantInbound();
    const curPath = await promoteInbound();
    // The processing lease ran out while nothing acked it.
    const rec = JSON.parse(readFileSync(curPath, "utf-8"));
    rec.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(curPath, JSON.stringify(rec, null, 2));
    start({ rescanIntervalMs: 100 });
    expect(await until(() => flintReplies().length === 1)).toBe(true);
    await expectDone();
    expect(lines(p.launcherLog())).toEqual(["call please answer"]);
    await expectVerifiedReply(flintReplies()[0]!);
  }, 40000);

  it("a cur/ record whose lease has NOT expired is left alone (no second dispatch while it is being worked)", async () => {
    provisionEmberKey();
    plantInbound();
    await promoteInbound();
    start({ rescanIntervalMs: 100 });
    await settle(1500);
    expect(lines(p.launcherLog())).toEqual([]);
    expect(sends()).toEqual([]);
  }, 40000);
});
