

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { type DeliverNextResult, type MailDelivery, MailClient } from "../src/io/mail.js";
import { acquireMailLock } from "../src/lib/mail-lock.js";
import { EventLogger } from "../src/telemetry/events.js";
import {
  DELIVERY_PRESENTATION_TTL_MS,
  MAX_DELIVERY_PRESENTATIONS,
  hasCommittedMessageId,
  mailboxReplayStore,
  pendingPlacementEntries,
} from "../src/lib/mailbox-policy.js";
import { signEnvelope, type FlairClient } from "../src/lib/signEnvelope.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const OTHER = "agent-c";
const SEED = Buffer.alloc(32, 0x57);
const OTHER_SEED = Buffer.alloc(32, 0x58);
const CHILD = fileURLToPath(new URL("./helpers/mail-kill-child.mjs", import.meta.url));
const MODULE = new URL("../src/io/mail.ts", import.meta.url).href;

let mailDir: string;
let root: string;

const cur = (file: string) => join(root, "cur", file);
const fresh = (file: string) => join(root, "new", file);

/** A verifier that resolves the senders in `known` (default both). */
function verifier(known: string[] = [FROM, OTHER]): FlairClient {
  return {
    async getAgent(name: string) {
      if (!known.includes(name)) return null;
      return { publicKey: Buffer.from(ed.getPublicKey(name === FROM ? SEED : OTHER_SEED)) };
    },
  };
}

const client = (flair: FlairClient = verifier()) => new MailClient(mailDir, undefined, AGENT, flair);

beforeEach(() => {
  mailDir = mkdtempSync(join(tmpdir(), "mail-delivery-"));
  root = join(mailDir, AGENT);
  mkdirSync(join(root, "new"), { recursive: true });
  mkdirSync(join(root, "cur"), { recursive: true });
});

afterEach(() => rmSync(mailDir, { recursive: true, force: true }));

/** Write one signed record to `path`. */
function signedRecord(path: string, messageId: string, from = FROM, body = "delivery-body"): void {
  const timestamp = new Date().toISOString();
  const envelope = signEnvelope(
    {
      v: 1, from, to: AGENT, body, messageId, timestamp,
      delegationChain: [
        { agent: "system", kind: "human", timestamp, rationale: "originates", signature: null },
        { agent: from, kind: "agent", timestamp, rationale: "sends", signature: null },
      ],
    },
    { [from]: from === FROM ? SEED : OTHER_SEED },
  );
  writeFileSync(path, JSON.stringify({ from, body: JSON.stringify(envelope) }));
}

const plant = (file: string, messageId: string, from = FROM) => signedRecord(fresh(file), messageId, from);

const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []);
const newFiles = () => jsonFiles(join(root, "new"));
const curFiles = () => jsonFiles(join(root, "cur"));

const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const intentPath = (file: string) => join(root, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);
const intentText = (file: string) => textOf(intentPath(file));
const intentJson = (file: string) => JSON.parse(readFileSync(intentPath(file), "utf8"));
const intentPhase = (file: string) => mailboxReplayStore(root).placementPhase(file);

/** Rewrite the intent for `file` with `fields` merged in. */
function setPhase(fields: Record<string, unknown>, file = "m1.json"): Buffer {
  const path = intentPath(file);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...fields }));
  return readFileSync(path);
}

/** A committed message (linked into cur/, consumed) with the given intent fields. */
function committed(messageId: string, fields: Record<string, unknown>, file = "m1.json", from = FROM): Buffer {
  signedRecord(fresh(file), messageId, from);
  const replay = mailboxReplayStore(root);
  linkSync(fresh(file), cur(file));
  unlinkSync(fresh(file));
  replay.beginPlacement(messageId, file, cur(file));
  replay.recordConsumed(messageId);
  return setPhase(fields, file);
}

const quarantined = (file: string) => existsSync(`${intentPath(file)}.quarantined`);

/** The delivery, asserting the call handed one over. */
function delivered(result: DeliverNextResult): MailDelivery {
  if (result.status !== "delivered") throw new Error(`expected a delivery, got ${JSON.stringify(result)}`);
  return result.delivery;
}
const idOf = (result: DeliverNextResult) => (result.status === "delivered" ? result.delivery.message.verifiedEnvelope?.messageId : undefined);
const reasonOf = (result: DeliverNextResult) => (result.status === "deferred" ? result.reason : result.status);

describe("per-message delivery commits one message at a time", () => {
  test("keeps later mail in new/ while the first presentation is active", async () => {
    plant("m1.json", "id-1");
    plant("m2.json", "id-2");
    plant("m3.json", "id-3");

    const c = client();
    const first = delivered(await c.deliverNext());
    expect(first.message.verifiedEnvelope?.messageId).toBe("id-1");
    expect(first.presentation).toBe(1);
    expect(first.deliveryKey).toBe(JSON.stringify([realpathSync(root), "id-1"]));
    expect(curFiles()).toEqual(["m1.json"]);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    const again = await c.deliverNext();
    expect(reasonOf(again)).toBe("active");
    expect(intentJson("m1.json").presentations).toBe(1);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    const second = delivered(await c.deliverNext());
    expect(second.message.verifiedEnvelope?.messageId).toBe("id-1");
    expect(second.presentation).toBe(2);
    expect(second.deliveryKey).toBe(first.deliveryKey);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    expect(await c.completeDelivery(second)).toEqual({ status: "completed" });
    expect(intentPhase("m1.json")).toBeNull();

    const next = delivered(await c.deliverNext());
    expect(next.message.verifiedEnvelope?.messageId).toBe("id-2");
    expect(curFiles()).toEqual(["m1.json", "m2.json"]);
    expect(newFiles()).toEqual(["m3.json"]);
  });

  test("distinct mailbox roots produce distinct delivery keys for the same agent and message", async () => {
    plant("m1.json", "same-id");
    const otherDir = join(mailDir, "other-root");
    const otherRoot = join(otherDir, AGENT);
    mkdirSync(join(otherRoot, "new"), { recursive: true });
    mkdirSync(join(otherRoot, "cur"), { recursive: true });
    signedRecord(join(otherRoot, "new", "m1.json"), "same-id");
    const a = client();
    const b = new MailClient(otherDir, undefined, AGENT, verifier());
    const first = delivered(await a.deliverNext());
    const second = delivered(await b.deliverNext());
    expect(second.deliveryKey).toBe(JSON.stringify([realpathSync(otherRoot), "same-id"]));
    expect(second.deliveryKey).not.toBe(first.deliveryKey);
    expect(await a.completeDelivery(first)).toEqual({ status: "completed" });
    expect(await b.completeDelivery(second)).toEqual({ status: "completed" });
  });

  test("completion is idempotent and stops re-presentation", async () => {
    plant("m1.json", "solo");
    const c = client();
    const m = delivered(await c.deliverNext());
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
    expect(await c.completeDelivery(m)).toEqual({ status: "already-completed" });
    expect(await c.deliverNext()).toEqual({ status: "idle" });
  });

  test("a call that listed nothing pending re-checks under the commit lock and does not put a second message in flight", async () => {
    plant("m1.json", "race-1");
    plant("m2.json", "race-2");
    // B lists (nothing pending) and starts verifying m1; A then commits m1 in full.
    let releaseB!: () => void;
    const gate = new Promise<void>((resolve) => { releaseB = resolve; });
    let bCalls = 0;
    const b = client({
      async getAgent(name: string) {
        if (bCalls++ === 0) await gate;
        return verifier().getAgent(name);
      },
    });
    const pendingB = b.deliverNext();
    while (bCalls === 0) await new Promise((r) => setTimeout(r, 5));
    const a = await client().deliverNext();
    expect(idOf(a)).toBe("race-1");
    releaseB();
    const resultB = await pendingB;
    expect(resultB).toMatchObject({ status: "deferred", reason: "new-mail-deferred", file: "m2.json" });
    expect(curFiles()).toEqual(["m1.json"]);
    expect(newFiles()).toEqual(["m2.json"]);
    expect(pendingPlacementEntries(root).map((e) => e.messageId)).toEqual(["race-1"]);
  });
});

