

import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMail } from "../src/commands/mail.js";
import { ackMessage, getInbox, nackMessage, promote, recoverPromoted, sendMessage, verifyMailAction } from "../src/utils/mail.js";
import { signOutboundBody } from "../src/utils/mail-sign.js";
import { stubFlairHandler } from "./helpers/stub-flair.js";
import { mailboxReplayStore } from "../../agent/src/lib/mailbox-policy.js";

afterEach(() => {
  mock.restore();
});

const seed = Buffer.alloc(32, 0x33);
let home: string;
let keys: string;
let savedEnv: Record<string, string | undefined>;
const fetchSpyState = { value: undefined as unknown as ReturnType<typeof spyOn> };

/** Holds Flair's answer for the sender while a test acts "during" verification. */
const flair = { gate: null as Promise<void> | null, entered: 0, senderUnknown: false };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mail-slice-b-"));
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
  flair.gate = null;
  flair.entered = 0;
  flair.senderUnknown = false;
  const handler = stubFlairHandler({ flint: seed, kern: seed }, async (_req, url) => {
    const name = url.pathname.match(/^\/Agent\/(.+)$/)?.[1];
    if (name === "flint" && flair.gate) {
      flair.entered++;
      await flair.gate;
    }
    if (name === "flint" && flair.senderUnknown) return new Response("not found", { status: 404 });
    return undefined;
  });
  patchShared(fetchSpyState, "value", spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).origin !== "http://flair.test") throw new Error(`unexpected request: ${req.url}`);
    return handler(req);
  }));
});

afterEach(() => {
  fetchSpyState.value.mockRestore();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const intentPath = (root: string, file: string) => join(root, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);

interface Promoted { root: string; file: string; id: string; envelopeId: string; path: string }

/** Promote one signed record into kern's cur/ (no intent left behind). */
async function promotedRecord(): Promise<Promoted> {
  const sent = sendMessage("kern", signOutboundBody("flint", "kern", "original", { requireKey: true }), "flint");
  const file = sent.filePath.split("/").pop()!;
  const result = await promote("kern", sent.filePath);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const inbox = getInbox("kern");
  return { root: inbox.root, file, id: result.message.id, envelopeId: result.message.envelopeId!, path: join(inbox.cur, file) };
}

/** Write a placement intent for the record, naming `messageId`, with `fields` merged in. */
function writeIntent(r: Promoted, fields: Record<string, unknown>, messageId = r.envelopeId): void {
  mailboxReplayStore(r.root).beginPlacement(messageId, r.file, r.path);
  const path = intentPath(r.root, r.file);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...fields }));
}

const IN_PROGRESS = () => ({
  version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: new Date().toISOString(),
  claim: { token: randomUUID(), pid: process.pid, start: null },
});

/** Start `action`, run `during` once Flair is asked for the sender, then let verification finish. */
async function duringVerification<T>(action: () => Promise<T>, during: () => void): Promise<T> {
  let release!: () => void;
  flair.gate = new Promise<void>((resolve) => { release = resolve; });
  flair.entered = 0;
  const running = action();
  const settled = running.then(() => true, () => true);
  try {
    const deadline = Date.now() + 5_000;
    while (flair.entered === 0) {
      if (await Promise.race([settled, new Promise<false>((r) => setTimeout(() => r(false), 2))])) {
        throw new Error("the action finished before it asked Flair for the sender");
      }
      if (Date.now() > deadline) throw new Error("the action never asked Flair for the sender");
    }
    during();
  } finally {
    flair.gate = null;
    release();
  }
  return running;
}

const dlqHas = (file: string) => existsSync(join(getInbox("kern").dlq, file));

