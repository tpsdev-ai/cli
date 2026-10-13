/**
 * cli#617 slice (b): the per-message delivery API — commits one message and
 * leaves its intent live in the `in_progress` phase, finalized only on
 * completion, with a liveness bound. Real signed records through the real
 * parser and signer; nothing in the runtime calls these methods yet.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { MailClient } from "../src/io/mail.js";
import {
  MAX_DELIVERY_PRESENTATIONS,
  hasCommittedMessageId,
  mailboxReplayStore,
  pendingPlacementEntries,
} from "../src/lib/mailbox-policy.js";
import { signEnvelope, type FlairClient } from "../src/lib/signEnvelope.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const SEED = Buffer.alloc(32, 0x57);
const CHILD = fileURLToPath(new URL("./helpers/mail-kill-child.mjs", import.meta.url));
const MODULE = new URL("../src/io/mail.ts", import.meta.url).href;

let mailDir: string;
let root: string;

const cur = (file: string) => join(root, "cur", file);
const fresh = (file: string) => join(root, "new", file);

function verifier(): FlairClient {
  return {
    async getAgent(name: string) {
      return name === FROM ? { publicKey: Buffer.from(ed.getPublicKey(SEED)) } : null;
    },
  };
}

const client = () => new MailClient(mailDir, undefined, AGENT, verifier());

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "mail-delivery-"));
  root = join(mailDir, AGENT);
  mkdirSync(join(root, "new"), { recursive: true });
  mkdirSync(join(root, "cur"), { recursive: true });
});

afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

/** Write one signed record to `path`. */
function signedRecord(path: string, messageId: string, body = "delivery-body"): void {
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

const plant = (file: string, messageId: string) => signedRecord(fresh(file), messageId);

const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []);
const newFiles = () => jsonFiles(join(root, "new"));
const curFiles = () => jsonFiles(join(root, "cur"));

const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const intentPath = (file: string) => join(root, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);
const intentText = (file: string) => textOf(intentPath(file));
const intentJson = (file: string) => JSON.parse(readFileSync(intentPath(file), "utf8"));
const intentPhase = (file: string) => mailboxReplayStore(root).placementPhase(file);

/** A committed message as slice (b) leaves it, with the given intent fields. */
function setPhase(fields: Record<string, unknown>, file = "m1.json"): Buffer {
  const path = intentPath(file);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...fields }));
  return readFileSync(path);
}

function committed(messageId: string, fields: Record<string, unknown>, file = "m1.json"): Buffer {
  signedRecord(fresh(file), messageId);
  const replay = mailboxReplayStore(root);
  replay.beginPlacement(messageId, file, fresh(file));
  linkSync(fresh(file), cur(file));
  unlinkSync(fresh(file));
  replay.recordConsumed(messageId);
  return setPhase(fields, file);
}

const quarantined = (file: string) => existsSync(`${intentPath(file)}.quarantined`);

describe("per-message delivery commits one message at a time", () => {
  test("later messages stay in new/ until the in-flight one completes", async () => {
    plant("m1.json", "id-1");
    plant("m2.json", "id-2");
    plant("m3.json", "id-3");

    const c = client();
    const first = await c.deliverNext();
    expect(first?.verifiedEnvelope?.messageId).toBe("id-1");
    expect(curFiles()).toEqual(["m1.json"]);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    // Not finalized: the next call re-presents the same message (at least once)
    // and still does not commit a later one.
    const again = await c.deliverNext();
    expect(again?.verifiedEnvelope?.messageId).toBe("id-1");
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    expect(await c.completeDelivery(again!)).toBe(true);
    expect(intentPhase("m1.json")).toBeNull();

    const second = await c.deliverNext();
    expect(second?.verifiedEnvelope?.messageId).toBe("id-2");
    expect(curFiles()).toEqual(["m1.json", "m2.json"]);
    expect(newFiles()).toEqual(["m3.json"]);
  });

  test("completion is idempotent and stops re-presentation", async () => {
    plant("m1.json", "solo");
    const c = client();
    const m = await c.deliverNext();
    expect(await c.completeDelivery(m!)).toBe(true);
    expect(await c.completeDelivery(m!)).toBe(false);
    expect(await c.deliverNext()).toBeNull();
  });
});