describe("persisted delivery release", () => {
  test("another client defers before release, then retries and delivers later mail", async () => {
    plant("m1.json", "released");
    plant("m2.json", "later");
    const a = client();
    const b = client();
    const first = delivered(await a.deliverNext());
    const claim = intentJson("m1.json").claim;
    setPhase({ claim: { ...claim, moduleNonce: randomUUID() } });
    const before = intentJson("m1.json");
    expect(reasonOf(await b.deliverNext())).toBe("active");
    expect(newFiles()).toEqual(["m2.json"]);
    expect(a.releaseDelivery(first)).toEqual({ status: "released" });
    const { claim: _claim, ...unclaimed } = before;
    expect(intentJson("m1.json")).toEqual(unclaimed);
    const retry = delivered(await b.deliverNext());
    expect(retry.message.verifiedEnvelope?.messageId).toBe("released");
    expect(retry.presentation).toBe(2);
    expect(await b.completeDelivery(retry)).toEqual({ status: "completed" });
    expect(idOf(await b.deliverNext())).toBe("later");
  });

  test("a foreign claim at the presentation limit blocks later mail until released", async () => {
    plant("m1.json", "at-limit");
    plant("m2.json", "later");
    const a = client();
    const first = delivered(await a.deliverNext());
    const claim = intentJson("m1.json").claim;
    setPhase({
      claim: { ...claim, moduleNonce: randomUUID() },
      presentations: MAX_DELIVERY_PRESENTATIONS,
    });
    const b = client();
    expect(reasonOf(await b.deliverNext())).toBe("active");
    expect(a.releaseDelivery(first)).toEqual({ status: "released" });
    expect(idOf(await b.deliverNext())).toBe("later");
    expect(intentPhase("m1.json")).toBe("failed");
  });

  test("release refuses a replaced token without changing the intent", async () => {
    plant("m1.json", "replaced-token");
    const c = client();
    const first = delivered(await c.deliverNext());
    const claim = intentJson("m1.json").claim;
    setPhase({ claim: { ...claim, token: randomUUID() } });
    const before = intentText("m1.json");
    expect(c.releaseDelivery(first)).toEqual({ status: "refused", reason: "stale" });
    expect(client().releaseDelivery(first)).toEqual({ status: "refused", reason: "foreign" });
    expect(c.releaseDelivery({ ...first })).toEqual({ status: "refused", reason: "foreign" });
    expect(intentText("m1.json")).toBe(before);
  });

  test("lock contention defers release and permits a retry", async () => {
    plant("m1.json", "release-busy");
    const c = client();
    const first = delivered(await c.deliverNext());
    const before = intentText("m1.json");
    const claimDir = join(root, ".mail-lock.claim");
    mkdirSync(claimDir);
    try {
      expect(c.releaseDelivery(first)).toMatchObject({ status: "deferred", reason: "lock-busy" });
      expect(intentText("m1.json")).toBe(before);
    } finally { rmSync(claimDir, { recursive: true }); }
    expect(reasonOf(await client().deliverNext())).toBe("active");
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    expect(c.releaseDelivery(first)).toEqual({ status: "refused", reason: "stale" });
  });

  test("a phase-write error defers release and retains the claim for retry", async () => {
    plant("m1.json", "release-error");
    const c = client();
    const first = delivered(await c.deliverNext());
    const before = intentText("m1.json");
    const realOpen = fs.openSync;
    const stub = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(path).endsWith(".phase.tmp")) throw new Error("release write failed");
      return realOpen(path, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(c.releaseDelivery(first)).toMatchObject({ status: "deferred", reason: "storage-error" });
      expect(intentText("m1.json")).toBe(before);
      expect(existsSync(join(root, ".mail-lock"))).toBe(false);
    } finally { stub.mockRestore(); }
    expect(reasonOf(await client().deliverNext())).toBe("active");
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    expect(delivered(await client().deliverNext()).presentation).toBe(2);
  });
});

