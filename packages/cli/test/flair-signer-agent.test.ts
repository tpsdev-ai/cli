/**
 * cli#554 — the agent package's `FlairContextProvider` signs every Flair
 * request the same way the cli client does. It is driven here against the
 * shared verifying stub (`helpers/stub-flair.ts`): the stub accepts a request
 * signed by a caller it knows, and refuses an unknown caller and a bad
 * signature, so a broken signing path cannot stay green.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlairContextProvider } from "../../agent/src/io/flair.js";
import { pubkeyFromSeed, startStubFlair, writeKeyFile } from "./helpers/stub-flair.js";

const CALLER = Buffer.alloc(32, 0x61);
const PEER = Buffer.alloc(32, 0x62);
const WRONG = Buffer.alloc(32, 0x63);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli554-agent-signer-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function provider(agentId: string, seed: Buffer, url: string): FlairContextProvider {
  return new FlairContextProvider(agentId, { url, keyPath: writeKeyFile(root, agentId, seed) });
}

describe("cli#554 — FlairContextProvider signs its Flair reads", () => {
  test("the stub accepts the provider's signed Agent read", async () => {
    const stub = startStubFlair({ "agent-a": CALLER, "peer-b": PEER });
    try {
      const agent = await provider("agent-a", CALLER, stub.url).getAgent("peer-b");
      expect(agent?.publicKey).toBe(pubkeyFromSeed(PEER).toString("base64"));
    } finally {
      stub.stop();
    }
  });

  test("the stub refuses an unknown caller", async () => {
    const stub = startStubFlair({ "peer-b": PEER });
    try {
      await expect(provider("agent-unknown", CALLER, stub.url).getAgent("peer-b")).rejects.toThrow(
        '401: {"error":"unknown_agent"}',
      );
    } finally {
      stub.stop();
    }
  });

  test("the stub refuses a bad signature", async () => {
    const stub = startStubFlair({ "agent-a": CALLER, "peer-b": PEER });
    try {
      await expect(provider("agent-a", WRONG, stub.url).getAgent("peer-b")).rejects.toThrow(
        '401: {"error":"invalid_signature"}',
      );
    } finally {
      stub.stop();
    }
  });
});
