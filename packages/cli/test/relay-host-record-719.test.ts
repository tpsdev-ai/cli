import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { processStartToken } from "@tpsdev-ai/agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStatePath } from "../src/utils/connection-state.js";
import { generateKeyPair, initHostIdentity, registerBranch } from "../src/utils/identity.js";
import { readPidFile } from "../src/utils/pid-file.js";
import { connectAndKeepAlive } from "../src/utils/relay.js";
import type { TransportChannel } from "../src/utils/transport.js";
import * as ws from "../src/utils/ws-noise-transport.js";

afterEach(() => { mock.restore(); });

test("connectAndKeepAlive writes a host record that readPidFile verifies as running", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-relay-host-record-719-"));
  const savedEnv = { HOME: process.env.HOME, TPS_ROOT: process.env.TPS_ROOT,
    TPS_IDENTITY_DIR: process.env.TPS_IDENTITY_DIR, TPS_REGISTRY_DIR: process.env.TPS_REGISTRY_DIR,
    TPS_VAULT_KEY: process.env.TPS_VAULT_KEY };
  let stop: (() => Promise<void>) | undefined;
  let attached = false;
  let detached = false;
  let alive = true;
  const channel: TransportChannel = {
    async send() {},
    onMessage() { attached = true; },
    offMessage() { detached = true; },
    async close() { alive = false; },
    isAlive() { return alive; },
    peerFingerprint() { return "remote"; },
  };
  const connect = spyOn(ws.WsNoiseTransport.prototype, "connect").mockResolvedValue(channel);
  try {
    process.env.HOME = root;
    process.env.TPS_ROOT = root;
    process.env.TPS_IDENTITY_DIR = join(root, "identity");
    process.env.TPS_REGISTRY_DIR = join(root, "registry");
    process.env.TPS_VAULT_KEY = "relay-host-record-test";
    await initHostIdentity();
    const branch = "remote";
    const keys = generateKeyPair();
    registerBranch(branch, keys.signing.publicKey, undefined, keys.encryption.publicKey);
    const branchDir = join(root, ".tps", "branch-office", branch);
    mkdirSync(branchDir, { recursive: true });
    writeFileSync(join(branchDir, "remote.json"), JSON.stringify({ host: "unused", port: 1, transport: "ws" }));

    stop = await connectAndKeepAlive(branch);
    const path = hostStatePath(branch);
    for (let i = 0; (!existsSync(path) || !attached) && i < 200; i++) await Bun.sleep(5);
    const record = JSON.parse(readFileSync(path, "utf8"));
    const token = processStartToken(process.pid);
    expect(record.pid).toBe(process.pid);
    expect(record.startToken).toBe(token);
    expect(token).not.toBeNull();
    expect(readPidFile(path)).toEqual({ kind: "running", path, pid: process.pid, startToken: token });
  } finally {
    try {
      await stop?.();
      for (let i = 0; attached && !detached && i < 200; i++) await Bun.sleep(10);
      expect(attached && !detached).toBe(false);
    } finally {
      connect.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});