describe("in_progress re-presentation in recovery", () => {
  test("a foreign module nonce in the same process defers re-presentation", async () => {
    plant("m1.json", "foreign-module");
    const c = client();
    const first = delivered(await c.deliverNext());
    const claim = intentJson("m1.json").claim;
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    setPhase({ claim: { ...claim, moduleNonce: randomUUID() } });
    const before = intentText("m1.json");

    for (let i = 0; i < MAX_DELIVERY_PRESENTATIONS * 2; i++) {
      expect(reasonOf(await client().deliverNext())).toBe("active");
    }
    expect(intentText("m1.json")).toBe(before);
    expect(mailboxReplayStore(root).placementState("m1.json")?.claim?.moduleNonce).not.toBe(claim.moduleNonce);
    setPhase({ claim });
    expect(delivered(await client().deliverNext()).presentation).toBe(2);
  });

  test("a claimed intent without firstPresentedAt is rejected at parse and quarantined", async () => {
    plant("m1.json", "missing-time");
    const c = client();
    const first = delivered(await c.deliverNext());
    const claim = intentJson("m1.json").claim;
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    setPhase({ claim: { ...claim, moduleNonce: randomUUID() }, firstPresentedAt: undefined });
    expect(() => mailboxReplayStore(root).placementState("m1.json")).toThrow("malformed placement intent");
    expect(quarantined("m1.json")).toBe(true);
    expect(existsSync(intentPath("m1.json"))).toBe(false);
    expect(await c.deliverNext()).toEqual({ status: "idle" });
    expect(await c.completeDelivery(first)).toMatchObject({
      status: "deferred", reason: "storage-error",
      detail: "quarantined placement intent needs repair before a retry can complete",
    });
    expect(curFiles()).toEqual(["m1.json"]);
  });

  test("this module's nonce with no local token permits re-presentation", async () => {
    plant("m1.json", "released-module");
    const c = client();
    const first = delivered(await c.deliverNext());
    const claim = intentJson("m1.json").claim;
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    setPhase({ claim });

    const again = delivered(await client().deliverNext());
    expect(again.presentation).toBe(2);
    expect(intentJson("m1.json").claim.moduleNonce).toBe(claim.moduleNonce);
  });

  test("lease expiry releases a foreign module claim to the delivery deadline", async () => {
    plant("m1.json", "expired-module");
    plant("m2.json", "healthy");
    const c = client();
    const first = delivered(await c.deliverNext());
    const claim = intentJson("m1.json").claim;
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    setPhase({
      claim: { ...claim, moduleNonce: randomUUID() },
      firstPresentedAt: new Date(Date.now() - DELIVERY_PRESENTATION_TTL_MS - 1_000).toISOString(),
    });

    expect(idOf(await client().deliverNext())).toBe("healthy");
    expect(intentPhase("m1.json")).toBe("failed");
    expect(intentJson("m1.json").claim).toBeUndefined();
    expect(curFiles()).toContain("m1.json");
  });

  test("a real worker's held delivery defers repeated calls from this module copy", async () => {
    plant("probe.json", "own-module");
    const c = client();
    const first = delivered(await c.deliverNext());
    const own = intentJson("probe.json").claim;
    expect(await c.completeDelivery(first)).toEqual({ status: "completed" });
    plant("m1.json", "worker-held");
    plant("m2.json", "waiting");
    const worker = new Worker(new URL("./helpers/mail-delivery-worker.mjs", import.meta.url), {
      workerData: { mailDir, agent: AGENT, from: FROM, seed: SEED.toString("base64"), module: MODULE },
    });
    try {
      const result = await new Promise<DeliverNextResult>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`worker exited before handoff: ${code}`)));
      });
      expect(delivered(result).presentation).toBe(1);
      const claim = intentJson("m1.json").claim;
      expect(claim.pid).toBe(own.pid);
      expect(claim.start).toBe(own.start);
      expect(claim.moduleNonce).not.toBe(own.moduleNonce);
      const before = intentText("m1.json");
      for (let i = 0; i < MAX_DELIVERY_PRESENTATIONS * 2; i++) {
        expect(reasonOf(await c.deliverNext())).toBe("active");
      }
      expect(intentText("m1.json")).toBe(before);
      expect(newFiles()).toEqual(["m2.json"]);
      const completed = new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      worker.postMessage("complete");
      expect(await completed).toEqual({ status: "completed" });
      expect(idOf(await c.deliverNext())).toBe("waiting");
    } finally {
      await worker.terminate();
    }
  });

  test("another client in the module copy waits for a held token, then presents it again once released", async () => {
    plant("m1.json", "resume-in-progress");
    const a = client();
    const first = delivered(await a.deliverNext());
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(intentJson("m1.json").presentations).toBe(1);

    const b = client();
    expect(reasonOf(await b.deliverNext())).toBe("active");
    expect(intentJson("m1.json").presentations).toBe(1);

    expect(a.releaseDelivery(first)).toEqual({ status: "released" });
    const again = delivered(await b.deliverNext());
    expect(again.message.verifiedEnvelope?.messageId).toBe("resume-in-progress");
    expect(again.presentation).toBe(2);

    // The stale reader cannot finalize the current presentation.
    const before = intentText("m1.json");
    const stale = await a.completeDelivery(first);
    expect(stale.status).toBe("refused");
    if (stale.status === "refused") expect(stale.reason).toBe("stale");
    expect(intentText("m1.json")).toBe(before);

    expect(await b.completeDelivery(again)).toEqual({ status: "completed" });
    expect(await client().deliverNext()).toEqual({ status: "idle" });
  });

  test("recovers a verified placing fixture to in_progress", async () => {
    plant("m1.json", "resume-placing");
    const replay = mailboxReplayStore(root);
    linkSync(fresh("m1.json"), cur("m1.json"));
    replay.beginPlacement("resume-placing", "m1.json", cur("m1.json"));
    // No consumed id and no phase yet: a crash between the link and the phase write.

    const c = client();
    const m = delivered(await c.deliverNext());
    expect(m.message.verifiedEnvelope?.messageId).toBe("resume-placing");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(hasCommittedMessageId(root, "resume-placing")).toBe(true);

    expect(reasonOf(await c.deliverNext())).toBe("active");
    expect(c.releaseDelivery(m)).toEqual({ status: "released" });
    expect(idOf(await c.deliverNext())).toBe("resume-placing");
  });

  test("an in_progress intent written without a claim is presented again", async () => {
    committed("unclaimed", { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: new Date().toISOString() });
    const m = delivered(await client().deliverNext());
    expect(m.presentation).toBe(2);
    expect(intentJson("m1.json").claim.pid).toBe(process.pid);
  });
});

