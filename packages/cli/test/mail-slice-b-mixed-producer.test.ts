import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();


import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { hasCommittedMessageId, MailClient, mailboxReplayStore } from "@tpsdev-ai/agent";
import { checkMessages, getInbox } from "../src/utils/mail.js";
import { buildSignedEnvelope, stubFlairHandler, writeKeyFile } from "./helpers/stub-flair.js";

afterEach(() => {
  mock.restore();
});

const AGENT = "agent-a";
const FROM = "agent-b";
const FROM_SEED = Buffer.alloc(32, 0x61);
const AGENT_SEED = Buffer.alloc(32, 0x62);
const CHILD = fileURLToPath(new URL("./helpers/promote-kill-child.mjs", import.meta.url));
const SOURCE_MAIL = new URL("../src/utils/mail.ts", import.meta.url).href;

describe("a CLI promotion killed before it finished its intent, then MailClient.deliverNext()", () => {
  let root: string;
  let keysDir: string;
  const fetchMockState = { value: undefined as unknown as ReturnType<typeof spyOn> };
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mixed-producer-"));
    keysDir = join(root, "keys");
    const handler = stubFlairHandler({ [FROM]: FROM_SEED, [AGENT]: AGENT_SEED });
    patchShared(fetchMockState, "value", spyOn(globalThis, "fetch").mockImplementation((async (input, init) => handler(new Request(input, init))) as typeof fetch));
    writeKeyFile(keysDir, AGENT, AGENT_SEED);
    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) savedEnv[k] = process.env[k];
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = join(root, "mail");
    process.env.FLAIR_URL = "http://flair.test";
    process.env.FLAIR_KEY_PATH = join(keysDir, `${AGENT}.key`);
  });

  afterEach(() => {
    fetchMockState.value.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** One verified record in new/ (the CLI record shape; its `body` is the signed envelope). */
  function plant(messageId: string, file: string): string {
    const inbox = getInbox(AGENT);
    const env = buildSignedEnvelope(FROM, AGENT, `body of ${messageId}`, { [FROM]: FROM_SEED }, { messageId });
    const path = join(inbox.fresh, file);
    writeFileSync(path, JSON.stringify({ id: env.messageId, from: FROM, to: AGENT, body: JSON.stringify(env), timestamp: new Date().toISOString() }), "utf-8");
    return path;
  }

  /** Run promote() in a child and SIGKILL it before the CLI finishes its placing intent. */
  function promoteAndKillBeforeIntentFinish(source: string, timeoutMs = 20_000): Promise<{ signal: NodeJS.Signals | null; reached: boolean; stderr: string }> {
    const inbox = getInbox(AGENT);
    const marker = join(root, "paused.intent-finish");
    const child = spawn(process.execPath, [CHILD, AGENT, source], {
      env: {
        HOME: root,
        PATH: process.env.PATH,
        TPS_MAIL_DIR: process.env.TPS_MAIL_DIR,
        FLAIR_URL: process.env.FLAIR_URL,
        TPS_FLAIR_TEST_SEEDS: JSON.stringify({ [FROM]: FROM_SEED.toString("base64"), [AGENT]: AGENT_SEED.toString("base64") }),
        FLAIR_KEY_PATH: process.env.FLAIR_KEY_PATH,
        TPS_PROMOTE_MODULE: SOURCE_MAIL,
        TPS_KILL_AT: "intent-finish",
        TPS_KILL_MARKER: marker,
        TPS_MAIL_ROOT: inbox.root,
        TPS_SRC: source,
        TPS_CUR: join(inbox.cur, basename(source)),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve, reject) => {
      let stderr = "";
      let settled = false;
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      const poll = setInterval(() => { if (existsSync(marker)) { clearInterval(poll); child.kill("SIGKILL"); } }, 15);
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true; clearInterval(poll);
        child.kill("SIGKILL");
        reject(new Error(`child never reached intent-finish (stderr: ${stderr})`));
      }, timeoutMs);
      child.once("error", (e) => { if (!settled) { settled = true; clearInterval(poll); clearTimeout(deadline); reject(e); } });
      child.once("exit", (_code, signal) => {
        if (settled) return;
        settled = true; clearInterval(poll); clearTimeout(deadline);
        resolve({ signal, reached: existsSync(marker), stderr });
      });
    });
  }

  const intentPath = (mailboxRoot: string, file: string) => join(mailboxRoot, `.placement-${createHash("sha256").update(file).digest("hex")}.json`);

  test("deliverNext() defers a CLI record, then resumes after lease expiry and verified CLI recovery", async () => {
    const inbox = getInbox(AGENT);
    const source = plant("cli-placed", "record.json");
    const run = await promoteAndKillBeforeIntentFinish(source);
    expect(run.reached, `child never reached intent-finish; stderr=${run.stderr}`).toBe(true);
    expect(run.signal).toBe("SIGKILL");

    // The real CLI-written state: a `placing` intent, the CLI-promoted record in
    // cur/ (plaintext body, signed envelope beside it), the ID committed.
    const curPath = join(inbox.cur, "record.json");
    const record = JSON.parse(readFileSync(curPath, "utf8"));
    expect(typeof record.envelope).toBe("object");
    expect(record.body).toBe("body of cli-placed");
    expect(mailboxReplayStore(inbox.root).placementPhase("record.json")).toBe("placing");
    expect(hasCommittedMessageId(inbox.root, "cli-placed")).toBe(true);
    const intentBefore = readFileSync(intentPath(inbox.root, "record.json"), "utf8");
    const recordBefore = readFileSync(curPath, "utf8");

    plant("later-valid", "later.json");
    const client = new MailClient(process.env.TPS_MAIL_DIR!, undefined, AGENT, {
      async getAgent(name: string) {
        return name === FROM ? { publicKey: Buffer.from(ed.getPublicKey(FROM_SEED)) } : null;
      },
    });
    for (let i = 0; i < 2; i++) {
      expect(await client.deliverNext()).toMatchObject({ status: "deferred", reason: "cli-record", file: "record.json" });
    }
    expect(readdirSync(inbox.fresh)).toEqual(["later.json"]);
    expect(hasCommittedMessageId(inbox.root, "later-valid")).toBe(false);
    expect(readFileSync(intentPath(inbox.root, "record.json"), "utf8")).toBe(intentBefore);
    expect(readFileSync(curPath, "utf8")).toBe(recordBefore);

    // Age the checkout before verified CLI recovery; hold later.json aside.
    const aside = join(root, "aside");
    mkdirSync(aside);
    renameSync(join(inbox.fresh, "later.json"), join(aside, "later.json"));
    record.checkedOutAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(curPath, JSON.stringify(record));
    const presented = await checkMessages(AGENT);
    expect(presented.map((m) => m.body)).toEqual(["body of cli-placed"]);
    expect(mailboxReplayStore(inbox.root).placementPhase("record.json")).toBeNull();

    renameSync(join(aside, "later.json"), join(inbox.fresh, "later.json"));
    const next = await client.deliverNext();
    expect(next.status).toBe("delivered");
    if (next.status === "delivered") expect(next.delivery.message.verifiedEnvelope?.messageId).toBe("later-valid");
  });
});
