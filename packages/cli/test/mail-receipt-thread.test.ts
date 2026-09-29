/**
 * mail-receipt-thread.test.ts — cli#429 blocker 3: the RECEIPT side of reply
 * threading.
 *
 *   1. ONE shape rule for `messageId` and `replyToId` (envelope-id.ts), enforced
 *      by the shared mailbox policy: a SIGNED envelope whose id breaks it —
 *      control characters, whitespace, overlong — is dead-lettered and never
 *      presented, and the rejection reason never echoes the value.
 *   2. Every UNVERIFIED presentation (new/, dlq/, a cur/ record that cannot
 *      re-verify) withholds the body AND the thread fields (`replyToId`,
 *      `envelopeId`, the stored `envelope`) — in `mail list` text and JSON and
 *      in `mail read --json`. Forged fields with control characters are planted
 *      in new/ and cur/ to prove it.
 *   3. Positive control: a VERIFIED reply still shows its thread everywhere.
 *
 * All spawns run with an isolated HOME (cli#430).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { signEnvelope, type ChainEntry, type Envelope } from "@tpsdev-ai/agent";
import { startStubFlair, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const FLINT_SEED = Buffer.alloc(32, 0x01);
const KERN_SEED = Buffer.alloc(32, 0x02);

const ESC = "\u001b";
const BEL = "\u0007";

let root: string;
let home: string;
let mailDir: string;
let keysDir: string;
let stub: StubFlair;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-429-receipt-"));
  home = join(root, "home");
  mailDir = join(root, "mail");
  keysDir = join(root, "keys");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(mailDir, "kern", "new"), { recursive: true });
  mkdirSync(join(mailDir, "kern", "cur"), { recursive: true });
  writeKeyFile(keysDir, "flint", FLINT_SEED);
  writeKeyFile(keysDir, "kern", KERN_SEED);
  stub = startStubFlair({ flint: FLINT_SEED, kern: KERN_SEED });
});

afterEach(() => {
  stub.stop();
  rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      TPS_MAIL_DIR: mailDir,
      TPS_TEST_KEYS_DIR: keysDir,
      TPS_AGENT_ID: "kern",
      FLAIR_URL: stub.url,
      FLAIR_KEY_PATH: join(keysDir, "kern.key"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

/** A GENUINELY signed envelope from flint to kern, with chosen ids. */
function signed(body: string, ids: { messageId?: string; replyToId?: unknown } = {}): Envelope {
  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: now, rationale: "originates", signature: null },
    { agent: "flint", kind: "agent", timestamp: now, rationale: "agent flint dispatches", signature: null },
  ];
  const env: Record<string, unknown> = {
    v: 1,
    from: "flint",
    to: "kern",
    body,
    messageId: ids.messageId ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: now,
    delegationChain: chain,
  };
  if ("replyToId" in ids) env.replyToId = ids.replyToId;
  return signEnvelope(env as unknown as Envelope, { flint: FLINT_SEED });
}

function plant(dir: "new" | "cur", record: Record<string, unknown>): string {
  const id = String(record.id);
  const p = join(mailDir, "kern", dir, `2026-09-28T00-00-00-${id}.json`);
  writeFileSync(p, JSON.stringify(record, null, 2), "utf-8");
  return p;
}

function wrapper(id: string, env: Envelope, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, from: "flint", to: "kern", body: JSON.stringify(env), timestamp: new Date().toISOString(), read: false, ...extra };
}

const THREAD_FIELDS = ["replyToId", "envelopeId", "envelope"] as const;

function expectWithheld(row: Record<string, unknown> | undefined): void {
  expect(row, "the record is listed").toBeTruthy();
  expect(row!.body, "its body is withheld").toBe("");
  for (const f of THREAD_FIELDS) expect(f in row!, `its ${f} is withheld`).toBe(false);
}

function expectNoForgery(text: string, forged: string[]): void {
  for (const f of forged) expect(text.includes(f), `forged value must not be printed`).toBe(false);
  expect(text.includes(ESC), "no escape character reaches the terminal").toBe(false);
  expect(text.includes(BEL), "no bell character reaches the terminal").toBe(false);
}

