/**
 * mail-promotion-kill-safety.test.ts — cli#515.
 *
 * Each case runs a REAL promote() in a child process and SIGKILLs it at an
 * injected pause point BEFORE a named filesystem operation — a killed process,
 * never an injected error — then runs a fresh in-process restart and checks the
 * end state. Every spawned process has a deadline; roots are mkdtemp'd.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommittedMessageId } from "@tpsdev-ai/agent";
import { checkMessages, getInbox, promote } from "../src/utils/mail.js";
import { buildSignedEnvelope, startStubFlair, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const AGENT = "agent-a";
const FROM = "agent-b";
const FROM_SEED = Buffer.alloc(32, 0x41);
const AGENT_SEED = Buffer.alloc(32, 0x42);
const CHILD = fileURLToPath(new URL("./helpers/promote-kill-child.mjs", import.meta.url));
const DIST_MAIL = new URL("../dist/src/utils/mail.js", import.meta.url).href;

const jsonFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name)
    : [];

interface KillRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  reached: boolean;
  stderr: string;
}

describe("promotion at the listed pause points (cli#515)", () => {
  let root: string;
  let keysDir: string;
  let stub: StubFlair;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "promote-kill-"));
    keysDir = join(root, "keys");
    stub = startStubFlair({ [FROM]: FROM_SEED, [AGENT]: AGENT_SEED });
    writeKeyFile(keysDir, AGENT, AGENT_SEED);
    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) savedEnv[k] = process.env[k];
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.FLAIR_URL = stub.url;
    process.env.FLAIR_KEY_PATH = join(keysDir, `${AGENT}.key`);
  });

  afterEach(() => {
    stub.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Plant one verified record in new/ and return its path. */
  function plant(messageId: string): string {
    const inbox = getInbox(AGENT);
    const env = buildSignedEnvelope(FROM, AGENT, "kill-safety", { [FROM]: FROM_SEED }, { messageId });
    const path = join(inbox.fresh, "record.json");
    writeFileSync(
      path,
      JSON.stringify({ id: env.messageId, from: FROM, to: AGENT, body: JSON.stringify(env), timestamp: new Date().toISOString() }),
      "utf-8",
    );
    return path;
  }

  /** Run promote() in a child and SIGKILL it at `killAt`; resolve on exit. */
  function runAndKillAt(killAt: string, source: string, timeoutMs = 20_000): Promise<KillRun> {
    const inbox = getInbox(AGENT);
    const marker = join(root, `paused.${killAt}`);
    const child = spawn("node", [CHILD, AGENT, source], {
      env: {
        HOME: root,
        PATH: process.env.PATH,
        TPS_MAIL_DIR: process.env.TPS_MAIL_DIR,
        FLAIR_URL: stub.url,
        FLAIR_KEY_PATH: process.env.FLAIR_KEY_PATH,
        TPS_PROMOTE_MODULE: DIST_MAIL,
        TPS_KILL_AT: killAt,
        TPS_KILL_MARKER: marker,
        TPS_MAIL_ROOT: inbox.root,
        TPS_SRC: source,
        TPS_CUR: join(inbox.cur, basename(source)),
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
      child.once("exit", (code, signal) => {
        if (settled) return;
        stop();
        resolve({ code, signal, reached: existsSync(marker), stderr });
      });
    });
  }

  async function assertDeliveredExactlyOnce(messageId: string): Promise<void> {
    const inbox = getInbox(AGENT);
    const first = await checkMessages(AGENT);
    const second = await checkMessages(AGENT);

    expect(first.map((m) => m.body)).toEqual(["kill-safety"]);
    expect(second).toEqual([]);
    expect(jsonFiles(inbox.dlq)).toEqual([]);
    expect(jsonFiles(inbox.cur)).toEqual(["record.json"]);
    expect(existsSync(join(inbox.fresh, "record.json"))).toBe(false);
    expect(hasCommittedMessageId(inbox.root, messageId)).toBe(true);
  }

  const CASES: Array<{ at: string }> = [
    { at: "scratch-write" }, // before the scratch copy is written
    { at: "link-to-cur" }, // before the record is linked into cur/
    { at: "scratch-removal" }, // after the link, before the scratch copy is dropped
    { at: "ledger-commit" }, // after cur/ holds the record, before the consumed id is committed
    { at: "source-removal" }, // after the consumed id is committed, before new/ loses the source
  ];

  for (const { at } of CASES) {
    test(`restart checks return one delivery after ${at}`, async () => {
      const messageId = `kill-${at}`;
      const source = plant(messageId);
      const run = await runAndKillAt(at, source);
      expect(run.reached, `child never reached ${at}; stderr=${run.stderr}`).toBe(true);
      expect(run.signal).toBe("SIGKILL");

      if (at === "source-removal") {
        expect(await checkMessages(AGENT)).toEqual([]);
        const cur = join(getInbox(AGENT).cur, "record.json");
        const record = JSON.parse(readFileSync(cur, "utf-8"));
        record.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        writeFileSync(cur, JSON.stringify(record));
      }
      await assertDeliveredExactlyOnce(messageId);
    });
  }

  // A consumed envelope re-planted after a clean promotion still dead-letters
  // replay: the reconcile must not weaken the replay gate for delivered mail.
  test("a consumed envelope re-planted after a clean promotion still dead-letters replay", async () => {
    const first = await checkMessages(AGENT);
    expect(first).toEqual([]);
    plant("kill-replay");
    expect((await checkMessages(AGENT)).map((m) => m.body)).toEqual(["kill-safety"]);
    plant("kill-replay");
    expect(await checkMessages(AGENT)).toEqual([]);
    const inbox = getInbox(AGENT);
    expect(jsonFiles(inbox.dlq)).toContain("record.json");
    expect(readFileSync(join(inbox.dlq, "record.json.reason"), "utf-8")).toContain("class: replay");
  });

  test("a cur/ copy with no ledger commit and no placement intent is still replay", async () => {
    const messageId = "kill-foreign-cur";
    const source = plant(messageId);
    const inbox = getInbox(AGENT);
    const env = JSON.parse(JSON.parse(readFileSync(source, "utf-8")).body);
    const cur = join(inbox.cur, "record.json");
    writeFileSync(
      cur,
      JSON.stringify({ ...env, read: false, envelopeId: env.messageId, envelope: env, checkedOutAt: new Date().toISOString(), checkedOutBy: AGENT }),
      "utf-8",
    );
    const before = readFileSync(cur, "utf-8");

    const result = await promote(AGENT, source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("foreign cur/ copy was finished");
    expect(result.class).toBe("replay");
    expect(readFileSync(cur, "utf-8")).toBe(before);
    expect(hasCommittedMessageId(inbox.root, messageId)).toBe(false);
  });
});
