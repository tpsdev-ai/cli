import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertBridgeAdapterName,
  BRIDGE_ADAPTER_NAME_RE,
  validateBridgeAdapterName,
  type BridgeAdapter,
  type BridgeEnvelope,
} from "../src/bridge/adapter.js";
import { BRIDGE_ADAPTERS, BridgeCore } from "../src/bridge/core.js";
import { DiscordAdapter } from "../src/bridge/discord-adapter.js";
import { OpenClawAdapter } from "../src/bridge/openclaw-adapter.js";
import { StdioAdapter } from "../src/bridge/stdio-adapter.js";
import { bridgePidFiles } from "../src/utils/mail-bridge.js";
import * as mail from "../src/utils/mail.js";
import type { MailMessage, PromoteOk } from "../src/utils/mail.js";

afterEach(() => {
  mock.restore();
});

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tps-bridge-adapter-name-725-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PARITY_STATE_WAIT_MS = 10_000;
const PARITY_TEST_TIMEOUT_MS = 30_000;

/** Wait for the pid record start() writes at `expectedPath` to be classified
 *  `running`, or fail with how long it waited and the last state it saw instead
 *  of bun's timeout. The path is compared exactly, so a legacy record mapping to
 *  the same adapter name cannot satisfy the wait. */
async function waitForRunningPidRecord(name: string, expectedPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "no record";
  for (;;) {
    const found = bridgePidFiles(name);
    lastSeen = found.length === 0
      ? "no record"
      : JSON.stringify(found.map((entry) => ({ path: entry.path, state: entry.state })));
    const expected = found.find((entry) => entry.path === expectedPath);
    if (expected?.state.kind === "running") return;
    if (Date.now() >= deadline) {
      throw new Error(
        `bridge pid record at ${JSON.stringify(expectedPath)} did not reach "running" within ${timeoutMs} ms; last state: ${lastSeen}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("bridge adapter-name grammar (cli#725)", () => {
  let mailDir: string;
  let testHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    mailDir = makeTmpDir();
    testHome = makeTmpDir();
    origHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(mailDir, { recursive: true, force: true });
    rmSync(testHome, { recursive: true, force: true });
  });

  test("every registered adapter name passes the validator", () => {
    const instances: BridgeAdapter[] = [
      new OpenClawAdapter(),
      new DiscordAdapter({ token: "test-token", channelId: "test-channel" }),
      new StdioAdapter(),
    ];
    expect(instances.map((adapter) => adapter.name)).toEqual([...BRIDGE_ADAPTERS]);

    for (const name of BRIDGE_ADAPTERS) {
      expect(BRIDGE_ADAPTER_NAME_RE.test(name)).toBe(true);
      expect(validateBridgeAdapterName(name)).toBe(true);
      expect(() => assertBridgeAdapterName(name)).not.toThrow();
    }
  });

  test("out-of-grammar adapter names are refused before anything is written or started", async () => {
    const invalidNames = [
      "Bad-Name",
      "a/b",
      "",
      "../escape",
      "openclaw2",
      "bad_name",
      "bad name",
    ];

    for (const badName of invalidNames) {
      expect(validateBridgeAdapterName(badName)).toBe(false);

      let started = false;
      const badAdapter: BridgeAdapter = {
        name: badName,
        async start() {
          started = true;
        },
        async send() {},
        async stop() {},
      };

      let constructionError: Error | undefined;
      try {
        new BridgeCore(badAdapter, { defaultAgentId: "default-agent", mailDir }, () => {});
      } catch (err) {
        constructionError = err as Error;
      }
      expect(constructionError).toBeInstanceOf(Error);
      expect(constructionError?.message).toContain(JSON.stringify(badName));
      expect(constructionError?.message).toContain("[a-z]+");
      expect(started).toBe(false);
      expect(existsSync(join(mailDir, ".bridge-principals"))).toBe(false);

      // Also verify BridgeCore.start() itself refuses if adapter.name is invalid when start() runs.
      let currentName = "valid";
      const mutableAdapter: BridgeAdapter = {
        get name() {
          return currentName;
        },
        async start() {
          started = true;
        },
        async send() {},
        async stop() {},
      };
      // Its own mail root, so this valid construction does not leave .bridge-principals for the next name's check.
      const core = new BridgeCore(mutableAdapter, { defaultAgentId: "default-agent", mailDir: join(mailDir, `mutable-${invalidNames.indexOf(badName)}`) }, () => {});
      currentName = badName;

      let startError: Error | undefined;
      try {
        await core.start();
      } catch (err) {
        startError = err as Error;
      }
      expect(startError).toBeInstanceOf(Error);
      expect(startError?.message).toContain(JSON.stringify(badName));
      expect(startError?.message).toContain("[a-z]+");
      expect(started).toBe(false);

      const pidDir = join(testHome, ".tps", "run");
      const pidFiles = existsSync(pidDir) ? readdirSync(pidDir) : [];
      expect(pidFiles).toEqual([]);
      expect(bridgePidFiles()).toEqual([]);
    }
  });

  for (const name of [...BRIDGE_ADAPTERS, "a", "z", "customadapter"]) {
    test(`writer/reader parity: accepted adapter name ${name} writes a pid file discovered by bridgePidFiles`, async () => {
      expect(validateBridgeAdapterName(name)).toBe(true);

      const adapter: BridgeAdapter = {
        name,
        async start() {},
        async send() {},
        async stop() {},
      };
      const core = new BridgeCore(adapter, { defaultAgentId: "default-agent", mailDir }, () => {});
      await core.start();
      try {
        const expectedPath = join(testHome, ".tps", "run", `bridge-${name}.pid`);
        await waitForRunningPidRecord(name, expectedPath, PARITY_STATE_WAIT_MS);
        expect(existsSync(expectedPath)).toBe(true);

        const byAdapter = bridgePidFiles(name);
        expect(byAdapter).toHaveLength(1);
        expect(byAdapter[0]?.adapter).toBe(name);
        expect(byAdapter[0]?.path).toBe(expectedPath);
        expect(byAdapter[0]?.state.kind).toBe("running");

        const allDiscovered = bridgePidFiles();
        expect(allDiscovered.map((entry) => entry.adapter)).toContain(name);
      } finally {
        await core.stop();
      }
      expect(bridgePidFiles(name)).toEqual([]);
    }, PARITY_TEST_TIMEOUT_MS);
  }

  test("the pid file and record use the name validated at construction, even when the adapter renames itself in start()", async () => {
    class RenamingAdapter implements BridgeAdapter {
      name = "openclaw";
      async start() {
        this.name = "openclaw2";
      }
      async send() {}
      async stop() {}
    }
    const core = new BridgeCore(new RenamingAdapter(), { defaultAgentId: "default-agent", mailDir }, () => {});
    await core.start();
    const runDir = join(testHome, ".tps", "run");
    const expectedPath = join(runDir, "bridge-openclaw.pid");
    try {
      await waitForRunningPidRecord("openclaw", expectedPath, PARITY_STATE_WAIT_MS);
      expect(readdirSync(runDir)).toEqual(["bridge-openclaw.pid"]);
      const found = bridgePidFiles("openclaw");
      expect(found.map((entry) => entry.path)).toEqual([expectedPath]);
      expect(found[0]?.adapter).toBe("openclaw");
      expect(found[0]?.state.kind).toBe("running");
    } finally {
      await core.stop();
    }
    // stop() removes the file it wrote, not one named after the renamed adapter.
    expect(readdirSync(runDir)).toEqual([]);
  }, PARITY_TEST_TIMEOUT_MS);

  test("a plain-text outbound reply carries the constructed adapter name after the adapter renames itself in start()", async () => {
    class RenamingAdapter implements BridgeAdapter {
      name = "openclaw";
      readonly sent: BridgeEnvelope[] = [];
      async start() {
        this.name = "openclaw2";
      }
      async send(envelope: BridgeEnvelope) {
        this.sent.push(envelope);
      }
      async stop() {}
    }
    const adapter = new RenamingAdapter();
    const core = new BridgeCore(adapter, { bridgeAgentId: "test-bridge", defaultAgentId: "default-agent", mailDir }, () => {});
    try {
      // The reply and the promote spy are in place before start(), so the outbox's initial scan delivers it.
      // Waiting on an fs.watch event instead took up to 2.4 s on a loaded host.
      const reply: MailMessage = {
        id: "reply-1",
        from: "agent-a",
        to: "test-bridge",
        body: "plain reply from the agent",
        timestamp: new Date().toISOString(),
        read: false,
      };
      const replyPath = join(mailDir, "test-bridge", "tmp", "reply.json");
      mkdirSync(join(mailDir, "test-bridge", "tmp"), { recursive: true });
      writeFileSync(replyPath, JSON.stringify(reply), "utf-8");
      const promoted: PromoteOk = { ok: true, message: reply, path: replyPath };
      spyOn(mail, "promote").mockImplementation(async (_agent, filePath) => {
        rmSync(filePath, { force: true });
        return promoted;
      });

      mkdirSync(join(mailDir, "test-bridge", "new"), { recursive: true });
      writeFileSync(join(mailDir, "test-bridge", "new", "reply.json"), JSON.stringify(reply), "utf-8");
      await core.start();
      for (let attempt = 0; attempt < 300 && adapter.sent.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(adapter.sent.map((envelope) => envelope.content)).toEqual(["plain reply from the agent"]);
      expect(adapter.sent.map((envelope) => envelope.channel)).toEqual(["openclaw"]);
    } finally {
      await core.stop();
    }
  }, 10_000);

  test("start() refuses when the adapter's name changed to another valid name after construction", async () => {
    let current = "openclaw";
    let started = false;
    const adapter: BridgeAdapter = {
      get name() {
        return current;
      },
      async start() {
        started = true;
      },
      async send() {},
      async stop() {},
    };
    const core = new BridgeCore(adapter, { defaultAgentId: "default-agent", mailDir }, () => {});
    current = "discord";

    let startError: Error | undefined;
    try {
      await core.start();
    } catch (err) {
      startError = err as Error;
    }
    expect(startError?.message).toContain('changed from "openclaw" to "discord"');
    expect(started).toBe(false);
    const pidDir = join(testHome, ".tps", "run");
    expect(existsSync(pidDir) ? readdirSync(pidDir) : []).toEqual([]);
  });

  test("construction reads the adapter name once, so the principal record is for the validated name", () => {
    let reads = 0;
    const adapter: BridgeAdapter = {
      get name() {
        reads += 1;
        return reads === 1 ? "openclaw" : "bad_name";
      },
      async start() {},
      async send() {},
      async stop() {},
    };
    new BridgeCore(adapter, { defaultAgentId: "default-agent", mailDir }, () => {});
    expect(reads).toBe(1);
    const principals = readdirSync(join(mailDir, ".bridge-principals"));
    expect(principals.some((file) => file.startsWith("bad_name"))).toBe(false);
    expect(principals.some((file) => file.startsWith("openclaw-bridge"))).toBe(true);
  });

  test("the refusal message escapes every code point outside printable ASCII", () => {
    const codePoints = [0x007f, 0x009b, 0x202e, 0x2028, 0x061c, 0x200b, 0x200d, 0x2060, 0x206a, 0xfeff, 0x180e, 0x00ad, 0xfdd0, 0xfde0, 0xfdef, 0xfffe, 0xffff, 0x1f600];
    let message = "";
    try {
      assertBridgeAdapterName(`x${String.fromCodePoint(...codePoints)}`);
    } catch (err) {
      message = (err as Error).message;
    }
    for (const codePoint of codePoints) {
      const raw = String.fromCodePoint(codePoint);
      expect(message).not.toContain(raw);
      for (let index = 0; index < raw.length; index++) {
        const escape = `\\u${raw.charCodeAt(index).toString(16).padStart(4, "0")}`;
        expect(message).toContain(escape);
      }
    }
  });
});
