/** Filesystem crash and unresolved-intent regressions for the per-message delivery API. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { type DeliverNextResult, MailClient } from "../src/io/mail.js";
import { hasCommittedMessageId, mailboxReplayStore } from "../src/lib/mailbox-policy.js";
import { acquireMailLock } from "../src/lib/mail-lock.js";
import { signEnvelope, type FlairClient } from "../src/lib/signEnvelope.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const SEED = Buffer.alloc(32, 0x24);
const CHILD = fileURLToPath(new URL("./helpers/mail-kill-child.mjs", import.meta.url));
const MODULE = new URL("../src/io/mail.ts", import.meta.url).href;

let mailDir: string;
let mailboxRoot: string;
const curPath = () => join(mailboxRoot, "cur", "m1.json");
const newPath = () => join(mailboxRoot, "new", "m1.json");

/** The verifier MailClient uses: resolves FROM to its public key, no network. */
function verifier(): FlairClient {
  return {
    async getAgent(name: string) {
      return name === FROM ? { publicKey: Buffer.from(ed.getPublicKey(SEED)) } : null;
    },
  };
}

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "mail-recovery-"));
  mailboxRoot = join(mailDir, AGENT);
  mkdirSync(join(mailboxRoot, "new"), { recursive: true });
});

afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

/** Plant one signed record in new/ and return its path. */
function plant(messageId: string, body = "recovery-body"): string {
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope(
    {
      v: 1,
      from: FROM,
      to: AGENT,
      body,
      messageId,
      timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: FROM, kind: "agent", timestamp, rationale: "sends", signature: null },
      ],
    },
    { [FROM]: SEED },
  );
  const source = newPath();
  writeFileSync(source, JSON.stringify({ from: FROM, body: JSON.stringify(envelope) }));
  return source;
}

const jsonFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name)
    : [];

interface KillRun {
  signal: NodeJS.Signals | null;
  reached: boolean;
  stderr: string;
}

/** Run deliverNext() in a child and SIGKILL it at `killAt`; resolve on exit. */
function runAndKillAt(killAt: string, source: string, after = false, timeoutMs = 20_000): Promise<KillRun> {
  const marker = join(mailDir, `paused.${killAt}`);
  const child = spawn(process.execPath, [CHILD, mailDir, AGENT], {
    env: {
      HOME: mailDir,
      PATH: process.env.PATH,
      TPS_MAIL_MODULE: MODULE,
      TPS_DRIVE: "deliverNext",
      TPS_KILL_AT: killAt,
      ...(after ? { TPS_KILL_AFTER: "1" } : {}),
      TPS_KILL_MARKER: marker,
      TPS_MAIL_ROOT: mailboxRoot,
      TPS_SRC: source,
      TPS_CUR: curPath(),
      TPS_FROM: FROM,
      TPS_SEED: SEED.toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<KillRun>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const stop = () => {
      clearInterval(poll);
      clearTimeout(deadline);
      settled = true;
    };
    const poll = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(poll);
        child.kill("SIGKILL");
      }
    }, 15);
    const deadline = setTimeout(() => {
      if (settled) return;
      stop();
      child.kill("SIGKILL");
      reject(new Error(`child never reached ${killAt} (stderr: ${stderr})`));
    }, timeoutMs);
    child.once("error", (e) => {
      if (settled) return;
      stop();
      reject(e);
    });
    child.once("exit", (_code, signal) => {
      if (settled) return;
      stop();
      resolve({ signal, reached: existsSync(marker), stderr });
    });
  });
}

const reasonOf = (result: DeliverNextResult) => (result.status === "deferred" ? result.reason : result.status);

async function assertDeliveredUntilCompleted(messageId: string): Promise<void> {
  const client = new MailClient(mailDir, undefined, AGENT, verifier());
  const first = await client.deliverNext();
  if (first.status !== "delivered") throw new Error(`expected a delivery, got ${JSON.stringify(first)}`);
  expect(first.delivery.message.verifiedEnvelope?.messageId).toBe(messageId);
  expect(reasonOf(await client.deliverNext())).toBe("active");
  client.releaseDelivery(first.delivery);
  const second = await client.deliverNext();
  if (second.status !== "delivered") throw new Error(`expected a delivery, got ${JSON.stringify(second)}`);
  expect(second.delivery.message.verifiedEnvelope?.messageId).toBe(messageId);
  expect(await client.completeDelivery(second.delivery)).toEqual({ status: "completed" });
  expect(await client.deliverNext()).toEqual({ status: "idle" });
  expect(existsSync(newPath())).toBe(false);
  expect(jsonFiles(join(mailboxRoot, "cur"))).toEqual(["m1.json"]);
  expect(jsonFiles(join(mailboxRoot, "dlq"))).toEqual([]);
  expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(true);
  expect(
    readdirSync(mailboxRoot).some((n) => n.startsWith(".placement-") && n.endsWith(".json")),
  ).toBe(false);
}