describe("recoverPromoted", () => {
  test("unsigned Agent reads are refused; signed promotion succeeds", async () => {
    flair.gate = Promise.resolve();
    const response = await fetch("http://flair.test/Agent/flint");
    expect(response.status).toBe(403);
    expect((await response.json()).type).toBe("error:AccessViolation");
    expect(flair.entered).toBe(0);
    await promotedRecord();
  });

  test("presents a record with no intent, or its own placing intent", async () => {
    const r = await promotedRecord();
    expect((await recoverPromoted("kern", r.path)).ok).toBe(true);
    writeIntent(r, {});
    expect((await recoverPromoted("kern", r.path)).ok).toBe(true);
  });

  test("a dispatch claim is written after verification under the phase guard", async () => {
    const r = await promotedRecord();
    const recovered = await recoverPromoted("kern", r.path, {}, { claim: "bridge" });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);
    const record = JSON.parse(readFileSync(r.path, "utf8"));
    expect(record.checkedOutBy).toBe("bridge");
    expect(record.checkedOutAt).toBeDefined();
    expect(recovered.snapshot).toEqual(record);
  });

  test("a dispatch claim is refused when an intent appears during verification", async () => {
    const r = await promotedRecord();
    const before = readFileSync(r.path, "utf8");
    const recovered = await duringVerification(
      () => recoverPromoted("kern", r.path, {}, { claim: "bridge" }),
      () => writeIntent(r, IN_PROGRESS()),
    );
    expect(recovered.ok).toBe(false);
    expect(readFileSync(r.path, "utf8")).toBe(before);
  });

  test("a corrupt record held in_progress is refused without quarantine", async () => {
    const r = await promotedRecord();
    writeIntent(r, IN_PROGRESS());
    writeFileSync(r.path, "{corrupt");
    const recovered = await recoverPromoted("kern", r.path);
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.class).toBe("busy");
    expect(readFileSync(r.path, "utf8")).toBe("{corrupt");
    expect(dlqHas(r.file)).toBe(false);
  });

  test("withholds another consumer's placing commit without quarantining it", async () => {
    const r = await promotedRecord();
    writeIntent(r, {}, "another-message-id");
    const recovered = await recoverPromoted("kern", r.path);
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.reason).toContain("another consumer's placing commit");
    expect(existsSync(r.path)).toBe(true);
    expect(dlqHas(r.file)).toBe(false);
  });

  const WITHHELD: Record<string, () => Record<string, unknown>> = {
    in_progress: IN_PROGRESS,
    failed: () => ({ version: 1, phase: "failed", presentations: 5, firstPresentedAt: new Date().toISOString() }),
    unknown: () => ({ version: 1, phase: "awaiting-review" }),
  };

  for (const [phase, fields] of Object.entries(WITHHELD)) {
    test(`withholds a ${phase} intent; verifyMailAction refuses it`, async () => {
      const r = await promotedRecord();
      writeIntent(r, fields());
      const recovered = await recoverPromoted("kern", r.path);
      expect(recovered.ok).toBe(false);
      if (!recovered.ok) expect(recovered.reason).toContain("not presented");
      await expect(verifyMailAction("kern", r.id)).rejects.toThrow("mail action refused");
    });
  }

  test("an intent written while the verifier runs is caught by the final decision under the lock", async () => {
    const r = await promotedRecord();
    const recovered = await duringVerification(() => recoverPromoted("kern", r.path), () => writeIntent(r, IN_PROGRESS()));
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) {
      expect(recovered.class).toBe("busy");
      expect(recovered.reason).toContain("is in_progress");
    }
    expect(existsSync(r.path)).toBe(true);
  });

  test("a record whose verification fails is not quarantined when an intent appeared during it", async () => {
    const r = await promotedRecord();
    flair.senderUnknown = true;
    const recovered = await duringVerification(() => recoverPromoted("kern", r.path), () => writeIntent(r, IN_PROGRESS()));
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.class).toBe("busy");
    expect(existsSync(r.path)).toBe(true);
    expect(dlqHas(r.file)).toBe(false);
  });

  test("a record changed while the verifier runs is not presented", async () => {
    const r = await promotedRecord();
    const recovered = await duringVerification(() => recoverPromoted("kern", r.path), () => {
      const record = JSON.parse(readFileSync(r.path, "utf8"));
      writeFileSync(r.path, JSON.stringify({ ...record, checkedOutBy: "someone-else" }, null, 2));
    });
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.reason).toContain("changed during verification");
  });
});