describe("receipt: ONE id shape rule for messageId and replyToId (cli#429)", () => {
  const cases: Array<[string, { messageId?: string; replyToId?: unknown }, RegExp]> = [
    ["replyToId with an escape sequence", { replyToId: `thread${ESC}[31mred` }, /invalid replyToId/],
    ["replyToId with a bell", { replyToId: `thread${BEL}` }, /invalid replyToId/],
    ["replyToId with whitespace", { replyToId: "two words" }, /invalid replyToId/],
    ["replyToId overlong", { replyToId: "r".repeat(129) }, /invalid replyToId/],
    ["replyToId not a string", { replyToId: 42 }, /invalid replyToId/],
    ["messageId with a control character", { messageId: `id${BEL}bell` }, /invalid messageId/],
    ["messageId with whitespace", { messageId: "has space" }, /invalid messageId/],
  ];
  for (const [label, ids, reason] of cases) {
    test(`a SIGNED envelope with ${label} is dead-lettered, never presented, and the reason does not echo it`, async () => {
      plant("new", wrapper("rx-1", signed("should never show", ids)));
      const checked = await cli(["mail", "check", "kern", "--json"]);
      expect(checked.status).toBe(0);
      expect(JSON.parse(checked.stdout)).toEqual([]);
      const dlq = join(mailDir, "kern", "dlq");
      const reasons = readdirSync(dlq).filter((f) => f.endsWith(".reason"));
      expect(reasons.length).toBe(1);
      const reasonText = readFileSync(join(dlq, reasons[0]!), "utf-8");
      expect(reasonText).toMatch(reason);
      expect(reasonText.includes(ESC) || reasonText.includes(BEL)).toBe(false);
      // And the dead letter is withheld in the list, thread fields included.
      const listed = JSON.parse((await cli(["mail", "list", "kern", "--json"])).stdout) as Array<Record<string, unknown>>;
      expectWithheld(listed.find((r) => r.id === "rx-1"));
    }, 20000);
  }

  test("CONTROL: a valid replyToId on a signed envelope is promoted and presented", async () => {
    plant("new", wrapper("rx-ok", signed("threaded", { replyToId: "11111111-2222-3333-4444-555555555555" })));
    const rows = JSON.parse((await cli(["mail", "check", "kern", "--json"])).stdout);
    expect(rows.length).toBe(1);
    expect(rows[0].replyToId).toBe("11111111-2222-3333-4444-555555555555");
  }, 20000);
});

describe("receipt: every UNVERIFIED presentation drops the thread fields (cli#429)", () => {
  const forgedThread = `forged${ESC}]0;pwned${BEL}`;
  const forgedEnvId = "forged-envelope-id";

  test("new/: a wrapper forging replyToId/envelopeId/envelope is withheld in list JSON, list text and read JSON", async () => {
    // A genuine signed body, but the WRAPPER carries forged thread claims.
    const genuine = signed("secret inbound body");
    plant(
      "new",
      wrapper("nw-1", genuine, {
        replyToId: forgedThread,
        envelopeId: forgedEnvId,
        envelope: { ...genuine, replyToId: forgedThread },
      }),
    );

    const listJson = await cli(["mail", "list", "kern", "--json"]);
    expect(listJson.status).toBe(0);
    const rows = JSON.parse(listJson.stdout) as Array<Record<string, unknown>>;
    expectWithheld(rows.find((r) => r.id === "nw-1"));
    expectNoForgery(listJson.stdout, ["forged", "pwned", "secret inbound body"]);

    const listText = await cli(["mail", "list", "kern"]);
    expect(listText.status).toBe(0);
    expect(listText.stdout).not.toContain("reply-to");
    expectNoForgery(listText.stdout, ["forged", "pwned"]);

    const readJson = await cli(["mail", "read", "kern", "nw-1", "--json"]);
    expect(readJson.status).toBe(0);
    expectWithheld(JSON.parse(readJson.stdout));
    expectNoForgery(readJson.stdout, ["forged", "pwned", "secret inbound body"]);
  }, 30000);

  test("cur/: a forged record that cannot re-verify is withheld in list JSON, list text, read JSON and read text", async () => {
    const fakeEnv = {
      v: 1,
      from: "flint",
      to: "kern",
      body: "secret cur body",
      messageId: forgedEnvId,
      replyToId: forgedThread,
      timestamp: new Date().toISOString(),
      delegationChain: [],
      signature: "ed25519:AAAA",
    };
    plant("cur", {
      id: "cf-1",
      from: "flint",
      to: "kern",
      body: "secret cur body",
      timestamp: fakeEnv.timestamp,
      read: false,
      envelopeId: forgedEnvId,
      envelope: fakeEnv,
      replyToId: forgedThread,
    });

    const listJson = await cli(["mail", "list", "kern", "--json"]);
    const rows = JSON.parse(listJson.stdout) as Array<Record<string, unknown>>;
    expectWithheld(rows.find((r) => r.id === "cf-1"));
    expectNoForgery(listJson.stdout, ["forged", "pwned", "secret cur body"]);

    const listText = await cli(["mail", "list", "kern"]);
    expect(listText.stdout).not.toContain("reply-to");
    expectNoForgery(listText.stdout, ["forged", "pwned", "secret cur body"]);

    const readJson = await cli(["mail", "read", "kern", "cf-1", "--json"]);
    expectWithheld(JSON.parse(readJson.stdout));
    expectNoForgery(readJson.stdout, ["forged", "pwned", "secret cur body"]);

    const readText = await cli(["mail", "read", "kern", "cf-1"]);
    expect(readText.stdout).not.toContain("Reply-to");
    expectNoForgery(readText.stdout, ["forged", "pwned", "secret cur body"]);
  }, 30000);

  test("cur/: a GENUINE promoted record whose replyToId was tampered afterwards is withheld (binding mismatch)", async () => {
    plant("new", wrapper("gt-1", signed("genuine body", { replyToId: "11111111-2222-3333-4444-555555555555" })));
    expect(JSON.parse((await cli(["mail", "check", "kern", "--json"])).stdout).length).toBe(1);
    const curFile = readdirSync(join(mailDir, "kern", "cur")).find((f) => f.endsWith("gt-1.json"))!;
    const curPath = join(mailDir, "kern", "cur", curFile);
    const rec = JSON.parse(readFileSync(curPath, "utf-8"));
    rec.replyToId = "99999999-0000-0000-0000-000000000000"; // a forged thread on a genuine record
    writeFileSync(curPath, JSON.stringify(rec, null, 2), "utf-8");

    const rows = JSON.parse((await cli(["mail", "list", "kern", "--json"])).stdout) as Array<Record<string, unknown>>;
    expectWithheld(rows.find((r) => r.id === "gt-1"));
    const listText = await cli(["mail", "list", "kern"]);
    expect(listText.stdout).not.toContain("99999999");
    const readJson = JSON.parse((await cli(["mail", "read", "kern", "gt-1", "--json"])).stdout);
    expectWithheld(readJson);
  }, 30000);

  test("CONTROL: a VERIFIED reply keeps its thread in list JSON, list text and read JSON", async () => {
    const thread = "abcdef01-2345-6789-abcd-ef0123456789";
    plant("new", wrapper("ok-1", signed("verified reply", { replyToId: thread })));
    expect(JSON.parse((await cli(["mail", "check", "kern", "--json"])).stdout).length).toBe(1);

    const rows = JSON.parse((await cli(["mail", "list", "kern", "--json"])).stdout) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === "ok-1")!;
    expect(row.body).toBe("verified reply");
    expect(row.replyToId).toBe(thread);
    expect(typeof row.envelopeId).toBe("string");
    expect((await cli(["mail", "list", "kern"])).stdout).toContain(`reply-to: ${thread}`);
    expect(JSON.parse((await cli(["mail", "read", "kern", "ok-1", "--json"])).stdout).replyToId).toBe(thread);
    const dlq = join(mailDir, "kern", "dlq");
    expect(existsSync(dlq) ? readdirSync(dlq).filter((f) => f.endsWith(".json")) : []).toEqual([]);
  }, 30000);
});