describe("reporting failures", () => {
  function failingEvents(): EventLogger {
    const eventDir = join(mailDir, "events");
    const events = new EventLogger(AGENT, eventDir);
    rmSync(eventDir, { recursive: true });
    writeFileSync(eventDir, "not a directory");
    expect(() => events.emit({ type: "mail.receive", status: "error" })).toThrow();
    return events;
  }

  test("a failed real event destination preserves a committed delivery", async () => {
    plant("m1.json", "logger-success");
    const events = failingEvents();
    const emit = spyOn(events, "emit");
    const c = new MailClient(mailDir, events, AGENT, verifier());
    try {
      const m = delivered(await c.deliverNext());
      expect(m.message.verifiedEnvelope?.messageId).toBe("logger-success");
      expect(hasCommittedMessageId(root, "logger-success")).toBe(true);
      expect(intentPhase("m1.json")).toBe("in_progress");
      expect(newFiles()).toEqual([]);
      expect(curFiles()).toEqual(["m1.json"]);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
      expect(reasonOf(await c.deliverNext())).toBe("active");
      expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
    } finally { emit.mockRestore(); }
  });

  test("a failed real event destination preserves rejection", async () => {
    writeFileSync(fresh("m1.json"), "{}");
    const events = failingEvents();
    const emit = spyOn(events, "emit");
    try {
      expect(await new MailClient(mailDir, events, AGENT, verifier()).deliverNext()).toEqual({ status: "idle" });
      expect(newFiles()).toEqual([]);
      expect(curFiles()).toEqual([]);
      expect(readFileSync(join(root, "dlq", "m1.json"), "utf8")).toBe("{}");
      expect(readFileSync(join(root, "dlq", "m1.json.reason"), "utf8")).toContain("class: invalid");
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
    } finally { emit.mockRestore(); }
  });

  for (const failSync of [false, true]) {
    test(`quarantine with a failed real event destination and directory sync failure=${failSync}`, async () => {
      writeFileSync(cur("m1.json"), "{}");
      const c = new MailClient(mailDir, failingEvents(), AGENT, verifier());
      mailboxReplayStore(root).beginPlacement("logger-quarantine", "m1.json", cur("m1.json"));
      const fsync = fs.fsyncSync;
      let boundaryReached = false;
      const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory() && !existsSync(intentPath("m1.json"))) {
          boundaryReached = true;
          expect(existsSync(cur("m1.json"))).toBe(false);
          expect(readFileSync(join(root, "dlq", "m1.json"), "utf8")).toBe("{}");
          if (failSync) throw new Error("quarantine directory sync failed");
        }
        fsync(fd);
      });
      try {
        const result = await c.deliverNext();
        expect(result).toMatchObject({ status: "deferred", reason: failSync ? "storage-error" : "pending-record-invalid" });
        if (failSync) expect(result).toMatchObject({ detail: "quarantine directory sync failed" });
        expect(boundaryReached).toBe(true);
        expect(existsSync(intentPath("m1.json"))).toBe(false);
        expect(readFileSync(join(root, "dlq", "m1.json.reason"), "utf8")).toContain("pending-record-invalid");
        const lock = await acquireMailLock(realpathSync(root));
        expect(lock).not.toBeNull();
        lock?.release();
      } finally { sync.mockRestore(); }
    });
  }

  test("a throwing warning preserves the failed-intent transition and later delivery", async () => {
    committed("expired", {
      version: 1, phase: "in_progress", presentations: 1,
      firstPresentedAt: new Date(Date.now() - DELIVERY_PRESENTATION_TTL_MS - 1).toISOString(),
    });
    plant("m2.json", "later");
    const warn = spyOn(console, "warn").mockImplementation(() => { throw new Error("warning failed"); });
    try {
      expect(idOf(await client().deliverNext())).toBe("later");
      expect(intentPhase("m1.json")).toBe("failed");
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test("a throwing error log preserves a rejection whose DLQ move failed", async () => {
    const c = new MailClient(mailDir, failingEvents(), AGENT, verifier());
    writeFileSync(fresh("m1.json"), "{}");
    mkdirSync(join(root, "dlq", "m1.json"));
    const error = spyOn(console, "error").mockImplementation(() => { throw new Error("error log failed"); });
    try {
      expect(await c.deliverNext()).toEqual({ status: "idle" });
      expect(newFiles()).toEqual(["m1.json"]);
      expect(error).toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
});

describe("completion is bound to the hand-over", () => {
  test("a failed real event destination cannot reject a placement-error deferral", async () => {
    plant("m1.json", "logger-error");
    const eventDir = join(mailDir, "events");
    const events = new EventLogger(AGENT, eventDir);
    const c = new MailClient(mailDir, events, AGENT, verifier());
    const m = delivered(await c.deliverNext());
    const before = readFileSync(intentPath("m1.json"));
    rmSync(eventDir, { recursive: true });
    writeFileSync(eventDir, "not a directory");
    expect(() => events.emit({ type: "mail.receive", status: "error" })).toThrow();
    unlinkSync(intentPath("m1.json"));
    mkdirSync(intentPath("m1.json"));
    try {
      expect(await c.completeDelivery(m)).toMatchObject({ status: "deferred", reason: "storage-error" });
      const lock = await acquireMailLock(realpathSync(root));
      expect(lock).not.toBeNull();
      lock?.release();
    } finally {
      rmSync(intentPath("m1.json"), { recursive: true });
      writeFileSync(intentPath("m1.json"), before);
    }
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
  });

  test("directory-sync failure after unlink reports uncertain durability", async () => {
    plant("m1.json", "sync-error");
    const c = client();
    const m = delivered(await c.deliverNext());
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("sync failed"); });
    try {
      expect(await c.completeDelivery(m)).toEqual({
        status: "deferred", reason: "storage-error",
        detail: "intent unlinked; directory sync failed, durability uncertain",
      });
      expect(existsSync(intentPath("m1.json"))).toBe(false);
      const lock = await acquireMailLock(realpathSync(root));
      expect(lock).not.toBeNull();
      lock?.release();
    } finally {
      sync.mockRestore();
    }
    expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "stale" });
  });

  for (const failure of ["unreadable", "malformed"] as const) {
    test(`${failure} intent defers completion with storage-error and retains the token`, async () => {
      plant("m1.json", "intent-error");
      const events = new EventLogger(AGENT, join(mailDir, "events"));
      const emit = spyOn(events, "emit");
      const c = new MailClient(mailDir, events, AGENT, verifier());
      const m = delivered(await c.deliverNext());
      const before = readFileSync(intentPath("m1.json"), "utf8");
      unlinkSync(intentPath("m1.json"));
      if (failure === "unreadable") mkdirSync(intentPath("m1.json"));
      else writeFileSync(intentPath("m1.json"), "{");
      try {
        const result = await c.completeDelivery(m);
        expect(result).toMatchObject({ status: "deferred", reason: "storage-error" });
        if (failure === "malformed") {
          expect(result).toMatchObject({ detail: "quarantined placement intent needs repair before a retry can complete" });
          expect(quarantined("m1.json")).toBe(true);
          expect(existsSync(intentPath("m1.json"))).toBe(false);
          expect(await c.completeDelivery(m)).toEqual(result);
        }
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
          type: "mail.receive", agent: AGENT, status: "error", from: "unknown", durationMs: 0,
          error: expect.any(String),
        }));
        const lock = await acquireMailLock(realpathSync(root));
        expect(lock).not.toBeNull();
        lock?.release();
      } finally {
        emit.mockRestore();
        rmSync(intentPath("m1.json"), { recursive: true, force: true });
        rmSync(`${intentPath("m1.json")}.quarantined`, { force: true });
        writeFileSync(intentPath("m1.json"), before);
      }
      expect(reasonOf(await client().deliverNext())).toBe("active");
      expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
    });
  }

  test("intent unlink failure defers completion with storage-error and retains the token", async () => {
    plant("m1.json", "unlink-error");
    const events = new EventLogger(AGENT, join(mailDir, "events"));
    const emit = spyOn(events, "emit");
    const c = new MailClient(mailDir, events, AGENT, verifier());
    const m = delivered(await c.deliverNext());
    const before = intentText("m1.json");
    const original = fs.unlinkSync;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path) === intentPath("m1.json")) throw new Error("intent unlink unavailable");
      return original(path);
    });
    try {
      expect(await c.completeDelivery(m)).toMatchObject({ status: "deferred", reason: "storage-error" });
      expect(emit).toHaveBeenLastCalledWith({
        type: "mail.receive", agent: AGENT, status: "error", from: "unknown", durationMs: 0,
        error: "intent unlink unavailable",
      });
      expect(intentText("m1.json")).toBe(before);
      const lock = await acquireMailLock(realpathSync(root));
      expect(lock).not.toBeNull();
      lock?.release();
    } finally {
      unlink.mockRestore();
      emit.mockRestore();
    }
    expect(reasonOf(await client().deliverNext())).toBe("active");
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
  });

  test("a delivery another client issued, or a copied one, is refused as foreign and changes nothing", async () => {
    plant("m1.json", "bound");
    const owner = client();
    const m = delivered(await owner.deliverNext());
    const before = intentText("m1.json");

    const other = client();
    const foreign = await other.completeDelivery(m);
    expect(foreign).toMatchObject({ status: "refused", reason: "foreign" });
    const copied = await owner.completeDelivery({ ...m });
    expect(copied).toMatchObject({ status: "refused", reason: "foreign" });
    expect(intentText("m1.json")).toBe(before);

    expect(await owner.completeDelivery(m)).toEqual({ status: "completed" });
  });

  test("a delivery whose claim was replaced on disk is refused as stale", async () => {
    plant("m1.json", "replaced-claim");
    const c = client();
    const m = delivered(await c.deliverNext());
    const claim = intentJson("m1.json").claim;
    setPhase({ claim: { ...claim, token: randomUUID() } });
    const before = intentText("m1.json");
    expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "stale" });
    expect(intentText("m1.json")).toBe(before);
  });

  test("a cur/ copy replaced by another file is refused as identity and keeps the intent", async () => {
    plant("m1.json", "replaced-file");
    const c = client();
    const m = delivered(await c.deliverNext());
    const bytes = readFileSync(cur("m1.json"));
    unlinkSync(cur("m1.json"));
    writeFileSync(cur("m1.json"), Buffer.concat([bytes, Buffer.from(" ")]));
    const before = intentText("m1.json");
    expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "identity" });
    expect(intentText("m1.json")).toBe(before);
  });

  for (const field of ["ino", "size"] as const) {
    test(`a cur/ copy with changed ${field} is refused as identity`, async () => {
      plant("m1.json", "changed-identity");
      const c = client();
      const m = delivered(await c.deliverNext());
      const before = intentText("m1.json");
      const stat = fs.lstatSync(cur("m1.json"), { bigint: true });
      expect(intentJson("m1.json").identity).toEqual({
        dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
        sha256: createHash("sha256").update(readFileSync(cur("m1.json"))).digest("hex"),
      });
      const realStat = fs.lstatSync;
      const replacement = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { [field]: stat[field] + 1n });
      const stub = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options: unknown) =>
        path === cur("m1.json") ? replacement : realStat(path, options as { bigint: true })) as typeof fs.lstatSync);
      try {
        expect(mailboxReplayStore(root).ownsPendingPlacement("changed-identity", "m1.json")).toBe(false);
        expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "identity" });
        expect(intentText("m1.json")).toBe(before);
        expect(c.releaseDelivery(m)).toEqual({ status: "refused", reason: "stale" });
        expect(await c.deliverNext()).toMatchObject({ status: "deferred", reason: "record-changed" });
        expect(intentText("m1.json")).toBe(before);
      } finally { stub.mockRestore(); }
    });
  }

  test("inode reuse with different same-size bytes is refused as identity", async () => {
    plant("m1.json", "reused-inode");
    const c = client();
    const m = delivered(await c.deliverNext());
    const before = intentText("m1.json");
    const recorded = intentJson("m1.json").identity;
    const bytes = readFileSync(cur("m1.json"), "utf8");
    unlinkSync(cur("m1.json"));
    writeFileSync(cur("m1.json"), bytes.replace("delivery-body", "different-msg"));
    const realStat = fs.lstatSync;
    const stat = realStat(cur("m1.json"), { bigint: true });
    expect(String(stat.size)).toBe(recorded.size);
    const replacement = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: BigInt(recorded.ino) });
    const stub = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options: unknown) =>
      path === cur("m1.json") ? replacement : realStat(path, options as { bigint: true })) as typeof fs.lstatSync);
    try {
      expect(mailboxReplayStore(root).ownsPendingPlacement("reused-inode", "m1.json")).toBe(false);
      expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "identity" });
      expect(intentText("m1.json")).toBe(before);
    } finally { stub.mockRestore(); }
  });

  test("the same inode and bytes remain the same message after link changes and a rewrite", async () => {
    plant("m1.json", "same-message");
    const c = client();
    const m = delivered(await c.deliverNext());
    const bytes = readFileSync(cur("m1.json"));
    linkSync(cur("m1.json"), fresh("linked.json"));
    unlinkSync(fresh("linked.json"));
    writeFileSync(cur("m1.json"), bytes);
    expect(mailboxReplayStore(root).ownsPendingPlacement("same-message", "m1.json")).toBe(true);
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
  });

  test("an identity without a byte hash is refused and keeps the intent", async () => {
    plant("m1.json", "legacy-identity");
    const c = client();
    const m = delivered(await c.deliverNext());
    const { dev, ino, size } = intentJson("m1.json").identity;
    setPhase({ identity: { dev, ino, size, ctimeNs: String(fs.lstatSync(cur("m1.json"), { bigint: true }).ctimeNs) } });
    const before = intentText("m1.json");
    expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "identity" });
    expect(intentText("m1.json")).toBe(before);
  });

  test("a held local token defers re-presentation without increasing its count", async () => {
    plant("m1.json", "long-handler");
    plant("m2.json", "waiting");
    const c = client();
    const m = delivered(await c.deliverNext());
    for (let i = 0; i < MAX_DELIVERY_PRESENTATIONS * 2; i++) {
      expect(reasonOf(await c.deliverNext())).toBe("active");
    }
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(intentJson("m1.json").presentations).toBe(1);
    expect(newFiles()).toEqual(["m2.json"]);
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
  });

  test("completion and delivery resolve the retargeted mail root", async () => {
    const rootA = join(mailDir, "rootA");
    const rootB = join(mailDir, "rootB");
    for (const r of [rootA, rootB]) mkdirSync(join(r, AGENT, "new"), { recursive: true });
    const link = join(mailDir, "mail-link");
    symlinkSync(rootA, link);
    root = join(rootA, AGENT);
    plant("m1.json", "pinned-1");
    plant("m2.json", "pinned-2");
    // rootB holds the same file name for the same message under another claim.
    root = join(rootB, AGENT);
    mkdirSync(join(root, "cur"), { recursive: true });
    committed("pinned-1", {
      version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: new Date().toISOString(),
      claim: { token: randomUUID(), pid: process.pid, start: null, moduleNonce: randomUUID() },
    });
    const rootBIntent = intentText("m1.json");
    plant("m9.json", "other-root");

    const c = new MailClient(link, undefined, AGENT, verifier());
    root = join(rootA, AGENT);
    const m = delivered(await c.deliverNext());
    expect(m.message.verifiedEnvelope?.messageId).toBe("pinned-1");

    unlinkSync(link);
    symlinkSync(rootB, link);
    expect(realpathSync(join(link, AGENT))).toBe(realpathSync(join(rootB, AGENT)));

    const rootAIntent = intentText("m1.json");
    expect(await c.completeDelivery(m)).toMatchObject({ status: "refused", reason: "stale" });
    expect(intentText("m1.json")).toBe(rootAIntent);
    expect(newFiles()).toEqual(["m2.json"]);

    root = join(rootB, AGENT);
    expect(intentText("m1.json")).toBe(rootBIntent);
    expect(reasonOf(await c.deliverNext())).toBe("active");
    setPhase({ claim: undefined });
    const resumed = delivered(await c.deliverNext());
    expect(resumed.message.verifiedEnvelope?.messageId).toBe("pinned-1");
    expect(resumed.presentation).toBe(2);
    expect(await c.completeDelivery(resumed)).toEqual({ status: "completed" });
    const next = delivered(await c.deliverNext());
    expect(next.message.verifiedEnvelope?.messageId).toBe("other-root");
    expect(newFiles()).toEqual([]);
  });

  test("completion reports no matching live intent and claim after retargeting to an empty mailbox", async () => {
    const empty = join(mailDir, "empty");
    mkdirSync(join(empty, AGENT, "new"), { recursive: true });
    mkdirSync(join(empty, AGENT, "cur"), { recursive: true });
    const link = join(mailDir, "mail-link");
    symlinkSync(mailDir, link);
    plant("m1.json", "retargeted-empty");
    const c = new MailClient(link, undefined, AGENT, verifier());
    const m = delivered(await c.deliverNext());
    const before = intentText("m1.json");
    expect(intentPhase("m1.json")).toBe("in_progress");

    unlinkSync(link);
    symlinkSync(empty, link);
    expect(await c.completeDelivery(m)).toEqual({
      status: "refused",
      reason: "stale",
      detail: "message retargeted-empty: no matching live intent and claim in the currently resolved mailbox",
    });
    expect(intentText("m1.json")).toBe(before);
    expect(mailboxReplayStore(join(empty, AGENT)).placementPhase("m1.json")).toBeNull();
  });

  test("release persists under the issued mailbox lock after a mail-root repoint", async () => {
    const other = join(mailDir, "other");
    mkdirSync(other);
    const link = join(mailDir, "mail-link");
    symlinkSync(mailDir, link);
    plant("m1.json", "released-root");
    const c = new MailClient(link, undefined, AGENT, verifier());
    const first = delivered(await c.deliverNext());
    unlinkSync(link);
    symlinkSync(other, link);
    const before = intentJson("m1.json");
    const originalRoot = root;
    root = join(other, AGENT);
    mkdirSync(join(root, "cur"), { recursive: true });
    mkdirSync(join(root, "new"), { recursive: true });
    committed("released-root", {
      version: 1, phase: "in_progress", presentations: 1,
      firstPresentedAt: before.firstPresentedAt, claim: before.claim,
    });
    const otherIntent = intentText("m1.json");
    const otherIntentPath = intentPath("m1.json");
    root = originalRoot;
    const claimDir = join(root, ".mail-lock.claim");
    mkdirSync(claimDir);
    try {
      expect(c.releaseDelivery(first)).toMatchObject({ status: "deferred", reason: "lock-busy" });
      expect(intentJson("m1.json")).toEqual(before);
    } finally { rmSync(claimDir, { recursive: true }); }
    expect(c.releaseDelivery(first)).toEqual({ status: "released" });
    const { claim: _claim, ...unclaimed } = before;
    expect(intentJson("m1.json")).toEqual(unclaimed);
    expect(readFileSync(otherIntentPath, "utf8")).toBe(otherIntent);
    rmSync(other, { recursive: true });
    mkdirSync(other);
    expect(await c.deliverNext()).toEqual({ status: "idle" });
    unlinkSync(link);
    symlinkSync(mailDir, link);
    const retry = delivered(await c.deliverNext());
    expect(retry.message.verifiedEnvelope?.messageId).toBe("released-root");
    expect(retry.presentation).toBe(2);
    expect(await c.completeDelivery(retry)).toEqual({ status: "completed" });
  });

  test("unavailable operation roots defer delivery and completion", async () => {
    const link = join(mailDir, "mail-link");
    symlinkSync(mailDir, link);
    plant("m1.json", "unavailable-root");
    const events = new EventLogger(AGENT, join(mailDir, "events"));
    const emit = spyOn(events, "emit");
    const c = new MailClient(link, events, AGENT, verifier());
    const first = delivered(await c.deliverNext());
    const before = intentText("m1.json");
    unlinkSync(link);
    writeFileSync(link, "not a directory");
    try {
      expect(await c.deliverNext()).toMatchObject({ status: "deferred", reason: "storage-error" });
      emit.mockClear();
      expect(await c.completeDelivery(first)).toMatchObject({ status: "deferred", reason: "storage-error" });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "mail.receive", agent: AGENT, status: "error", from: "unknown", durationMs: 0,
        error: expect.any(String),
      }));
      expect(intentText("m1.json")).toBe(before);
    } finally {
      emit.mockRestore();
      unlinkSync(link);
      symlinkSync(mailDir, link);
    }
    expect(reasonOf(await client().deliverNext())).toBe("active");
    expect(await c.completeDelivery(first)).toEqual({ status: "completed" });
  });

  for (const phase of ["new", "placing", "in_progress"] as const) {
    test(`${phase} delivery keeps its operation roots during verification`, async () => {
      const other = join(mailDir, "other");
      mkdirSync(other);
      const link = join(mailDir, "mail-link");
      symlinkSync(mailDir, link);
      mkdirSync(join(mailDir, ".bridge-principals"));
      writeFileSync(join(mailDir, ".bridge-principals", `${FROM}.json`), JSON.stringify({ id: FROM }));
      if (phase === "new") plant("m1.json", "operation-root");
      else committed("operation-root", { phase });
      const c = new MailClient(link, undefined, AGENT, {
        async getAgent(name: string) {
          unlinkSync(link);
          symlinkSync(other, link);
          return verifier().getAgent(name);
        },
      });
      const first = delivered(await c.deliverNext());
      expect(first.message.verifiedEnvelope?.messageId).toBe("operation-root");
      expect(first.message.trustTier).toBe("external");
      expect(intentPhase("m1.json")).toBe("in_progress");
      expect(existsSync(join(other, AGENT, "cur", "m1.json"))).toBe(false);
      unlinkSync(link);
      symlinkSync(mailDir, link);
      expect(await c.completeDelivery(first)).toEqual({ status: "completed" });
    });
  }
});