describe("ack and nack re-check the intent under their own lock", () => {
  test("ackMessage and nackMessage refuse an in_progress record and leave it unchanged", async () => {
    const r = await promotedRecord();
    writeIntent(r, IN_PROGRESS());
    const before = readFileSync(r.path, "utf8");
    expect(() => ackMessage("kern", r.id)).toThrow("mail action refused");
    expect(() => nackMessage("kern", r.id, "no")).toThrow("mail action refused");
    expect(readFileSync(r.path, "utf8")).toBe(before);
  });

  test("ackMessage and nackMessage act on a record with no intent", async () => {
    const nacked = await promotedRecord();
    expect(nackMessage("kern", nacked.id, "retry later")?.nackedAt).toBeDefined();
    const acked = await promotedRecord();
    expect(ackMessage("kern", acked.id)?.ackedAt).toBeDefined();
    expect(existsSync(acked.path)).toBe(false);
  });
});

describe("tps mail ack / nack (the command)", () => {
  const silence = () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    return () => { log.mockRestore(); warn.mockRestore(); };
  };

  for (const action of ["ack", "nack"] as const) {
    test(`${action} refuses an in_progress record and changes nothing`, async () => {
      const r = await promotedRecord();
      writeIntent(r, IN_PROGRESS());
      const before = readFileSync(r.path, "utf8");
      const restore = silence();
      try {
        await expect(runMail({ action, agent: "kern", messageId: r.id, reason: "x" } as never)).rejects.toThrow("mail action refused");
      } finally { restore(); }
      expect(readFileSync(r.path, "utf8")).toBe(before);
    });

    test(`${action} refuses a phase written after verification releases its lock`, async () => {
      const r = await promotedRecord();
      const before = readFileSync(r.path, "utf8");
      const remove = fs.rmSync;
      let armed = false;
      let injected = false;
      const fault = spyOn(fs, "rmSync").mockImplementation((...args: Parameters<typeof remove>) => {
        remove(...args);
        if (armed && args[0] === join(r.root, ".mail-lock")) {
          armed = false;
          injected = true;
          writeIntent(r, IN_PROGRESS());
        }
      });
      const restore = silence();
      try {
        await expect(duringVerification(
          () => runMail({ action, agent: "kern", messageId: r.id, reason: "x" } as never),
          () => { armed = true; },
        )).rejects.toThrow("mail action refused");
      } finally { fault.mockRestore(); restore(); }
      expect(injected).toBe(true);
      expect(readFileSync(r.path, "utf8")).toBe(before);
    });

    test(`${action} refuses when the intent is written while its verification runs`, async () => {
      const r = await promotedRecord();
      const before = readFileSync(r.path, "utf8");
      const restore = silence();
      try {
        await expect(duringVerification(
          () => runMail({ action, agent: "kern", messageId: r.id, reason: "x" } as never),
          () => writeIntent(r, IN_PROGRESS()),
        )).rejects.toThrow("mail action refused");
      } finally { restore(); }
      expect(readFileSync(r.path, "utf8")).toBe(before);
    });
  }

  test("ack and nack act on a record with no intent", async () => {
    const restore = silence();
    try {
      const nacked = await promotedRecord();
      await runMail({ action: "nack", agent: "kern", messageId: nacked.id, reason: "later" } as never);
      expect(JSON.parse(readFileSync(nacked.path, "utf8")).nackedAt).toBeDefined();
      const acked = await promotedRecord();
      await runMail({ action: "ack", agent: "kern", messageId: acked.id } as never);
      expect(existsSync(acked.path)).toBe(false);
    } finally { restore(); }
  });
});