const CASES: Array<{ at: string; after?: boolean }> = [
  { at: "intent-write" },
  { at: "link-to-cur" },
  { at: "source-removal" },
  { at: "ledger-commit" },
  { at: "phase-write", after: true },
];

describe("MailClient recovery at the tested placement boundaries (cli#600)", () => {
  for (const { at, after } of CASES) {
    test(`recovers, releases, re-presents and completes after a kill at ${at}`, async () => {
      const messageId = `kill-${at}`;
      const source = plant(messageId);
      const run = await runAndKillAt(at, source, after);
      expect(run.reached, `child never reached ${at}; stderr=${run.stderr}`).toBe(true);
      expect(run.signal).toBe("SIGKILL");
      await assertDeliveredUntilCompleted(messageId);
    });
  }
});

describe("pending record classification", () => {
  function plantLater(): void {
    renameSync(plant("later-mail"), join(mailboxRoot, "new", "z-later.json"));
  }

  async function deliverLater(client: MailClient): Promise<void> {
    const later = await client.deliverNext();
    expect(later.status).toBe("delivered");
    if (later.status !== "delivered") throw new Error(JSON.stringify(later));
    expect(later.delivery.message.verifiedEnvelope?.messageId).toBe("later-mail");
    expect(await client.completeDelivery(later.delivery)).toEqual({ status: "completed" });
  }

  test("a raw wrapper with an extra envelope object recovers after a kill before the phase write", async () => {
    plantLater();
    const source = plant("raw-extra-envelope");
    const raw = { ...JSON.parse(readFileSync(source, "utf8")), envelope: { extra: true } };
    writeFileSync(source, JSON.stringify(raw));
    const run = await runAndKillAt("phase-write", source);
    expect(run.reached, run.stderr).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(mailboxReplayStore(mailboxRoot).placementPhase("m1.json")).toBe("placing");
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    const recovered = await client.deliverNext();
    expect(recovered.status).toBe("delivered");
    if (recovered.status !== "delivered") throw new Error(JSON.stringify(recovered));
    expect(recovered.delivery.message.verifiedEnvelope?.messageId).toBe("raw-extra-envelope");
    expect(JSON.parse(recovered.delivery.message.body)).toEqual(raw);
    expect(await client.completeDelivery(recovered.delivery)).toEqual({ status: "completed" });
    expect(mailboxReplayStore(mailboxRoot).placementPhase("m1.json")).toBeNull();
    await deliverLater(client);
  });

  test.each([null, {}, { envelope: {} }, { body: "plain text", envelopeId: "self-asserted" }])(
    "a record matching neither kind is quarantined and its intent cleared: %j", async (record) => {
      plantLater();
      const source = plant("invalid-pending");
      writeFileSync(source, JSON.stringify(record));
      const client = new MailClient(mailDir, undefined, AGENT, verifier());
      const replay = mailboxReplayStore(mailboxRoot);
      replay.beginPlacement("invalid-pending", "m1.json", source);
      renameSync(source, curPath());
      expect(await client.deliverNext()).toMatchObject({ status: "deferred", reason: "pending-record-invalid" });
      expect(replay.placementPhase("m1.json")).toBeNull();
      expect(existsSync(curPath())).toBe(false);
      expect(JSON.parse(readFileSync(join(mailboxRoot, "dlq", "m1.json"), "utf8"))).toEqual(record);
      expect(readFileSync(join(mailboxRoot, "dlq", "m1.json.reason"), "utf8")).toContain("Reason: pending-record-invalid");
      await deliverLater(client);
    },
  );

  test.each(["both", "raw", "cli"])("overlapping shapes select by verification: %s", async (verified) => {
    plantLater();
    const source = plant("raw-inner");
    const raw = JSON.parse(readFileSync(source, "utf8"));
    plant("cli-outer", raw.body);
    const envelope = JSON.parse(JSON.parse(readFileSync(source, "utf8")).body);
    const record = {
      id: "record-id", from: FROM, to: AGENT, body: raw.body, timestamp: envelope.timestamp,
      read: false, envelopeId: envelope.messageId, envelope,
      trustTier: "internal", checkedOutAt: new Date().toISOString(), checkedOutBy: AGENT, deliveryAttempts: 1,
    };
    if (verified === "raw") record.envelope.signature = "invalid";
    if (verified === "cli") {
      const inner = JSON.parse(record.body);
      inner.signature = "invalid";
      record.body = JSON.stringify(inner);
      plant("cli-outer", record.body);
      record.envelope = JSON.parse(JSON.parse(readFileSync(source, "utf8")).body);
      record.timestamp = record.envelope.timestamp;
    }
    writeFileSync(source, JSON.stringify(record));
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    const replay = mailboxReplayStore(mailboxRoot);
    replay.beginPlacement(verified === "cli" ? "cli-outer" : "raw-inner", "m1.json", source);
    renameSync(source, curPath());
    const result = await client.deliverNext();
    if (verified === "both") {
      expect(result).toMatchObject({ status: "deferred", reason: "pending-record-ambiguous" });
      expect(replay.placementPhase("m1.json")).toBeNull();
      expect(readFileSync(join(mailboxRoot, "dlq", "m1.json.reason"), "utf8")).toContain("Reason: pending-record-ambiguous");
      await deliverLater(client);
    } else if (verified === "raw") {
      expect(result.status).toBe("delivered");
      if (result.status !== "delivered") throw new Error(JSON.stringify(result));
      expect(result.delivery.message.verifiedEnvelope?.messageId).toBe("raw-inner");
      expect(await client.completeDelivery(result.delivery)).toEqual({ status: "completed" });
      await deliverLater(client);
    } else {
      expect(result).toMatchObject({ status: "deferred", reason: "cli-record" });
      expect(replay.placementPhase("m1.json")).toBe("placing");
    }
  });
});