describe("deliverNext defers pending cur-copy failures before committing new mail", () => {
  test("a failed pending verification defers; a later valid message is not committed", async () => {
    plant("m1.json", "will-not-verify");
    const first = client();
    expect(first.releaseDelivery(delivered(await first.deliverNext()))).toEqual({ status: "released" });
    plant("m2.json", "later-valid", OTHER);

    // FROM is no longer resolvable: m1's cur/ copy fails re-verification.
    const c = client(verifier([OTHER]));
    for (let i = 0; i < 3; i++) {
      const result = await c.deliverNext();
      expect(reasonOf(result)).toBe("verification-failed");
      if (result.status === "deferred") expect(result.file).toBe("m1.json");
    }
    expect(newFiles()).toEqual(["m2.json"]);
    expect(hasCommittedMessageId(root, "later-valid")).toBe(false);
    expect(intentPhase("m2.json")).toBeNull();
    expect(intentJson("m1.json").presentations).toBe(1); // not presented, not counted
  });

  test("an unavailable verifier defers the pending message; a later message is not committed", async () => {
    plant("m1.json", "verifier-down");
    const first = client();
    expect(first.releaseDelivery(delivered(await first.deliverNext()))).toEqual({ status: "released" });
    plant("m2.json", "later");
    const down = client({ async getAgent() { throw new Error("flair unreachable"); } });
    expect(reasonOf(await down.deliverNext())).toBe("verification-unavailable");
    expect(newFiles()).toEqual(["m2.json"]);
    expect(hasCommittedMessageId(root, "later")).toBe(false);
  });

  test("a placing intent naming a CLI-promoted record defers by name and is left untouched", async () => {
    plant("m1.json", "cli-shaped");
    const wrapper = JSON.parse(readFileSync(fresh("m1.json"), "utf8"));
    const envelope = JSON.parse(wrapper.body);
    writeFileSync(fresh("m1.json"), JSON.stringify({
      id: "rec-1", from: FROM, to: AGENT, body: envelope.body, timestamp: envelope.timestamp, read: false,
      envelopeId: "cli-shaped", envelope, trustTier: "internal", checkedOutAt: new Date().toISOString(),
      checkedOutBy: AGENT, deliveryAttempts: 1,
    }));
    const replay = mailboxReplayStore(root);
    linkSync(fresh("m1.json"), cur("m1.json"));
    unlinkSync(fresh("m1.json"));
    replay.beginPlacement("cli-shaped", "m1.json", cur("m1.json"));
    replay.recordConsumed("cli-shaped");
    const intentBefore = intentText("m1.json");
    const recordBefore = textOf(cur("m1.json"));
    plant("m2.json", "after-cli");

    const result = await client().deliverNext();
    expect(result).toMatchObject({ status: "deferred", reason: "cli-record", file: "m1.json" });
    expect(intentText("m1.json")).toBe(intentBefore);
    expect(textOf(cur("m1.json"))).toBe(recordBefore);
    expect(newFiles()).toEqual(["m2.json"]);
    expect(hasCommittedMessageId(root, "after-cli")).toBe(false);
  });

  test("a busy mailbox lock defers; nothing is committed", async () => {
    plant("m1.json", "locked-out");
    const lock = await acquireMailLock(realpathSync(root));
    try {
      expect(reasonOf(await client().deliverNext())).toBe("lock-busy");
      expect(newFiles()).toEqual(["m1.json"]);
    } finally {
      lock?.release();
    }
    expect(idOf(await client().deliverNext())).toBe("locked-out");
  });

  test("new mail that cannot be verified now is deferred, not idle, and stays in new/", async () => {
    plant("m1.json", "unverifiable-now");
    const down = client({ async getAgent() { throw new Error("flair unreachable"); } });
    expect(reasonOf(await down.deliverNext())).toBe("new-mail-deferred");
    expect(newFiles()).toEqual(["m1.json"]);
  });
});