describe("in_progress re-presentation in recovery", () => {
  test("a fresh client re-presents a committed message until it is completed", async () => {
    plant("m1.json", "resume-in-progress");
    const first = await client().deliverNext();
    expect(first?.verifiedEnvelope?.messageId).toBe("resume-in-progress");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(intentJson("m1.json").presentations).toBe(1);

    const restarted = client();
    const again = await restarted.deliverNext();
    expect(again?.verifiedEnvelope?.messageId).toBe("resume-in-progress");
    expect(intentJson("m1.json").presentations).toBe(2);

    await restarted.completeDelivery(again!);
    expect(await client().deliverNext()).toBeNull();
  });

  test("a placing intent left by a crash is finished to in_progress and presented", async () => {
    plant("m1.json", "resume-placing");
    const replay = mailboxReplayStore(root);
    replay.beginPlacement("resume-placing", "m1.json", fresh("m1.json"));
    linkSync(fresh("m1.json"), cur("m1.json"));
    // No consumed id and no phase yet: a crash between the link and the phase write.

    const c = client();
    const m = await c.deliverNext();
    expect(m?.verifiedEnvelope?.messageId).toBe("resume-placing");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(hasCommittedMessageId(root, "resume-placing")).toBe(true);

    expect((await c.deliverNext())?.verifiedEnvelope?.messageId).toBe("resume-placing");
  });
});

describe("a duplicate envelope during handling is refused", () => {
  test("the same signed envelope under a new name is dead-lettered as replay once committed", async () => {
    plant("m1.json", "duplicate");
    const c = client();
    const m = await c.deliverNext();
    expect(await c.completeDelivery(m!)).toBe(true);

    // The same envelope (same messageId) arrives under a different filename.
    writeFileSync(fresh("m1-copy.json"), readFileSync(cur("m1.json")));
    expect(await client().deliverNext()).toBeNull();
    expect(textOf(join(root, "dlq", "m1-copy.json.reason")) ?? "").toContain("class: replay");
  });
});

