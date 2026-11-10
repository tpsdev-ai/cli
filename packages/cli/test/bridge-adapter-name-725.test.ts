import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertBridgeAdapterName,
  BRIDGE_ADAPTER_NAME_RE,
  validateBridgeAdapterName,
  type BridgeAdapter,
} from "../src/bridge/adapter.js";
import { BRIDGE_ADAPTERS, BridgeCore } from "../src/bridge/core.js";
import { DiscordAdapter } from "../src/bridge/discord-adapter.js";
import { OpenClawAdapter } from "../src/bridge/openclaw-adapter.js";
import { StdioAdapter } from "../src/bridge/stdio-adapter.js";
import { bridgePidFiles } from "../src/utils/mail-bridge.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tps-bridge-adapter-name-725-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

  test("writer/reader parity: every accepted adapter name writes a pid file discovered by bridgePidFiles", async () => {
    const acceptedNames = [...BRIDGE_ADAPTERS, "a", "z", "customadapter"];

    for (const name of acceptedNames) {
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
    }
  });
});