describe("liveness-bound transitions for unclaimed in_progress work", () => {
  const FAILED_AT = `not completed after ${MAX_DELIVERY_PRESENTATIONS} presentation(s)`;

  test("a request for a sixth presentation fails the intent, logs, and leaves other mail flowing", async () => {
    plant("m1.json", "poison");
    plant("m2.json", "healthy");
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    try {
      const c = client();
      for (let i = 1; i <= MAX_DELIVERY_PRESENTATIONS; i++) {
        const m = delivered(await c.deliverNext());
        expect(m.message.verifiedEnvelope?.messageId).toBe("poison");
        expect(m.presentation).toBe(i);
        expect(c.releaseDelivery(m)).toEqual({ status: "released" });
      }
      // The next hand-over would exceed the bound: poison is not presented, its
      // intent becomes terminal `failed`, and the next message flows.
      expect(idOf(await c.deliverNext())).toBe("healthy");
    } finally { warn.mockRestore(); }

    expect(warnings.some((w) => w.includes("poison") && w.includes(FAILED_AT))).toBe(true);
    expect(intentPhase("m1.json")).toBe("failed");
    expect(intentJson("m1.json").claim).toBeUndefined();
    expect(textOf(cur("m1.json"))).not.toBeNull();
    expect(pendingPlacementEntries(root).map((e) => e.messageId)).toEqual(["healthy"]);
    expect(mailboxReplayStore(root).hasPendingFile("m1.json")).toBe(false);
    expect(hasCommittedMessageId(root, "poison")).toBe(true);
  });

  test("an unclaimed in_progress message past the deadline is quarantined on the next call", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    committed("stale", { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: stale });
    plant("m2.json", "healthy");

    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    let next: DeliverNextResult;
    try { next = await client().deliverNext(); } finally { warn.mockRestore(); }

    expect(idOf(next)).toBe("healthy");
    expect(intentPhase("m1.json")).toBe("failed");
    expect(warnings.some((w) => w.includes("stale") && w.includes("deadline"))).toBe(true);
  });

  test("the exceeded deadline fails the intent even when the pending copy no longer re-verifies", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    committed("stale-unverifiable", { version: 1, phase: "in_progress", presentations: 2, firstPresentedAt: stale });
    plant("m2.json", "healthy", OTHER);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let next: DeliverNextResult;
    try { next = await client(verifier([OTHER])).deliverNext(); } finally { warn.mockRestore(); }
    expect(intentPhase("m1.json")).toBe("failed");
    expect(idOf(next)).toBe("healthy");
  });

  test("a held local token defers expiry past the deadline", async () => {
    plant("m1.json", "slow-but-live");
    const c = client();
    const m = delivered(await c.deliverNext());
    setPhase({ firstPresentedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    expect(reasonOf(await c.deliverNext())).toBe("active");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
  });

  test("the terminal intent keeps its message refused by the replay gate", async () => {
    committed("poisoned", { version: 1, phase: "failed", presentations: 5, firstPresentedAt: new Date().toISOString() });
    expect(intentPhase("m1.json")).toBe("failed");
    // Same signed envelope under the same (free) name: refused at commit as a replay.
    writeFileSync(fresh("m1.json"), readFileSync(cur("m1.json")));
    expect(await client().deliverNext()).toEqual({ status: "idle" });
    expect(textOf(join(root, "dlq", "m1.json.reason")) ?? "").toContain("class: replay");
    expect(intentJson("m1.json").phase).toBe("failed");
  });
});

