/**
 * flair-sync.test.ts — Unit tests for Flair sync command
 *
 * Uses mock HTTP servers to avoid real Flair dependency.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { runFlairSync } from "../src/commands/flair-sync.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal raw 32-byte Ed25519 seed (fake — avoids real key requirement). */
const FAKE_SEED = Buffer.alloc(32, 0x42);

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

function startMockServer(handler: Handler): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, body, res));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function jsonRes(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = "2026-03-15T00:00:00.000Z";
const PAST = "2026-03-10T00:00:00.000Z";

function makeMemory(id: string, content: string, updatedAt = NOW) {
  return {
    id,
    agentId: "anvil",
    content,
    type: "lesson",
    durability: "standard",
    createdAt: updatedAt,
    updatedAt,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("flair-sync", () => {
  let tmpDir: string;
  let keyPath: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    keyPath = join(tmpDir, "anvil.key");
    cfgPath = join(tmpDir, "flair-sync.json");
    writeFileSync(keyPath, FAKE_SEED);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(localUrl: string, remoteUrl: string, lastSyncTimestamp = PAST) {
    writeFileSync(
      cfgPath,
      JSON.stringify({ localUrl, remoteUrl, agentId: "anvil", lastSyncTimestamp })
    );
  }

  it("push: local memory is PUT to remote", async () => {
    const mem = makeMemory("mem-001", "test content", NOW);
    const pushedIds: string[] = [];

    const localHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Memory/")) {
        jsonRes(res, 200, [mem]);
        return;
      }
      jsonRes(res, 404, {});
    };

    const remoteHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Health")) {
        jsonRes(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url?.includes("/Memory/mem-001")) {
        jsonRes(res, 404, { error: "not found" });
        return;
      }
      if (req.method === "PUT" && req.url?.includes("/Memory/mem-001")) {
        pushedIds.push("mem-001");
        jsonRes(res, 200, {});
        return;
      }
      jsonRes(res, 404, {});
    };

    const { server: ls, url: localUrl } = await startMockServer(localHandler);
    const { server: rs, url: remoteUrl } = await startMockServer(remoteHandler);

    writeConfig(localUrl, remoteUrl);
    try {
      await runFlairSync({ once: true, configPath: cfgPath, keyPath });
      expect(pushedIds).toContain("mem-001");
    } finally {
      await stopServer(ls);
      await stopServer(rs);
    }
  });

  it("dedup: memory with same content hash is skipped", async () => {
    const mem = makeMemory("mem-002", "same content", NOW);
    const putCount = { n: 0 };

    const localHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Memory/")) {
        jsonRes(res, 200, [mem]);
        return;
      }
      jsonRes(res, 404, {});
    };

    const remoteHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Health")) {
        jsonRes(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url?.includes("/Memory/mem-002")) {
        // Remote already has exact same content
        jsonRes(res, 200, mem);
        return;
      }
      if (req.method === "PUT") {
        putCount.n++;
        jsonRes(res, 200, {});
        return;
      }
      jsonRes(res, 404, {});
    };

    const { server: ls, url: localUrl } = await startMockServer(localHandler);
    const { server: rs, url: remoteUrl } = await startMockServer(remoteHandler);

    writeConfig(localUrl, remoteUrl);
    try {
      await runFlairSync({ once: true, configPath: cfgPath, keyPath });
      expect(putCount.n).toBe(0);
    } finally {
      await stopServer(ls);
      await stopServer(rs);
    }
  });

  it("config: lastSyncTimestamp updates after sync", async () => {
    const mem = makeMemory("mem-003", "update ts test", NOW);

    const localHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Memory/")) {
        jsonRes(res, 200, [mem]);
        return;
      }
      jsonRes(res, 404, {});
    };

    const remoteHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Health")) {
        jsonRes(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url?.includes("/Memory/")) {
        jsonRes(res, 404, {});
        return;
      }
      if (req.method === "PUT") {
        jsonRes(res, 200, {});
        return;
      }
      jsonRes(res, 404, {});
    };

    const { server: ls, url: localUrl } = await startMockServer(localHandler);
    const { server: rs, url: remoteUrl } = await startMockServer(remoteHandler);

    writeConfig(localUrl, remoteUrl, PAST);
    try {
      await runFlairSync({ once: true, configPath: cfgPath, keyPath });
      const cfgAfter = JSON.parse(readFileSync(cfgPath, "utf-8"));
      expect(new Date(cfgAfter.lastSyncTimestamp) > new Date(PAST)).toBe(true);
    } finally {
      await stopServer(ls);
      await stopServer(rs);
    }
  });

  it("dry-run: no writes, only logging", async () => {
    const mem = makeMemory("mem-004", "dry run test", NOW);
    const putCount = { n: 0 };

    const localHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Memory/")) {
        jsonRes(res, 200, [mem]);
        return;
      }
      jsonRes(res, 404, {});
    };

    const remoteHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Health")) {
        jsonRes(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url?.includes("/Memory/")) {
        jsonRes(res, 404, {});
        return;
      }
      if (req.method === "PUT") {
        putCount.n++;
        jsonRes(res, 200, {});
        return;
      }
      jsonRes(res, 404, {});
    };

    const { server: ls, url: localUrl } = await startMockServer(localHandler);
    const { server: rs, url: remoteUrl } = await startMockServer(remoteHandler);

    writeConfig(localUrl, remoteUrl);
    try {
      await runFlairSync({ once: true, dryRun: true, configPath: cfgPath, keyPath });
      expect(putCount.n).toBe(0);
    } finally {
      await stopServer(ls);
      await stopServer(rs);
    }
  });

  it("security: skips memories with mismatched agentId (spoofing guard)", async () => {
    const putCount = { n: 0 };

    // Local returns one legit memory and one with a foreign agentId
    const localHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Memory/")) {
        jsonRes(res, 200, [
          makeMemory("mem-legit", "legit content", NOW),
          { ...makeMemory("mem-spoof", "spoofed content", NOW), agentId: "attacker" },
        ]);
        return;
      }
      jsonRes(res, 404, {});
    };

    const remoteHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Health")) {
        jsonRes(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && req.url?.includes("/Memory/")) {
        jsonRes(res, 404, {});
        return;
      }
      if (req.method === "PUT") {
        putCount.n++;
        jsonRes(res, 200, {});
        return;
      }
      jsonRes(res, 404, {});
    };

    const { server: ls, url: localUrl } = await startMockServer(localHandler);
    const { server: rs, url: remoteUrl } = await startMockServer(remoteHandler);

    writeConfig(localUrl, remoteUrl);
    try {
      await runFlairSync({ once: true, configPath: cfgPath, keyPath });
      // Only the legit memory should be pushed; spoof memory is skipped
      expect(putCount.n).toBe(1);
    } finally {
      await stopServer(ls);
      await stopServer(rs);
    }
  });

  it("error handling: remote unreachable → graceful failure", async () => {
    const localHandler: Handler = (req, _body, res) => {
      if (req.method === "GET" && req.url?.startsWith("/Memory/")) {
        jsonRes(res, 200, [makeMemory("mem-005", "unreachable test", NOW)]);
        return;
      }
      jsonRes(res, 404, {});
    };

    const { server: ls, url: localUrl } = await startMockServer(localHandler);
    const remoteUrl = "http://127.0.0.1:1"; // definitely not listening

    writeConfig(localUrl, remoteUrl);
    try {
      await expect(
        runFlairSync({ once: true, configPath: cfgPath, keyPath })
      ).rejects.toThrow();
    } finally {
      await stopServer(ls);
    }
  });
});
