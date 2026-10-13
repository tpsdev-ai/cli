/**
 * cli#617 slice (b): recoverPromoted withholds a cur/ record whose placement
 * intent declares a phase other than `placing`. The check lives in
 * recoverPromoted, so every direct caller — the bridge and plugin startup
 * sweeps, verifyMailAction and the plugin's internalInbound — gets it.
 */

import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { afterEach, beforeEach, expect, spyOn, test, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { getInbox, promote, recoverPromoted, sendMessage, verifyMailAction } from "../src/utils/mail.js";
import { signOutboundBody } from "../src/utils/mail-sign.js";
import { mailboxReplayStore } from "../../agent/src/lib/mailbox-policy.js";

afterEach(() => {
  mock.restore();
});

const seed = Buffer.alloc(32, 0x33);
let home: string;
let keys: string;
let savedEnv: Record<string, string | undefined>;
const fetchSpyState = { value: undefined as unknown as ReturnType<typeof spyOn> };

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
  const publicKey = Buffer.from(ed.getPublicKey(seed)).toString("base64");
  patchShared(fetchSpyState, "value", spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== "http://flair.test") throw new Error(`unexpected request: ${url.origin}`);
    if (url.pathname === "/Health") return new Response("ok");
    const name = url.pathname.match(/^\/Agent\/(.+)$/)?.[1];
    return name && ["flint", "local-agent"].includes(name)
      ? Response.json({ id: name, publicKey })
      : new Response("not found", { status: 404 });
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

/** Promote one signed record into kern's cur/ and write a placement intent in `fields`. */
async function promotedRecord(fields: Record<string, unknown> | null): Promise<{ root: string; file: string; messageId: string; path: string }> {
  const sent = sendMessage("kern", signOutboundBody("flint", "kern", "original", { requireKey: true }), "flint");
  const file = sent.filePath.split("/").pop()!;
  const result = await promote("kern", sent.filePath);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const inbox = getInbox("kern");
  const path = join(inbox.cur, file);
  if (fields !== null) {
    const replay = mailboxReplayStore(inbox.root);
    replay.beginPlacement(result.message.id, file, path);
    const intent = intentPath(inbox.root, file);
    writeFileSync(intent, JSON.stringify({ ...JSON.parse(readFileSync(intent, "utf8")), ...fields }));
  }
  return { root: inbox.root, file, messageId: result.message.id, path };
}

test("recoverPromoted presents a record with no intent, or a placing intent", async () => {
  const { root, file, messageId, path } = await promotedRecord(null);
  expect((await recoverPromoted("kern", path)).ok).toBe(true);
  mailboxReplayStore(root).beginPlacement(messageId, file, path);
  expect((await recoverPromoted("kern", path)).ok).toBe(true);
});

const WITHHELD: Record<string, Record<string, unknown>> = {
  in_progress: { version: 1, phase: "in_progress", presentations: 1, firstPresentedAt: new Date().toISOString() },
  failed: { version: 1, phase: "failed", presentations: 5, firstPresentedAt: new Date().toISOString() },
  unknown: { version: 1, phase: "awaiting-review" },
};

for (const [phase, fields] of Object.entries(WITHHELD)) {
  test(`recoverPromoted withholds a ${phase} intent; verifyMailAction refuses it`, async () => {
    const { path, messageId } = await promotedRecord(fields);
    const recovered = await recoverPromoted("kern", path);
    expect(recovered.ok).toBe(false);
    if (!recovered.ok) expect(recovered.reason).toContain("not presented");
    await expect(verifyMailAction("kern", messageId)).rejects.toThrow("mail action refused");
  });
}