describe("MailClient defers unresolved placements", () => {
  test("a mismatched cur copy and same-id new copy leave the pending intent unchanged", async () => {
    const messageId = "mismatched-copy";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    const original = readFileSync(source);
    plant("unrelated-cur-copy");
    copyFileSync(source, curPath());
    writeFileSync(source, original);
    const intentPath = join(mailboxRoot, readdirSync(mailboxRoot).find((n) => n.startsWith(".placement-") && n.endsWith(".json"))!);
    const intent = readFileSync(intentPath);

    // The cur/ copy verifies, but as another message: deferred by name, twice, unchanged.
    expect(reasonOf(await client.deliverNext())).toBe("verification-failed");
    expect(reasonOf(await client.deliverNext())).toBe("verification-failed");
    expect(readFileSync(intentPath).equals(intent)).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
  });

  test("different invalid UTF-8 bytes with equal decoded text defer recovery", async () => {
    const messageId = "changed-raw-bytes";
    const source = plant(messageId);
    const record = readFileSync(source);
    const bytes = (byte: number) => Buffer.concat([
      Buffer.from('{"transport":"'), Buffer.from([byte]), Buffer.from('",'), record.subarray(1),
    ]);
    const original = bytes(0x80);
    const replacement = bytes(0x81);
    expect(original.equals(replacement)).toBe(false);
    expect(original.toString("utf8")).toBe(replacement.toString("utf8"));
    writeFileSync(source, original);
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    mkdirSync(join(mailboxRoot, "cur"));
    renameSync(source, curPath());
    const normal = verifier();
    let changed = false;
    const client = new MailClient(mailDir, undefined, AGENT, {
      async getAgent(name: string) {
        if (!changed) {
          changed = true;
          writeFileSync(curPath(), replacement);
        }
        return normal.getAgent(name);
      },
    });

    expect(reasonOf(await client.deliverNext())).toBe("record-changed");
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
    await assertDeliveredUntilCompleted(messageId);
  });

  test("an older intent without identity with only a cur copy is withheld", async () => {
    const messageId = "older-intent";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json");
    renameSync(source, curPath());
    expect(reasonOf(await client.deliverNext())).toBe("record-changed");
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    expect(hasCommittedMessageId(mailboxRoot, messageId)).toBe(false);
  });

  test("absent-copy cleanup preserves an intent while a mismatched cur copy exists", async () => {
    const messageId = "appeared-copy";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    copyFileSync(source, curPath());
    await (client as unknown as { finishUnlinkedPlacement(id: string, file: string): Promise<void> })
      .finishUnlinkedPlacement(messageId, "m1.json");
    expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
  });

  test("lock-acquisition failure leaves a cur-only placement pending", async () => {
    const messageId = "lock-failure";
    const source = plant(messageId);
    const client = new MailClient(mailDir, undefined, AGENT, verifier());
    mailboxReplayStore(mailboxRoot).beginPlacement(messageId, "m1.json", source);
    renameSync(source, curPath());
    // The client locks its mailbox at the path it resolved once at construction.
    const lock = await acquireMailLock(realpathSync(mailboxRoot));
    expect(lock).not.toBeNull();
    try {
      expect(reasonOf(await client.deliverNext())).toBe("lock-busy");
      expect(mailboxReplayStore(mailboxRoot).hasPendingPlacement(messageId, "m1.json")).toBe(true);
    } finally {
      lock?.release();
    }
    await assertDeliveredUntilCompleted(messageId);
  });
});