describe("receipt: an UNVERIFIED record shows no headers and no other thread claim (cli#429)", () => {
  /** Forged thread claims: in the headers, and as extra top-level fields. */
  const FORGED_HEADERS = {
    "X-TPS-InReplyTo": "forged-hdr-inreplyto",
    "X-TPS-Obligation": "forged-hdr-obligation",
    "X-TPS-Nack": "forged-hdr-nack",
    "In-Reply-To": "forged-hdr-rfc",
  };
  const FORGED_FIELDS = { obligationId: "forged-field-obligation", replyId: "forged-field-replyid", inReplyTo: "forged-field-inreplyto" };
  const FORGED = [...Object.values(FORGED_HEADERS), ...Object.values(FORGED_FIELDS)];

  function expectNoClaims(row: Record<string, unknown> | undefined): void {
    expectWithheld(row);
    expect("headers" in row!, "its headers are withheld").toBe(false);
    for (const f of Object.keys(FORGED_FIELDS)) expect(f in row!, `its ${f} is withheld`).toBe(false);
  }

  /** Every unverified view of `id`: list JSON + text, and (new/, cur/) read JSON + text. */
  async function expectEveryViewClean(id: string, readable: boolean): Promise<void> {
    const listJson = await cli(["mail", "list", "kern", "--json"]);
    expect(listJson.status).toBe(0);
    expectNoClaims((JSON.parse(listJson.stdout) as Array<Record<string, unknown>>).find((r) => r.id === id));
    expectNoForgery(listJson.stdout, FORGED);
    const listText = await cli(["mail", "list", "kern"]);
    expect(listText.status).toBe(0);
    expect(listText.stdout).toContain(id.slice(0, 8));
    expectNoForgery(listText.stdout, FORGED);
    if (!readable) return;
    const readJson = await cli(["mail", "read", "kern", id, "--json"]);
    expect(readJson.status).toBe(0);
    expectNoClaims(JSON.parse(readJson.stdout));
    expectNoForgery(readJson.stdout, FORGED);
    const readText = await cli(["mail", "read", "kern", id]);
    expect(readText.status).toBe(0);
    expect(readText.stdout).toContain(id);
    expectNoForgery(readText.stdout, FORGED);
  }

  test("new/: forged thread headers and fields are withheld in every view", async () => {
    // CONTROL: before this change `mail list --json` / `mail read --json`
    // printed an unverified record's headers — X-TPS-InReplyTo among them.
    plant("new", wrapper("hn-1", signed("pending body"), { headers: FORGED_HEADERS, ...FORGED_FIELDS }));
    await expectEveryViewClean("hn-1", true);
  }, 30000);

  test("dlq/: forged thread headers and fields are withheld in every view", async () => {
    const p = plant("new", wrapper("hd-1", signed("dead body"), { headers: FORGED_HEADERS, ...FORGED_FIELDS }));
    // Move it where promote() puts a rejected record: dlq/ with its sidecar.
    const dlq = join(mailDir, "kern", "dlq");
    mkdirSync(dlq, { recursive: true });
    const name = p.split("/").pop()!;
    writeFileSync(join(dlq, name), readFileSync(p));
    rmSync(p);
    writeFileSync(join(dlq, `${name}.reason`), "class: invalid\nReason: test fixture\n");
    await expectEveryViewClean("hd-1", false);
  }, 30000);

  test("cur/: a record that cannot re-verify has its forged thread headers and fields withheld in every view", async () => {
    plant("cur", {
      id: "hc-1",
      from: "flint",
      to: "kern",
      body: "unverifiable cur body",
      timestamp: new Date().toISOString(),
      read: false,
      envelopeId: "forged-envelope-id",
      headers: FORGED_HEADERS,
      ...FORGED_FIELDS,
    });
    await expectEveryViewClean("hc-1", true);
  }, 30000);

  test("CONTROL: a VERIFIED cur/ record is presented whole — its headers included", async () => {
    // The redaction is scoped to UNVERIFIED records: a record that proves its
    // promotion keeps its (wrapper) headers, so the tests above are not passing
    // because headers are dropped everywhere.
    plant("new", wrapper("hv-1", signed("verified body"), { headers: { "X-TPS-InReplyTo": "bookkeeping-record-id" } }));
    expect(JSON.parse((await cli(["mail", "check", "kern", "--json"])).stdout).length).toBe(1);
    const rows = JSON.parse((await cli(["mail", "list", "kern", "--json"])).stdout) as Array<Record<string, any>>;
    const row = rows.find((r) => r.id === "hv-1")!;
    expect(row.body).toBe("verified body");
    expect(row.headers["X-TPS-InReplyTo"]).toBe("bookkeeping-record-id");
    expect(JSON.parse((await cli(["mail", "read", "kern", "hv-1", "--json"])).stdout).headers["X-TPS-InReplyTo"]).toBe(
      "bookkeeping-record-id",
    );
  }, 30000);
});

