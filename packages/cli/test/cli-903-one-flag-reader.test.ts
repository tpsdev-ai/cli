/**
 * cli#903 (items 6-8): one shared `--flag` reader for the subcommand blocks.
 *
 * It stops at the first `--` after the subcommand (a `--` before it is passed), accepts `--name value` and `--name=value`, and refuses a
 * repeated flag with a usage error naming it. A conflicting repeat that meow
 * rejects is reported the same way, without a stack.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listMessages, sendMessage } from "../src/utils/mail.js";
import { buildSignedEnvelope, startStubFlair, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const OWNER = "agent-a";
const OTHER = "agent-b";
const SENDER = "agent-c";
const SEEDS = {
  [OWNER]: Buffer.alloc(32, 0x41),
  [OTHER]: Buffer.alloc(32, 0x42),
  [SENDER]: Buffer.alloc(32, 0x43),
};
const UNREACHABLE = "http://127.0.0.1:1";

describe("tps shared flag reader (cli#903 items 6-8)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-one-flag-reader-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS, (req, url) => {
      if (req.method === "GET" && url.pathname === "/Soul/") {
        return Response.json([
          { agentId: OWNER, key: "skill-assignment", value: "skill-eq", priority: "standard", metadata: "{}" },
        ]);
      }
      return undefined;
    });
    for (const agent of [OWNER, OTHER, SENDER]) writeKeyFile(keysDir, agent, SEEDS[agent]!);
    writeKeyFile(join(tempRoot, ".tps", "identity"), OWNER, SEEDS[OWNER]!);
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
    mkdirSync(join(tempRoot, "mail", OTHER), { recursive: true });
  });

  afterEach(() => {
    stub.stop();
    delete process.env.TPS_MAIL_DIR;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  interface Result {
    status: number | null;
    out: string;
  }

  async function run(args: string[], env: Record<string, string> = {}): Promise<Result> {
    const proc = Bun.spawn([process.execPath, TPS_BIN, "--quiet-nono-check", ...args], {
      cwd: tempRoot,
      env: {
        ...process.env,
        HOME: tempRoot,
        TPS_MAIL_DIR: join(tempRoot, "mail"),
        TPS_AGENT_ID: OWNER,
        FLAIR_URL: stub.url,
        FLAIR_KEY_PATH: join(keysDir, `${OWNER}.key`),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, out: `${stdout}${stderr}` };
  }

  function seedFor(agent: string): string {
    return sendMessage(agent, JSON.stringify(buildSignedEnvelope(SENDER, agent, "seed", SEEDS)), SENDER).id;
  }

  async function recordFor(agent: string, id: string) {
    return (await listMessages(agent)).find((m) => m.id === id || m.id.startsWith(id));
  }

  function stackFree(out: string): boolean {
    return !/\n\s+at\s/.test(out);
  }

  test("a flag after -- is not read as the flag", async () => {
    const r = await run(["skill", "show", "skill-x", "--", `--agent=${OWNER}`]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Usage: tps skill show <name> --agent <id>");
    expect(stackFree(r.out)).toBe(true);
  });

  test("a positional message body starting with --agent=x is sent as the body", async () => {
    const r = await run(["mail", "send", OTHER, "--", "--agent=agent-a"]);
    expect(r.status).toBe(0);
    const inbox = join(tempRoot, "mail", OTHER, "new");
    const sent = readdirSync(inbox)
      .map((file) => JSON.parse(readFileSync(join(inbox, file), "utf-8")))
      .find((record) => JSON.parse(record.body).body === "--agent=agent-a");
    expect(sent).toBeDefined();
  });

  test("a leading -- is skipped and a later -- ends the flags", async () => {
    const r = await run(["--", "skill", "list", "--agent", OWNER, "--", `--agent=${OTHER}`]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`Skills assigned to ${OWNER}`);
    expect(r.out).not.toContain(`Skills assigned to ${OTHER}`);
  });

  test("a conflicting repeat is a usage error naming --agent, with no stack, and acts on nothing", async () => {
    const id = seedFor(OWNER);
    const r = await run(["mail", "ack", id, "--agent", OWNER, `--agent=${OTHER}`]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("--agent");
    expect(r.out).toContain("can only be given once");
    expect(stackFree(r.out)).toBe(true);

    const record = await recordFor(OWNER, id);
    expect(record).toBeDefined();
    expect(record?.ackedAt).toBeUndefined();
  });

  test("a repeated raw flag is refused with a usage error naming it", async () => {
    const r = await run(["bridge", "status", "--adapter=openclaw", "--adapter=discord"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("--adapter");
    expect(r.out).toContain("once");
    expect(stackFree(r.out)).toBe(true);
  });

  test("--desc=x and --desc x both create a topic", async () => {
    expect((await run(["mail", "topic", "create", "topic-eq", "--desc=hello"])).status).toBe(0);
    expect((await run(["mail", "topic", "create", "topic-space", "--desc", "hello"])).status).toBe(0);

    const listed = await run(["mail", "topic", "list", "--json"]);
    expect(listed.status).toBe(0);
    const topics = JSON.parse(listed.out) as Array<{ name: string; description: string }>;
    expect(topics.find((t) => t.name === "topic-eq")?.description).toBe("hello");
    expect(topics.find((t) => t.name === "topic-space")?.description).toBe("hello");
  });

  test("a former space-only skill flag works in the equals form", async () => {
    const space = await run(["skill", "list", "--agent", OWNER, "--flair-url", stub.url], { FLAIR_URL: UNREACHABLE });
    expect(space.status).toBe(0);
    expect(space.out).toContain("skill-eq");

    const equals = await run(["skill", "list", "--agent", OWNER, `--flair-url=${stub.url}`], { FLAIR_URL: UNREACHABLE });
    expect(equals.status).toBe(0);
    expect(equals.out).toContain("skill-eq");
  });
});
