/**
 * cli#340: `mail check` says WHY an unacked cur/ record is re-delivered
 * (its checkout lease expired) and how to stop it (ack it).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ackMessage, checkMessages, getInbox, LEASE_TIMEOUT_MS, sendMessage } from "../src/utils/mail.js";
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

  async function runCli(args: string[], agentId: string): Promise<{ status: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", TPS_BIN, ...args], {
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

  test("an acked record is not re-delivered", async () => {
    const sent = sendMessage(OWNER, signedBody("ack me"), SENDER);
    const delivered = await checkMessages(OWNER);
    expect(delivered.length).toBe(1);
    ackMessage(OWNER, sent.id);
    expect(readdirSync(getInbox(OWNER).cur).filter((f) => f.endsWith(".json"))).toEqual([]);

    expect(await checkMessages(OWNER)).toEqual([]);
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
    expect(readdirSync(getInbox(OWNER).cur).filter((f) => f.endsWith(".json"))).toEqual([]);
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
    expect(printed.stdout).toContain("external-tier mail cannot be acknowledged or nacked by an internal consumer");
    expect(printed.stdout).not.toContain("tps mail ack");

    const ack = await runCli(["mail", "ack", sent.id, "--agent", OWNER], SENDER);
    expect(ack.status).not.toBe(0);
    expect(ack.stderr).toContain("external-tier mail cannot be acknowledged");
  });
});
