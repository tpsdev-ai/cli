/**
 * cli#903 (items 3-5): `ack`/`nack` must not fall back to the default agent.
 * A trailing positional agent is refused, and `--agent=<id>` is honoured.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listMessages, sendMessage } from "../src/utils/mail.js";
import { buildSignedEnvelope, startStubFlair, writeKeyFile, type StubFlair } from "./helpers/stub-flair.js";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const OWNER = "agent-a";
const OTHER = "agent-b";
const SENDER = "agent-c";
const SEEDS = {
  [OWNER]: Buffer.alloc(32, 0x31),
  [OTHER]: Buffer.alloc(32, 0x32),
  [SENDER]: Buffer.alloc(32, 0x33),
};

describe("tps mail ack/nack agent flags (cli#903)", () => {
  let tempRoot: string;
  let keysDir: string;
  let stub: StubFlair;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-ack-agent-flags-"));
    keysDir = join(tempRoot, "keys");
    stub = startStubFlair(SEEDS);
    writeKeyFile(keysDir, OWNER, SEEDS[OWNER]!);
    writeKeyFile(keysDir, OTHER, SEEDS[OTHER]!);
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
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

  /** The CLI authenticates mail verification as the mailbox owner it acts on. */
  async function run(args: string[], keyAgent = OWNER): Promise<Result> {
    const proc = Bun.spawn([process.execPath, TPS_BIN, "--quiet-nono-check", ...args], {
      cwd: tempRoot,
      env: {
        ...process.env,
        HOME: tempRoot,
        TPS_MAIL_DIR: join(tempRoot, "mail"),
        TPS_AGENT_ID: OWNER,
        FLAIR_URL: stub.url,
        FLAIR_KEY_PATH: join(keysDir, `${keyAgent}.key`),
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

  function seed(): { idA: string; idB: string } {
    const a = sendMessage(OWNER, JSON.stringify(buildSignedEnvelope(SENDER, OWNER, "to owner", SEEDS)), SENDER);
    const b = sendMessage(OTHER, JSON.stringify(buildSignedEnvelope(SENDER, OTHER, "to other", SEEDS)), SENDER);
    return { idA: a.id, idB: b.id };
  }

  async function recordFor(agent: string, id: string) {
    return (await listMessages(agent)).find((m) => m.id === id || m.id.startsWith(id));
  }

  /** Seed one acked record in each agent's mailbox that `gc --max-age 0s` collects. */
  function seedCollectable(): { idA: string; idB: string } {
    const a = sendMessage(OWNER, JSON.stringify(buildSignedEnvelope(SENDER, OWNER, "to owner", SEEDS)), SENDER);
    const b = sendMessage(OTHER, JSON.stringify(buildSignedEnvelope(SENDER, OTHER, "to other", SEEDS)), SENDER);
    for (const record of [a, b]) {
      const seeded = JSON.parse(readFileSync(record.filePath, "utf-8"));
      seeded.read = true;
      seeded.ackedAt = "2000-01-01T00:00:00.000Z";
      seeded.receivedAt = "2000-01-01T00:00:00.000Z";
      writeFileSync(record.filePath, JSON.stringify(seeded));
    }
    return { idA: a.id, idB: b.id };
  }

  test("ack refuses a trailing positional agent and acts on nothing", async () => {
    const { idA, idB } = seed();
    const r = await run(["mail", "ack", idA, OTHER]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("--agent <id>");

    const a = await recordFor(OWNER, idA);
    const b = await recordFor(OTHER, idB);
    expect(a).toBeDefined();
    expect(a?.ackedAt).toBeUndefined();
    expect(b).toBeDefined();
    expect(b?.ackedAt).toBeUndefined();
  });

  test("ack refuses an empty --agent value and acks nothing", async () => {
    const { idA, idB } = seed();
    for (const flag of ["--agent=", "--agent"]) {
      const r = await run(["mail", "ack", idA, flag]);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("--agent requires a value");
    }

    const a = await recordFor(OWNER, idA);
    const b = await recordFor(OTHER, idB);
    expect(a).toBeDefined();
    expect(a?.ackedAt).toBeUndefined();
    expect(b).toBeDefined();
    expect(b?.ackedAt).toBeUndefined();
  });

  test("ack honours --agent=<id>", async () => {
    const { idA, idB } = seed();
    const r = await run(["mail", "ack", idB, `--agent=${OTHER}`], OTHER);
    expect(r.status).toBe(0);

    const b = await recordFor(OTHER, idB);
    expect(b === undefined || b.ackedAt !== undefined).toBe(true);
    const a = await recordFor(OWNER, idA);
    expect(a).toBeDefined();
    expect(a?.ackedAt).toBeUndefined();
  });

  test("nack refuses a trailing positional agent and acts on nothing", async () => {
    const { idA, idB } = seed();
    const r = await run(["mail", "nack", idA, OTHER, "--reason", "test"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("--agent <id>");

    const a = await recordFor(OWNER, idA);
    const b = await recordFor(OTHER, idB);
    expect(a).toBeDefined();
    expect(a?.nackedAt).toBeUndefined();
    expect(b).toBeDefined();
    expect(b?.nackedAt).toBeUndefined();
  });

  test("nack refuses an empty --agent value and nacks nothing", async () => {
    const { idA, idB } = seed();
    for (const flag of ["--agent=", "--agent"]) {
      const r = await run(["mail", "nack", idA, "--reason=test", flag]);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("--agent requires a value");
    }

    const a = await recordFor(OWNER, idA);
    const b = await recordFor(OTHER, idB);
    expect(a).toBeDefined();
    expect(a?.nackedAt).toBeUndefined();
    expect(b).toBeDefined();
    expect(b?.nackedAt).toBeUndefined();
  });

  test("nack honours --agent=<id>", async () => {
    const { idA, idB } = seed();
    const r = await run(["mail", "nack", idB, `--agent=${OTHER}`, "--reason=test"], OTHER);
    expect(r.status).toBe(0);

    const b = await recordFor(OTHER, idB);
    expect(b).toBeDefined();
    expect(b?.nackedAt).toBeDefined();
    const a = await recordFor(OWNER, idA);
    expect(a).toBeDefined();
    expect(a?.nackedAt).toBeUndefined();
  });

  test("gc refuses an empty --agent value and collects nothing", async () => {
    const { idA, idB } = seedCollectable();
    for (const args of [["mail", "gc", "--agent="], ["mail", "gc", "--agent"], ["mail", "gc", "--agent", "--max-age", "0s"]]) {
      const r = await run(args);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("--agent requires a value");

      const a = await recordFor(OWNER, idA);
      const b = await recordFor(OTHER, idB);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    }
  });

  test("another getFlag option accepts the equals form", async () => {
    expect((await run(["mail", "topic", "create", "topic-a", "--desc=hello"])).status).toBe(0);
    const r = await run(["mail", "topic", "list", "--json"]);
    expect(r.status).toBe(0);
    const topics = JSON.parse(r.out) as Array<{ name: string; description: string }>;
    expect(topics.find((t) => t.name === "topic-a")?.description).toBe("hello");
  });

  test("nack usage names --agent", async () => {
    const usage = await run(["mail", "nack"]);
    expect(usage.status).toBe(1);
    expect(usage.out).toContain("tps mail nack <id> --reason <text> [--agent <id>]");

    for (const args of [["mail"], ["mail", "--help"]]) {
      const line = (await run(args)).out.split("\n").find((l) => l.includes("tps mail nack"));
      expect(line).toContain("[--agent <id>]");
    }
  });
});