describe("an unknown phase is preserved", () => {
  test("not presented, not finalized and not quarantined for its value; its file gate stays closed; other mail flows", async () => {
    const bytes = committed("kept-unknown", { version: 1, phase: "awaiting-review" });
    plant("m2.json", "flows");
    expect(idOf(await client().deliverNext())).toBe("flows");
    expect(intentText("m1.json") ?? "").toBe(bytes.toString("utf8"));
    expect(quarantined("m1.json")).toBe(false);
    expect(mailboxReplayStore(root).hasPendingFile("m1.json")).toBe(true);
    expect(hasCommittedMessageId(root, "kept-unknown")).toBe(true);
  });

  test("a malformed claim, or a claim on a placing intent, resolves to unknown", async () => {
    const base = { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: new Date().toISOString() };
    committed("bad-claim", { ...base, claim: { token: "not-a-uuid", pid: process.pid, start: null, moduleNonce: randomUUID() } });
    expect(intentPhase("m1.json")).toBe("unknown");
    committed("placing-claim", { phase: "placing", claim: { token: randomUUID(), pid: process.pid, start: null, moduleNonce: randomUUID() } }, "m2.json");
    expect(intentPhase("m2.json")).toBe("unknown");
    expect(await client().deliverNext()).toEqual({ status: "idle" });
  });
});

