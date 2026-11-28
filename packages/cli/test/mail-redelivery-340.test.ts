/**
 * cli#340: `mail check` says WHY an unacked cur/ record is re-delivered
 * (its checkout lease expired) and, for ackable mail, how to stop it (ack it
 * with the printed command).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ackMessage, ackMessageAtPath, checkMessages, gcMessages, getInbox, LEASE_TIMEOUT_MS, sendMessage, updateExistingRecord } from "../src/utils/mail.js";
import { buildSignedEnvelope, startStubFlair, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const OWNER = "agent-a";
const SENDER = "agent-b";
const OWNER_SEED = Buffer.alloc(32, 0x11);
const SENDER_SEED = Buffer.alloc(32, 0x22);
const SEEDS = { [OWNER]: OWNER_SEED, [SENDER]: SENDER_SEED };

describe("mail check re-delivery reason (cli#340)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;
  let savedHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-mail-redelivery-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
    writeKeyFile(keysDir, OWNER, OWNER_SEED);
    savedHome = process.env.HOME;
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    process.env.TPS_AGENT_ID = OWNER;
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, `${OWNER}.key`);
  });

  afterEach(() => {
    stub.stop();
    delete process.env.TPS_MAIL_DIR;
    delete process.env.TPS_AGENT_ID;
    delete process.env.FLAIR_URL;
    delete process.env.FLAIR_KEY_PATH;
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function signedBody(body: string): string {
    return JSON.stringify(buildSignedEnvelope(SENDER, OWNER, body, { [SENDER]: SENDER_SEED }));
  }

  function curPath(): string {
    const inbox = getInbox(OWNER);
    const [file] = readdirSync(inbox.cur).filter((f) => f.endsWith(".json"));
    expect(file).toBeDefined();
    return join(inbox.cur, file!);
  }

  /** Age the checkout past the lease, as the existing runtime lifecycle test does. */
  function ageLease(): string {
    const path = curPath();
    const record = JSON.parse(readFileSync(path, "utf-8"));
    const previousCheckout = new Date(Date.now() - LEASE_TIMEOUT_MS - 60_000).toISOString();
    record.checkedOutAt = previousCheckout;
    writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
    return previousCheckout;
  }

  async function runCheck(args: string[], agentId = OWNER): Promise<{ status: number; stdout: string; stderr: string }> {
    return runCli(["mail", "check", ...args], agentId);
  }

  async function runCli(args: string[], agentId: string, preload?: string): Promise<{ status: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", ...(preload ? [`--preload=${preload}`] : []), TPS_BIN, ...args], {
      cwd: tempRoot,
      env: {
        ...process.env,
        HOME: tempRoot,
        TPS_MAIL_DIR: join(tempRoot, "mail"),
        TPS_AGENT_ID: agentId,
        FLAIR_URL: stub.url,
        FLAIR_KEY_PATH: join(keysDir, `${OWNER}.key`),
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

  function tpsOnPath(): string {
    const dir = join(tempRoot, "bin");
    const script = join(dir, "tps");
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, `#!/bin/sh\nexec bun "${TPS_BIN}" "$@"\n`, "utf-8");
    chmodSync(script, 0o755);
    return `${dir}:${process.env.PATH ?? ""}`;
  }

  /** Put extra fields on the incoming new/ wrapper, as a sender could. */
  function plantOnNew(fields: Record<string, unknown>): void {
    const inbox = getInbox(OWNER);
    const file = readdirSync(inbox.fresh).find((f) => f.endsWith(".json"));
    expect(file).toBeDefined();
    const path = join(inbox.fresh, file!);
    const record = JSON.parse(readFileSync(path, "utf-8"));
    Object.assign(record, fields);
    writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
  }

  test("an expired lease is re-delivered with the reason and a persisted attempt count", async () => {
    sendMessage(OWNER, signedBody("long task"), SENDER);
    const firstRead = await checkMessages(OWNER);
    expect(firstRead.length).toBe(1);
    expect(firstRead[0]!.redelivered).toBeUndefined();

    const previousCheckout = ageLease();
    const first = await checkMessages(OWNER);
    expect(first.length).toBe(1);
    expect(first[0]!.redelivered).toEqual({ reason: "lease-expired", previousCheckout, attempt: 1 });

    ageLease();
    const second = await checkMessages(OWNER);
    expect(second.length).toBe(1);
    expect(second[0]!.redelivered).toEqual({ reason: "lease-expired", previousCheckout: expect.any(String), attempt: 2 });

    // The count is in the record, so it survives the process that read it.
    const onDisk = JSON.parse(readFileSync(curPath(), "utf-8"));
    expect(onDisk.redeliveryAttempts).toBe(2);
  });

  test("an unexpired checkout is not re-delivered", async () => {
    sendMessage(OWNER, signedBody("still leased"), SENDER);
    const delivered = await checkMessages(OWNER);
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.redelivered).toBeUndefined();

    expect(await checkMessages(OWNER)).toEqual([]);
  });

  test("an acked record stays in cur/ and is neither re-delivered nor re-leased", async () => {
    const sent = sendMessage(OWNER, signedBody("ack me"), SENDER);
    const delivered = await checkMessages(OWNER);
    expect(delivered.length).toBe(1);

    const ack = await runCli(["mail", "ack", sent.id, "--agent", OWNER], OWNER);
    expect(ack.status, ack.stderr).toBe(0);
    const acked = JSON.parse(readFileSync(curPath(), "utf-8"));
    expect(acked.read).toBe(true);
    expect(acked.ackedAt).toEqual(expect.any(String));
    // The ack drops the checkout; the lease sweep skips a read record before it
    // checks the lease.
    expect(acked.checkedOutAt).toBeUndefined();

    const check = await runCheck([OWNER]);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("No new messages.");
    expect(await checkMessages(OWNER)).toEqual([]);
    expect(JSON.parse(readFileSync(curPath(), "utf-8"))).toEqual(acked);
  });

  test("an ack through an aliased path to cur/ keeps the record, chosen by its physical directory", async () => {
    sendMessage(OWNER, signedBody("ack me through an alias"), SENDER);
    expect((await checkMessages(OWNER)).length).toBe(1);
    const real = curPath();
    const root = dirname(dirname(real));
    symlinkSync(dirname(real), join(root, "cur-alias"));
    const acked = ackMessageAtPath(join(root, "cur-alias", basename(real)), root);
    expect(acked.ackedAt).toEqual(expect.any(String));
    // Kept and stamped in cur/, as a literal cur/ path would be; not deleted.
    expect(existsSync(real)).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8")).ackedAt).toBe(acked.ackedAt);
  });

  test("an explicit remove takes precedence over removeUnlessIn for a cur/ record", async () => {
    sendMessage(OWNER, signedBody("remove wins"), SENDER);
    expect((await checkMessages(OWNER)).length).toBe(1);
    const real = curPath();
    const result = updateExistingRecord(real, (record: object) => record, { mailboxRoot: dirname(dirname(real)), remove: true, removeUnlessIn: "cur" });
    expect(result.status).toBe("updated");
    expect(existsSync(real)).toBe(false);
  });

  test("mail check archives an old acked cur/ record before GC can delete it", async () => {
    const sent = sendMessage(OWNER, signedBody("archive before GC"), SENDER);
    expect(await checkMessages(OWNER)).toHaveLength(1);
    const ack = await runCli(["mail", "ack", sent.id, "--agent", OWNER], OWNER);
    expect(ack.status, ack.stderr).toBe(0);

    const path = curPath();
    const record = JSON.parse(readFileSync(path, "utf-8"));
    expect(record.ackedAt).toEqual(expect.any(String));
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const oldIso = old.toISOString();
    record.timestamp = oldIso;
    record.receivedAt = oldIso;
    record.ackedAt = oldIso;
    writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
    utimesSync(path, old, old);

    const check = await runCheck([OWNER]);
    expect(check.status, check.stderr).toBe(0);
    const inbox = getInbox(OWNER);
    expect(readdirSync(inbox.cur).filter((f) => f.endsWith(".json"))).toEqual([]);
    const archived = join(inbox.root, "archive", oldIso.slice(0, 7), basename(path));
    expect(existsSync(archived)).toBe(true);
    expect(JSON.parse(readFileSync(archived, "utf-8")).ackedAt).toBe(oldIso);
  });

  test("an ack of a record still in new/ removes it, so a later check presents nothing", async () => {
    const sent = sendMessage(OWNER, signedBody("acked unread"), SENDER);
    expect(ackMessage(OWNER, sent.id)?.ackedAt).toEqual(expect.any(String));
    const inbox = getInbox(OWNER);
    expect(readdirSync(inbox.fresh).filter((f) => f.endsWith(".json"))).toEqual([]);
    expect(await checkMessages(OWNER)).toEqual([]);
    expect(readdirSync(inbox.cur).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  test("gcMessages removes an acked record when its delivery and its ack are both over 24 hours old or its delivery is over 48 hours old, and keeps the others", async () => {
    // body -> [delivery age, ack age], in hours
    const ages: Record<string, [number, number]> = {
      "old delivery, old ack": [25, 25],
      "fresh delivery, fresh ack": [0, 0],
      "old delivery, fresh ack": [30, 0],
      "delivery past the hard cutoff, fresh ack": [49, 0],
    };
    for (const body of Object.keys(ages)) {
      const sent = sendMessage(OWNER, signedBody(body), SENDER);
      await checkMessages(OWNER);
      ackMessage(OWNER, sent.id);
    }
    const inbox = getInbox(OWNER);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const bodies = () => readdirSync(inbox.cur).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(inbox.cur, f), "utf-8")).body as string).sort();
    expect(bodies()).toEqual(Object.keys(ages).sort());
    for (const f of readdirSync(inbox.cur).filter((name) => name.endsWith(".json"))) {
      const path = join(inbox.cur, f);
      const record = JSON.parse(readFileSync(path, "utf-8"));
      const [delivery, ack] = ages[record.body]!;
      record.timestamp = hoursAgo(delivery);
      record.receivedAt = record.timestamp;
      record.ackedAt = hoursAgo(ack);
      writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
    }

    expect(gcMessages(OWNER)).toBe(2);
    expect(bodies()).toEqual(["fresh delivery, fresh ack", "old delivery, fresh ack"]);
  });

  test("an ack whose delete of a new/ record fails exits non-zero, names the path and the error, and writes nothing to the record", async () => {
    const sent = sendMessage(OWNER, signedBody("delete fails"), SENDER);
    const before = readFileSync(sent.filePath, "utf-8");
    // The spawned CLI's unlink of this one record fails, as a filesystem error would.
    const preload = join(tempRoot, "unlink-fault-preload.ts");
    writeFileSync(preload, [
      'import { mock } from "bun:test";',
      'import * as fs from "node:fs";',
      'import { resolve } from "node:path";',
      `const target = resolve(${JSON.stringify(sent.filePath)});`,
      "const unlink = fs.unlinkSync;",
      'mock.module("node:fs", () => ({',
      "  ...fs,",
      "  unlinkSync: (path: any) => {",
      '    if (resolve(String(path)) === target) throw Object.assign(new Error("EIO: i/o error, unlink"), { code: "EIO", syscall: "unlink", path: String(path) });',
      "    return unlink(path);",
      "  },",
      "}));",
    ].join("\n"));

    const ack = await runCli(["mail", "ack", sent.id, "--agent", OWNER], OWNER, preload);
    expect(ack.status).toBe(1);
    expect(ack.stdout).not.toContain("Acked");
    expect(ack.stderr).toContain(`cannot remove ${resolve(sent.filePath)}: EIO`);
    expect(readFileSync(sent.filePath, "utf-8")).toBe(before);

    // Nothing was acked, so the next check delivers the record as unacked mail.
    const delivered = await checkMessages(OWNER);
    expect(delivered.map((m) => [m.id, m.ackedAt])).toEqual([[sent.id, undefined]]);
  });

  test("an ack through the CLI deletes a dlq/ record, and a later check does not re-drive it", async () => {
    const sent = sendMessage(OWNER, signedBody("parked"), SENDER);
    // Flair is unreachable for this check, so the record is parked in dlq/ as retryable.
    process.env.FLAIR_URL = "http://127.0.0.1:1";
    try {
      expect(await checkMessages(OWNER)).toEqual([]);
    } finally {
      process.env.FLAIR_URL = stub.url;
    }
    const inbox = getInbox(OWNER);
    const records = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(records(inbox.dlq)).toHaveLength(1);
    expect(readFileSync(join(inbox.dlq, `${records(inbox.dlq)[0]!}.reason`), "utf-8")).toContain("class: verify-unavailable");

    const ack = await runCli(["mail", "ack", sent.id, "--agent", OWNER], OWNER);
    expect(ack.status, ack.stderr).toBe(0);
    expect(ack.stdout).toContain(`Acked ${sent.id}`);
    expect(records(inbox.dlq)).toEqual([]);

    const check = await runCheck([OWNER]);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("No new messages.");
    expect(records(inbox.cur)).toEqual([]);
    expect(records(inbox.dlq)).toEqual([]);
  });

  test("human output marks a re-delivery once and --json carries the field", async () => {
    const sent = sendMessage(OWNER, signedBody("say why"), SENDER);
    await checkMessages(OWNER);
    ageLease();

    const human = await runCheck([OWNER]);
    expect(human.status).toBe(0);
    const minutes = Math.round(LEASE_TIMEOUT_MS / 60_000);
    expect(human.stdout).toContain(`[re-delivered: not acked within ${minutes} min — ack it with: tps mail ack ${sent.id} --agent ${OWNER}]`);
    expect(human.stdout.match(/re-delivered/g)?.length).toBe(1);

    ageLease();
    const json = await runCheck([OWNER, "--json"]);
    expect(json.status).toBe(0);
    const messages = JSON.parse(json.stdout);
    expect(messages).toHaveLength(1);
    expect(messages[0].redelivered.reason).toBe("lease-expired");
    expect(messages[0].redelivered.previousCheckout).toEqual(expect.any(String));
    expect(messages[0].redelivered.attempt).toBe(2);
  });

  test("sender-supplied redelivery bookkeeping is discarded at promotion", async () => {
    sendMessage(OWNER, signedBody("spoofed bookkeeping"), SENDER);
    plantOnNew({
      redelivered: { reason: "lease-expired", previousCheckout: new Date(0).toISOString(), attempt: 7 },
      redeliveryAttempts: 99,
    });

    const first = await checkMessages(OWNER);
    expect(first.length).toBe(1);
    expect(first[0]!.redelivered).toBeUndefined();
    expect(first[0]!.redeliveryAttempts).toBeUndefined();

    ageLease();
    const second = await checkMessages(OWNER);
    expect(second[0]!.redelivered).toEqual({
      reason: "lease-expired",
      previousCheckout: expect.any(String),
      attempt: 1,
    });
  });

  test("an empty checkedOutBy does not re-deliver a fresh checkout", async () => {
    sendMessage(OWNER, signedBody("spoofed lease"), SENDER);
    plantOnNew({ checkedOutBy: "" });

    const first = await checkMessages(OWNER);
    expect(first.length).toBe(1);
    expect(first[0]!.checkedOutBy).toBe(OWNER);
    expect(first[0]!.redelivered).toBeUndefined();

    // A record whose lease-holder field is empty still holds a fresh checkout:
    // the sweep tests the lease age, not checkedOutBy's truthiness.
    const path = curPath();
    const record = JSON.parse(readFileSync(path, "utf-8"));
    record.checkedOutBy = "";
    writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");

    expect(await checkMessages(OWNER)).toEqual([]);
  });

  test("another agent's inbox names --agent and the ack succeeds", async () => {
    const sent = sendMessage(OWNER, signedBody("ack from another identity"), SENDER);
    await checkMessages(OWNER);
    ageLease();

    const printed = await runCheck([OWNER], SENDER);
    expect(printed.status).toBe(0);
    const match = /ack it with: (tps mail ack [^\]]+)\]/.exec(printed.stdout);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(`tps mail ack ${sent.id} --agent ${OWNER}`);

    // A host without nono gets an availability warning on stderr; this case asserts the ack itself adds nothing there.
    const acks = Bun.spawn(["/bin/sh", "-c", `${match![1]!} --quiet-nono-check`], {
      cwd: tempRoot,
      env: {
        ...process.env,
        HOME: tempRoot,
        TPS_MAIL_DIR: join(tempRoot, "mail"),
        TPS_AGENT_ID: SENDER,
        FLAIR_URL: stub.url,
        FLAIR_KEY_PATH: join(keysDir, `${OWNER}.key`),
        PATH: tpsOnPath(),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(acks.stdout).text(),
      new Response(acks.stderr).text(),
      acks.exited,
    ]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: expect.any(String), stderr: "" });
    // The acked cur/ record is kept, stamped (cli#1098).
    expect(JSON.parse(readFileSync(curPath(), "utf-8")).ackedAt).toEqual(expect.any(String));
  });

  test("external-tier re-delivery names the refusal instead of an ack command", async () => {
    const sent = sendMessage(
      OWNER,
      JSON.stringify(buildSignedEnvelope(SENDER, OWNER, "external mail", SEEDS, { trust: "external" })),
      SENDER,
    );
    await checkMessages(OWNER);
    ageLease();

    const printed = await runCheck([OWNER], SENDER);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain("external-tier mail: the ack and nack commands refuse it");
    expect(printed.stdout).not.toContain("tps mail ack");

    const ack = await runCli(["mail", "ack", sent.id, "--agent", OWNER], SENDER);
    expect(ack.status).not.toBe(0);
    expect(ack.stderr).toContain("external-tier mail cannot be acknowledged");
  });
});