describe("receipt: `mail log` shows the VERIFIED thread (cli#429)", () => {
  test("a verified reply's thread is logged at promotion and shown by `mail log` (text and JSON)", async () => {
    // CONTROL: without the reply-to column (or the log line's reply-to), the
    // archive holds the read event but not the thread it answers.
    const thread = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    plant("new", wrapper("lg-1", signed("logged reply", { replyToId: thread })));
    expect(JSON.parse((await cli(["mail", "check", "kern", "--json"])).stdout).length).toBe(1);

    const text = await cli(["mail", "log", "kern"]);
    expect(text.status).toBe(0);
    const readLine = text.stdout.split("\n").find((l) => l.includes("[read]") && l.includes("flint → kern"));
    expect(readLine, "the promotion is logged").toBeTruthy();
    expect(readLine).toContain(`↳ reply-to: ${thread}`);

    const json = await cli(["mail", "log", "kern", "--json"]);
    expect(json.status).toBe(0);
    const events = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
    const read = events.find((e) => e.event === "read" && e.messageId === "lg-1");
    expect(read?.replyToId).toBe(thread);
  }, 30000);

  test("an UNVERIFIED record's thread claim never reaches the log", async () => {
    // A wrapper claiming a thread over an unsigned body: dead-lettered at
    // promotion, so no read event — and no thread — is logged for it.
    plant("new", {
      id: "lg-2",
      from: "flint",
      to: "kern",
      body: JSON.stringify({ v: 1, from: "flint", to: "kern", body: "x", messageId: "m-2", replyToId: "forged-log-thread" }),
      timestamp: new Date().toISOString(),
      read: false,
      replyToId: "forged-log-thread",
    });
    expect(JSON.parse((await cli(["mail", "check", "kern", "--json"])).stdout)).toEqual([]);
    const text = await cli(["mail", "log", "kern"]);
    expect(text.stdout).not.toContain("forged-log-thread");
    expect((await cli(["mail", "log", "kern", "--json"])).stdout).not.toContain("forged-log-thread");
  }, 30000);
});