interface KillRun { signal: NodeJS.Signals | null; reached: boolean; stderr: string; }

/** Run deliverNext() in a child; SIGKILL it once it pauses at `killAt` (or `onPause` resolves). */
function runAndKillAt(killAt: string, file: string, after = false, onPause?: () => Promise<void>, timeoutMs = 20_000): Promise<KillRun> {
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
    const poll = setInterval(() => {
      if (!existsSync(marker)) return;
      clearInterval(poll);
      (onPause ? onPause() : Promise.resolve()).finally(() => child.kill("SIGKILL"));
    }, 15);
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
      const m = delivered(await c.deliverNext());
      expect(m.message.verifiedEnvelope?.messageId).toBe(`kill-${at}`);
      expect(newFiles()).toContain("m2.json");

      expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
      expect(idOf(await c.deliverNext())).toBe("later");
    });
  }

  test("killed after the intent becomes in_progress: the next call presents it again and later mail waits", async () => {
    plant("m1.json", "after-in-progress");
    plant("m2.json", "later");

    const run = await runAndKillAt("phase-write", "m1.json", true);
    expect(run.reached, `child never reached the phase write; stderr=${run.stderr}`).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(intentPhase("m1.json")).toBe("in_progress");

    const c = client();
    const m = delivered(await c.deliverNext());
    expect(m.message.verifiedEnvelope?.messageId).toBe("after-in-progress");
    expect(m.presentation).toBe(2);
    expect(newFiles()).toContain("m2.json");
  });

  test("a foreign claim defers until its process is killed, then permits re-presentation", async () => {
    plant("m1.json", "held-by-child");
    plant("m2.json", "later");
    let whileAlive: DeliverNextResult | undefined;
    const run = await runAndKillAt("after-delivery", "m1.json", false, async () => {
      whileAlive = await client().deliverNext();
    });
    expect(run.reached, `child never delivered; stderr=${run.stderr}`).toBe(true);
    expect(run.signal).toBe("SIGKILL");
    expect(whileAlive && reasonOf(whileAlive)).toBe("active");
    expect(intentJson("m1.json").presentations).toBe(1);
    expect(newFiles()).toEqual(["m2.json"]);

    const m = delivered(await client().deliverNext());
    expect(m.message.verifiedEnvelope?.messageId).toBe("held-by-child");
    expect(m.presentation).toBe(2);
  });
});