describe("the liveness bound quarantines a message that is never completed", () => {
  const FAILED_AT = `not completed after ${MAX_DELIVERY_PRESENTATIONS} presentation(s)`;

  test("after the presentation count the intent goes terminal, a line is logged, and other mail flows", async () => {
    plant("m1.json", "poison");
    plant("m2.json", "healthy");
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    let last: Awaited<ReturnType<MailClient["deliverNext"]>> = null;
    try {
      const c = client();
      for (let i = 0; i < MAX_DELIVERY_PRESENTATIONS; i++) {
        last = await c.deliverNext();
        expect(last?.verifiedEnvelope?.messageId).toBe("poison");
      }
      // The next hand-over would exceed the bound: poison is not presented, its
      // intent becomes terminal `failed`, and the next message flows.
      const next = await c.deliverNext();
      expect(next?.verifiedEnvelope?.messageId).toBe("healthy");
    } finally { warn.mockRestore(); }

    expect(warnings.some((w) => w.includes("poison") && w.includes(FAILED_AT))).toBe(true);
    expect(intentPhase("m1.json")).toBe("failed");
    expect(textOf(cur("m1.json"))).not.toBeNull(); // payload retained
    // poison is terminal, so it is not a pending entry; the message that flowed is.
    expect(pendingPlacementEntries(root).map((e) => e.messageId)).toEqual(["healthy"]);
    expect(mailboxReplayStore(root).hasPendingFile("m1.json")).toBe(false);
    expect(hasCommittedMessageId(root, "poison")).toBe(true);
  });

  test("a message past the presentation TTL is quarantined on the next hand-over", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    committed("stale", { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: stale });
    plant("m2.json", "healthy");

    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    let next: Awaited<ReturnType<MailClient["deliverNext"]>>;
    try { next = await client().deliverNext(); } finally { warn.mockRestore(); }

    expect(next?.verifiedEnvelope?.messageId).toBe("healthy");
    expect(intentPhase("m1.json")).toBe("failed");
    expect(warnings.some((w) => w.includes("stale"))).toBe(true);
  });

  test("the terminal intent keeps its message refused by the replay gate", async () => {
    const bytes = committed("poisoned", { version: 1, phase: "failed", presentations: 5, firstPresentedAt: new Date().toISOString() });
    expect(intentPhase("m1.json")).toBe("failed");
    // Same signed envelope under a fresh name: refused at commit as a replay.
    writeFileSync(fresh("m1.json"), readFileSync(cur("m1.json")));
    expect(await client().deliverNext()).toBeNull();
    expect(textOf(join(root, "dlq", "m1.json.reason")) ?? "").toContain("class: replay");
    expect(intentJson("m1.json").phase).toBe("failed");
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("an unknown phase is preserved", () => {
  test("not presented, not finalized and not quarantined for its value; its file gate stays closed", async () => {
    const bytes = committed("kept-unknown", { version: 1, phase: "awaiting-review" });
    expect(await client().deliverNext()).toBeNull();
    expect(intentText("m1.json") ?? "").toBe(bytes.toString("utf8"));
    expect(quarantined("m1.json")).toBe(false);
    expect(mailboxReplayStore(root).hasPendingFile("m1.json")).toBe(true);
    expect(hasCommittedMessageId(root, "kept-unknown")).toBe(true);
  });
});

interface KillRun { signal: NodeJS.Signals | null; reached: boolean; stderr: string; }

function runAndKillAt(killAt: string, file: string, after = false, timeoutMs = 20_000): Promise<KillRun> {
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
      TPS_MAIL_ROOT: root,
      TPS_SRC: fresh(file),
      TPS_CUR: cur(file),
      TPS_FROM: FROM,
      TPS_SEED: SEED.toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<KillRun>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const poll = setInterval(() => { if (existsSync(marker)) { clearInterval(poll); child.kill("SIGKILL"); } }, 15);
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(deadline);
      child.kill("SIGKILL");
      reject(new Error(`child never reached ${killAt} (stderr: ${stderr})`));
    }, timeoutMs);
    child.once("error", (e) => { if (!settled) { settled = true; clearInterval(poll); clearTimeout(deadline); reject(e); } });
    child.once("exit", (_code, signal) => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(deadline);
      resolve({ signal, reached: existsSync(marker), stderr });
    });
  });
}

describe("a kill mid-delivery re-presents on the next call", () => {
  for (const at of ["intent-write", "link-to-cur", "source-removal", "ledger-commit"]) {
    test(`killed before ${at}: the next call presents the message, later mail waits`, async () => {
      plant("m1.json", `kill-${at}`);
      plant("m2.json", "later");

      const run = await runAndKillAt(at, "m1.json");
      expect(run.reached, `child never reached ${at}; stderr=${run.stderr}`).toBe(true);
      expect(run.signal).toBe("SIGKILL");

      const c = client();
      const m = await c.deliverNext();
      expect(m?.verifiedEnvelope?.messageId).toBe(`kill-${at}`);
      expect(newFiles()).toContain("m2.json");

      expect(await c.completeDelivery(m!)).toBe(true);
      const next = await c.deliverNext();
      expect(next?.verifiedEnvelope?.messageId).toBe("later");
    });
  }

  test("killed after the intent becomes in_progress: the next call re-presents it and later mail waits", async () => {
    plant("m1.json", "after-in-progress");
    plant("m2.json", "later");

    const run = await runAndKillAt("phase-write", "m1.json", true);
    expect(run.reached, `child never reached the phase write; stderr=${run.stderr}`).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(intentPhase("m1.json")).toBe("in_progress");

    const c = client();
    const m = await c.deliverNext();
    expect(m?.verifiedEnvelope?.messageId).toBe("after-in-progress");
    expect(intentJson("m1.json").presentations).toBe(2);
    expect(newFiles()).toContain("m2.json");
  });
});
