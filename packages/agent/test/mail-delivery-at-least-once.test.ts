

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
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
import {
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
  replay.beginPlacement(messageId, file, fresh(file));
  linkSync(fresh(file), cur(file));
  unlinkSync(fresh(file));
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
    expect(first.deliveryKey).toBe(`${AGENT}/id-1`);
    expect(curFiles()).toEqual(["m1.json"]);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    const again = await c.deliverNext();
    expect(reasonOf(again)).toBe("active");
    expect(intentJson("m1.json").presentations).toBe(1);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    expect(c.releaseDelivery(first)).toBe(true);
    const second = delivered(await c.deliverNext());
    expect(second.message.verifiedEnvelope?.messageId).toBe("id-1");
    expect(second.presentation).toBe(2);
    expect(newFiles()).toEqual(["m2.json", "m3.json"]);

    expect(await c.completeDelivery(second)).toEqual({ status: "completed" });
    expect(intentPhase("m1.json")).toBeNull();

    const next = delivered(await c.deliverNext());
    expect(next.message.verifiedEnvelope?.messageId).toBe("id-2");
    expect(curFiles()).toEqual(["m1.json", "m2.json"]);
    expect(newFiles()).toEqual(["m3.json"]);
  });

  test("completion is idempotent and stops re-presentation; an empty mailbox is idle", async () => {
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

describe("in_progress re-presentation in recovery", () => {
  test("another client in the process waits for a held token, then presents it again once released", async () => {
    plant("m1.json", "resume-in-progress");
    const a = client();
    const first = delivered(await a.deliverNext());
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(intentJson("m1.json").presentations).toBe(1);

    const b = client();
    expect(reasonOf(await b.deliverNext())).toBe("active");
    expect(intentJson("m1.json").presentations).toBe(1);

    a.releaseDelivery(first);
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
    replay.beginPlacement("resume-placing", "m1.json", fresh("m1.json"));
    linkSync(fresh("m1.json"), cur("m1.json"));
    // No consumed id and no phase yet: a crash between the link and the phase write.

    const c = client();
    const m = delivered(await c.deliverNext());
    expect(m.message.verifiedEnvelope?.messageId).toBe("resume-placing");
    expect(intentPhase("m1.json")).toBe("in_progress");
    expect(hasCommittedMessageId(root, "resume-placing")).toBe(true);

    expect(reasonOf(await c.deliverNext())).toBe("active");
    c.releaseDelivery(m);
    expect(idOf(await c.deliverNext())).toBe("resume-placing");
  });

  test("an in_progress intent written without a claim is presented again", async () => {
    committed("unclaimed", { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: new Date().toISOString() });
    const m = delivered(await client().deliverNext());
    expect(m.presentation).toBe(2);
    expect(intentJson("m1.json").claim.pid).toBe(process.pid);
  });
});

describe("completion is bound to the hand-over", () => {
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
    writeFileSync(cur("m1.json"), bytes); // same name and bytes, another inode
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

  test("the mailbox path is resolved once: retargeting the mail-root symlink does not move completion or delivery", async () => {
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
      claim: { token: randomUUID(), pid: process.pid, start: null },
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

    expect(await c.completeDelivery(m)).toEqual({ status: "completed" });
    expect(intentPhase("m1.json")).toBeNull(); // rootA's intent is the one finalized
    const next = delivered(await c.deliverNext());
    expect(next.message.verifiedEnvelope?.messageId).toBe("pinned-2"); // rootA's new/, not rootB's

    root = join(rootB, AGENT);
    expect(intentText("m1.json")).toBe(rootBIntent);
    expect(newFiles()).toEqual(["m9.json"]);
  });
});

describe("deliverNext defers pending cur-copy failures before committing new mail", () => {
  test("a failed pending verification defers; a later valid message is not committed", async () => {
    plant("m1.json", "will-not-verify");
    const first = client();
    first.releaseDelivery(delivered(await first.deliverNext()));
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
    first.releaseDelivery(delivered(await first.deliverNext()));
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
    replay.beginPlacement("cli-shaped", "m1.json", fresh("m1.json"));
    linkSync(fresh("m1.json"), cur("m1.json"));
    unlinkSync(fresh("m1.json"));
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
        c.releaseDelivery(m);
      }
      // The next hand-over would exceed the bound: poison is not presented, its
      // intent becomes terminal `failed`, and the next message flows.
      expect(idOf(await c.deliverNext())).toBe("healthy");
    } finally { warn.mockRestore(); }

    expect(warnings.some((w) => w.includes("poison") && w.includes(FAILED_AT))).toBe(true);
    expect(intentPhase("m1.json")).toBe("failed");
    expect(intentJson("m1.json").claim).toBeUndefined();
    expect(textOf(cur("m1.json"))).not.toBeNull(); // payload retained
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
    committed("bad-claim", { ...base, claim: { token: "not-a-uuid", pid: process.pid, start: null } });
    expect(intentPhase("m1.json")).toBe("unknown");
    committed("placing-claim", { phase: "placing", claim: { token: randomUUID(), pid: process.pid, start: null } }, "m2.json");
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
