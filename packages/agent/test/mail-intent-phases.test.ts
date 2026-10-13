/**
 * cli#617 slice (a): placement intents carry a phase, and MailClient recovery
 * and the store keep an intent whose declared phase is not `placing`. Nothing
 * writes `in_progress` or `failed` yet, so these fixtures write them directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { MailClient } from "../src/io/mail.js";
import { hasCommittedMessageId, mailboxReplayStore, pendingPlacementEntries } from "../src/lib/mailbox-policy.js";
import { signEnvelope, type FlairClient } from "../src/lib/signEnvelope.js";
import type { EventLogger } from "../src/telemetry/events.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const SEED = Buffer.alloc(32, 0x31);

let mailDir: string;
let root: string;
let verifierCalls: number;
let onVerify: (() => void) | undefined;

const cur = (file = "m1.json") => join(root, "cur", file);
const fresh = (file = "m1.json") => join(root, "new", file);
const intentPath = (file = "m1.json") =>
  join(root, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);

function verifier(): FlairClient {
  return {
    async getAgent(name: string) {
      verifierCalls++;
      onVerify?.();
      return name === FROM ? { publicKey: Buffer.from(ed.getPublicKey(SEED)) } : null;
    },
  };
}

const client = () => new MailClient(mailDir, undefined, AGENT, verifier());

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "mail-intent-phases-"));
  root = join(mailDir, AGENT);
  mkdirSync(join(root, "new"), { recursive: true });
  mkdirSync(join(root, "cur"), { recursive: true });
  verifierCalls = 0;
  onVerify = undefined;
});

afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

/** Write one signed record to `path`. */
function signedRecord(path: string, messageId: string, body = "phase-body"): void {
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope(
    {
      v: 1, from: FROM, to: AGENT, body, messageId, timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: FROM, kind: "agent", timestamp, rationale: "sends", signature: null },
      ],
    },
    { [FROM]: SEED },
  );
  writeFileSync(path, JSON.stringify({ from: FROM, body: JSON.stringify(envelope) }));
}

/** Rewrite the intent for `file` with these extra fields (a writer this slice does not ship). */
function setPhase(fields: Record<string, unknown>, file = "m1.json"): Buffer {
  const path = intentPath(file);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...fields }));
  return readFileSync(path);
}

/**
 * A committed message as design rev 2 leaves it: the payload in cur/, its ID
 * in the consumed ledger, and its intent in the given phase.
 */
function committed(messageId: string, fields: Record<string, unknown>): Buffer {
  signedRecord(fresh(), messageId);
  const replay = mailboxReplayStore(root);
  replay.beginPlacement(messageId, "m1.json", fresh());
  linkSync(fresh(), cur());
  unlinkSync(fresh());
  replay.recordConsumed(messageId);
  return setPhase(fields);
}

const quarantined = (file = "m1.json") => existsSync(`${intentPath(file)}.quarantined`);
/** A file's text, or null when it is absent, so a removal fails an assertion rather than throwing. */
const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const intentText = (file = "m1.json") => textOf(intentPath(file));
const ids = (messages: Awaited<ReturnType<MailClient["checkNewMail"]>>) => messages.map((m) => m.verifiedEnvelope?.messageId);
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []);

const now = () => new Date().toISOString();
const PRESERVED: Record<string, Record<string, unknown>> = {
  in_progress: { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: now() },
  "an unknown phase": { version: 1, phase: "awaiting-review" },
  "a future schema version": { version: 2, phase: "placing" },
  "a phase field it cannot read": { version: 1, phase: "in_progress", presentations: -1 },
};

describe("agent recovery keeps an in_progress or unknown intent (io/mail.ts recoverInterruptedPlacements)", () => {
  for (const [name, fields] of Object.entries(PRESERVED)) {
    for (const copy of ["present", "absent"] as const) {
      test(`${name}, cur copy ${copy}: skipped at listing, not presented, finished or quarantined; other mail flows`, async () => {
        const bytes = committed(`phase-${copy}`, fields);
        if (copy === "absent") unlinkSync(cur());
        const payload = copy === "present" ? textOf(cur()) : null;
        signedRecord(fresh("m2.json"), "unrelated");

        const c = client();
        expect(ids(await c.checkNewMail())).toEqual(["unrelated"]);
        expect(await c.checkNewMail()).toEqual([]);

        expect(intentText()).toBe(bytes.toString("utf8"));
        expect(quarantined()).toBe(false);
        expect(verifierCalls).toBe(1); // the unrelated message only: a phase seen at listing skips the payload
        expect(textOf(cur())).toBe(payload);
        expect(jsonFiles(join(root, "dlq"))).toEqual([]);
      });
    }
  }

  test("a placing intent that turns in_progress before the recovery lock is not presented", async () => {
    committed("raced", {});
    let raced: Buffer | undefined;
    onVerify = () => {
      raced ??= setPhase({ version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: now() });
    };
    expect(await client().checkNewMail()).toEqual([]);
    expect(raced).toBeDefined();
    expect(intentText()).toBe(raced!.toString("utf8"));
  });

  test("a placing intent still recovers exactly as before", async () => {
    committed("still-placing", {});
    const c = client();
    expect(ids(await c.checkNewMail())).toEqual(["still-placing"]);
    expect(await c.checkNewMail()).toEqual([]);
    expect(existsSync(intentPath())).toBe(false);
  });
});

describe("the quarantine path keeps an unknown phase (mailbox-policy.ts readPlacementIntent)", () => {
  for (const [name, fields] of Object.entries(PRESERVED).filter(([n]) => n !== "in_progress")) {
    test(`${name} is listed as unknown, gates its own file and is not quarantined for its phase`, () => {
      const bytes = committed("kept-unknown", fields);
      const replay = mailboxReplayStore(root);
      expect(pendingPlacementEntries(root)).toEqual([{ messageId: "kept-unknown", file: "m1.json", phase: "unknown" }]);
      expect(replay.hasPendingFile("m1.json")).toBe(true);
      expect(replay.isConsumed("some-other-id")).toBe(false); // the ledger read that quarantines malformed intents
      expect(quarantined()).toBe(false);
      expect(intentText()).toBe(bytes.toString("utf8"));
    });
  }
});

describe("a failed intent does not close the per-file gate", () => {
  test("not presented, a same-name duplicate is refused as replay, other mail flows, intent and payload kept", async () => {
    const bytes = committed("poisoned", { version: 1, phase: "failed", presentations: 5, firstPresentedAt: now() });
    const payload = textOf(cur());
    expect(pendingPlacementEntries(root)).toEqual([]);
    expect(mailboxReplayStore(root).hasPendingFile("m1.json")).toBe(false);

    copyFileSync(cur(), fresh()); // the same signed record again, under the same name
    signedRecord(fresh("m2.json"), "after-the-poison");
    const c = client();
    expect(ids(await c.checkNewMail())).toEqual(["after-the-poison"]);
    expect(await c.checkNewMail()).toEqual([]);

    expect(existsSync(fresh())).toBe(false);
    expect(textOf(join(root, "dlq", "m1.json.reason")) ?? "").toContain("class: replay");
    expect(textOf(cur())).toBe(payload);
    expect(intentText()).toBe(bytes.toString("utf8"));
    expect(hasCommittedMessageId(root, "poisoned")).toBe(true);
  });

  const FAILED = { version: 1, phase: "failed", presentations: 5, firstPresentedAt: now() };
  const tombstone = (id: string) => intentPath().replace(/\.json$/, `.failed-${id}.json`);

  test("once the failed payload is archived and its tombstone name is unoccupied, a different message at the same name is delivered; the marker moves to that tombstone, which keeps its consumed ID", async () => {
    const bytes = committed("poisoned", FAILED);
    const archived = join(root, "archive", "2026-01");
    mkdirSync(archived, { recursive: true });
    renameSync(cur(), join(archived, "m1.json")); // what archiveOldCur does with an aged cur/ record
    signedRecord(fresh(), "reused-name");

    const c = client();
    expect(ids(await c.checkNewMail())).toEqual(["reused-name"]);
    expect(await c.checkNewMail()).toEqual([]);

    expect(existsSync(fresh())).toBe(false);
    expect(textOf(tombstone("poisoned"))).toBe(bytes.toString("utf8"));
    expect(intentText()).toBeNull();
    expect(pendingPlacementEntries(root)).toEqual([]);
    expect(hasCommittedMessageId(root, "reused-name")).toBe(true);

    // The tombstone keeps the old consumed ID through a ledger prune.
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(root, "consumed.jsonl"), `${[
      JSON.stringify({ id: "poisoned", at: old }), JSON.stringify({ id: "reused-name", at: now() }),
    ].join("\n")}\n`);
    expect(mailboxReplayStore(root).isConsumed("absent-id")).toBe(false);
    expect(hasCommittedMessageId(root, "poisoned")).toBe(true);
  });

  /** A failed marker whose payload has been archived, plus a different message waiting under its name. */
  function archivedFailedWithReuse(): Buffer {
    const bytes = committed("poisoned", FAILED);
    const archived = join(root, "archive", "2026-01");
    mkdirSync(archived, { recursive: true });
    renameSync(cur(), join(archived, "m1.json"));
    signedRecord(fresh(), "reused-name");
    return bytes;
  }

  test("an occupied tombstone refuses the reuse by name: marker and tombstone stay byte-identical, nothing is presented", async () => {
    const marker = archivedFailedWithReuse();
    const retained = JSON.stringify({ messageId: "poisoned", file: "m1.json", phase: "failed", note: "an operator's retained record" });
    writeFileSync(tombstone("poisoned"), retained);
    const errors: string[] = [];
    const events = { emit: (e: { status?: string; error?: string }) => { if (e.status === "error") errors.push(e.error ?? ""); } };
    const c = new MailClient(mailDir, events as unknown as EventLogger, AGENT, verifier());

    expect(await c.checkNewMail()).toEqual([]);
    expect(await c.checkNewMail()).toEqual([]);

    expect(errors.some((e) => e.includes("failed tombstone occupied for m1.json"))).toBe(true);
    expect(existsSync(fresh())).toBe(true);
    expect(existsSync(cur())).toBe(false);
    expect(intentText()).toBe(marker.toString("utf8"));
    expect(textOf(tombstone("poisoned"))).toBe(retained);
    expect(hasCommittedMessageId(root, "reused-name")).toBe(false);
    expect(() => mailboxReplayStore(root).beginPlacement("reused-name", "m1.json", fresh())).toThrow("failed tombstone occupied for m1.json");
    expect(intentText()).toBe(marker.toString("utf8"));
    expect(textOf(tombstone("poisoned"))).toBe(retained);
  });

  test("a tombstone that is the marker's own inode is treated as an interrupted move and finished, and the reuse proceeds", async () => {
    const marker = archivedFailedWithReuse();
    linkSync(intentPath(), tombstone("poisoned"));

    expect(ids(await client().checkNewMail())).toEqual(["reused-name"]);

    expect(textOf(tombstone("poisoned"))).toBe(marker.toString("utf8"));
    expect(intentText()).toBeNull();
  });

  test("while the failed payload is still in cur/, a different message at the same name waits and the marker stays", async () => {
    const bytes = committed("poisoned", FAILED);
    const payload = textOf(cur());
    signedRecord(fresh(), "reused-too-soon");

    expect(await client().checkNewMail()).toEqual([]);

    expect(existsSync(fresh())).toBe(true);
    expect(intentText()).toBe(bytes.toString("utf8"));
    expect(textOf(cur())).toBe(payload);
    expect(existsSync(tombstone("poisoned"))).toBe(false);
  });
});

describe("the store never finishes or replaces a same-message intent in another phase", () => {
  const OTHER = { ...PRESERVED, failed: { version: 1, phase: "failed", presentations: 5, firstPresentedAt: now() } };
  for (const [name, fields] of Object.entries(OTHER)) {
    test(`${name}: finishPlacement and beginPlacement leave it byte-identical`, () => {
      const bytes = committed("kept", fields);
      const replay = mailboxReplayStore(root);
      replay.finishPlacement("kept", "m1.json");
      expect(intentText()).toBe(bytes.toString("utf8"));
      expect(() => replay.beginPlacement("kept", "m1.json", cur())).toThrow("not replaced");
      expect(intentText()).toBe(bytes.toString("utf8"));
    });
  }
});

describe("parsePlacement requires intent.file to be a plain basename", () => {
  test("a non-basename intent is quarantined and never recovered", async () => {
    const file = "../escape.json";
    const outside = join(root, "escape.json");
    signedRecord(outside, "outside-cur");
    const st = statSync(outside, { bigint: true });
    writeFileSync(intentPath(file), JSON.stringify({
      messageId: "outside-cur", file, identity: { dev: st.dev.toString(), ino: st.ino.toString() },
    }));
    expect(await client().checkNewMail()).toEqual([]);
    expect(quarantined(file)).toBe(true);
    expect(hasCommittedMessageId(root, "outside-cur")).toBe(false);
  });

  for (const file of ["", ".", "..", "a/b.json", "a\\b.json"]) {
    test(`${JSON.stringify(file)} is refused on write and on read`, () => {
      expect(() => mailboxReplayStore(root).beginPlacement("not-a-name", file)).toThrow("plain basename");
      writeFileSync(intentPath(file), JSON.stringify({ messageId: "not-a-name", file }));
      expect(pendingPlacementEntries(root)).toEqual([]);
      expect(quarantined(file)).toBe(true);
    });
  }
});
