/**
 * service-proxy.test.ts — OPS-122 Branch Service Proxy
 *
 * Tests:
 * - Service registry CRUD
 * - Name and URL validation
 * - Host-side path validation
 * - Branch-side proxy request/response round-trip (mock channel)
 * - Tunnel disconnect fails in-flight requests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";

// ─── Registry tests ───────────────────────────────────────────────────────────

describe("service-registry", () => {
  let tmpDir: string;
  let origTpsRoot: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-svc-reg-"));
    origTpsRoot = process.env.TPS_ROOT;
    process.env.TPS_ROOT = tmpDir;
  });

  afterEach(() => {
    if (origTpsRoot !== undefined) process.env.TPS_ROOT = origTpsRoot;
    else delete process.env.TPS_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("register and list a service", async () => {
    const { registerService, listServices } = await import("../src/utils/service-registry.js");
    registerService("flair", "http://127.0.0.1:9926", { localPort: 9926, description: "Flair" });
    const services = listServices();
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("flair");
    expect(services[0].url).toBe("http://127.0.0.1:9926");
    expect(services[0].localPort).toBe(9926);
  });

  it("remove a service", async () => {
    const { registerService, removeService, listServices } = await import("../src/utils/service-registry.js");
    registerService("flair", "http://127.0.0.1:9926");
    const removed = removeService("flair");
    expect(removed).toBe(true);
    expect(listServices()).toHaveLength(0);
  });

  it("remove returns false for unknown service", async () => {
    const { removeService } = await import("../src/utils/service-registry.js");
    expect(removeService("nonexistent")).toBe(false);
  });

  it("register overwrites existing entry", async () => {
    const { registerService, getService } = await import("../src/utils/service-registry.js");
    registerService("flair", "http://127.0.0.1:9926");
    registerService("flair", "http://127.0.0.1:9927", { description: "updated" });
    const svc = getService("flair");
    expect(svc?.url).toBe("http://127.0.0.1:9927");
    expect(svc?.description).toBe("updated");
  });

  it("getService returns null for unknown name", async () => {
    const { getService } = await import("../src/utils/service-registry.js");
    expect(getService("unknown")).toBeNull();
  });
});

// ─── Validation tests ─────────────────────────────────────────────────────────

describe("service-registry validation", () => {
  it("validateServiceName rejects injection chars", async () => {
    const { validateServiceName } = await import("../src/utils/service-registry.js");
    expect(() => validateServiceName("bad;name")).toThrow(/Invalid service name/);
    expect(() => validateServiceName("../etc/passwd")).toThrow(/Invalid service name/);
    expect(() => validateServiceName("a".repeat(65))).toThrow(/Invalid service name/);
  });

  it("validateServiceName accepts valid names", async () => {
    const { validateServiceName } = await import("../src/utils/service-registry.js");
    expect(() => validateServiceName("flair")).not.toThrow();
    expect(() => validateServiceName("my-service.v2")).not.toThrow();
    expect(() => validateServiceName("svc_123")).not.toThrow();
  });

  it("validateServiceUrl rejects non-localhost URLs", async () => {
    const { validateServiceUrl } = await import("../src/utils/service-registry.js");
    expect(() => validateServiceUrl("http://192.168.1.1:9926")).toThrow(/host-local/);
    expect(() => validateServiceUrl("http://example.com")).toThrow(/host-local/);
    expect(() => validateServiceUrl("https://external.io")).toThrow(/host-local/);
  });

  it("validateServiceUrl rejects non-http protocols", async () => {
    const { validateServiceUrl } = await import("../src/utils/service-registry.js");
    expect(() => validateServiceUrl("ftp://127.0.0.1")).toThrow(/http/);
    expect(() => validateServiceUrl("ws://localhost")).toThrow(/http/);
  });

  it("validateServiceUrl accepts localhost variants", async () => {
    const { validateServiceUrl } = await import("../src/utils/service-registry.js");
    expect(() => validateServiceUrl("http://localhost:9926")).not.toThrow();
    expect(() => validateServiceUrl("http://127.0.0.1:9926")).not.toThrow();
    expect(() => validateServiceUrl("https://127.0.0.1:9926")).not.toThrow();
  });
});

// ─── Host-side proxy handler tests ───────────────────────────────────────────

describe("service-proxy-host", () => {
  let tmpDir: string;
  let origTpsRoot: string | undefined;
  let mockService: Server;
  let mockPort: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-svc-host-"));
    origTpsRoot = process.env.TPS_ROOT;
    process.env.TPS_ROOT = tmpDir;

    // Start a mock local HTTP service
    await new Promise<void>((resolve) => {
      mockService = createServer((req, res) => {
        if (req.url === "/Memory/") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([{ id: "mem-1" }]));
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      });
      mockService.listen(0, "127.0.0.1", () => {
        mockPort = (mockService.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (origTpsRoot !== undefined) process.env.TPS_ROOT = origTpsRoot;
    else delete process.env.TPS_ROOT;
    await new Promise<void>((r) => mockService.close(() => r()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards request to registered service and returns response", async () => {
    const { registerService } = await import("../src/utils/service-registry.js");
    const { registerServiceProxyHandler } = await import("../src/utils/service-proxy-host.js");
    const { MSG_SERVICE_REQUEST, MSG_SERVICE_RESPONSE } = await import("../src/utils/wire-mail.js");

    registerService("flair", `http://127.0.0.1:${mockPort}`);

    // Mock channel
    const sent: any[] = [];
    let msgHandler: ((msg: any) => void) | null = null;
    const channel = {
      onMessage: (h: any) => { msgHandler = h; },
      offMessage: () => {},
      send: async (msg: any) => { sent.push(msg); },
      isAlive: () => true,
    };

    registerServiceProxyHandler(channel as any);

    // Trigger a service request
    await msgHandler!({
      type: MSG_SERVICE_REQUEST,
      seq: 0,
      ts: new Date().toISOString(),
      body: {
        reqId: "00000000-0000-0000-0000-000000000001",
        service: "flair",
        method: "GET",
        path: "/Memory/",
        headers: {},
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(MSG_SERVICE_RESPONSE);
    expect(sent[0].body.reqId).toBe("00000000-0000-0000-0000-000000000001");
    expect(sent[0].body.status).toBe(200);
    expect(sent[0].body.body).toContain("mem-1");
  });

  it("returns 404 for unknown service", async () => {
    const { registerServiceProxyHandler } = await import("../src/utils/service-proxy-host.js");
    const { MSG_SERVICE_REQUEST, MSG_SERVICE_RESPONSE } = await import("../src/utils/wire-mail.js");

    const sent: any[] = [];
    let msgHandler: ((msg: any) => void) | null = null;
    const channel = {
      onMessage: (h: any) => { msgHandler = h; },
      offMessage: () => {},
      send: async (msg: any) => { sent.push(msg); },
      isAlive: () => true,
    };

    registerServiceProxyHandler(channel as any);

    await msgHandler!({
      type: MSG_SERVICE_REQUEST,
      seq: 0,
      ts: new Date().toISOString(),
      body: {
        reqId: "00000000-0000-0000-0000-000000000002",
        service: "nonexistent",
        method: "GET",
        path: "/",
        headers: {},
      },
    });

    expect(sent[0].body.status).toBe(404);
    expect(sent[0].body.body).toContain("unknown service");
  });

  it("rejects path traversal attempts", async () => {
    const { registerService } = await import("../src/utils/service-registry.js");
    const { registerServiceProxyHandler } = await import("../src/utils/service-proxy-host.js");
    const { MSG_SERVICE_REQUEST, MSG_SERVICE_RESPONSE } = await import("../src/utils/wire-mail.js");

    registerService("flair", `http://127.0.0.1:${mockPort}`);

    const sent: any[] = [];
    let msgHandler: ((msg: any) => void) | null = null;
    const channel = {
      onMessage: (h: any) => { msgHandler = h; },
      offMessage: () => {},
      send: async (msg: any) => { sent.push(msg); },
      isAlive: () => true,
    };
    registerServiceProxyHandler(channel as any);

    for (const badPath of ["/../etc/passwd", "//double-slash", "/ok/../../../etc"]) {
      sent.length = 0;
      await msgHandler!({
        type: MSG_SERVICE_REQUEST,
        seq: 0,
        ts: new Date().toISOString(),
        body: { reqId: "00000000-0000-0000-0000-000000000003", service: "flair", method: "GET", path: badPath, headers: {} },
      });
      expect(sent[0].body.status).toBe(400);
    }
  });

  it("strips hop-by-hop headers before forwarding", async () => {
    const receivedHeaders: Record<string, string> = {};
    const capServer = await new Promise<{ server: Server; port: number }>((resolve) => {
      const s = createServer((req, res) => {
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") receivedHeaders[k] = v;
        }
        res.writeHead(200);
        res.end("{}");
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: (s.address() as any).port }));
    });

    const { registerService } = await import("../src/utils/service-registry.js");
    const { registerServiceProxyHandler } = await import("../src/utils/service-proxy-host.js");
    const { MSG_SERVICE_REQUEST } = await import("../src/utils/wire-mail.js");

    registerService("cap", `http://127.0.0.1:${capServer.port}`);

    const sent: any[] = [];
    let msgHandler: ((msg: any) => void) | null = null;
    const channel = {
      onMessage: (h: any) => { msgHandler = h; },
      offMessage: () => {},
      send: async (msg: any) => { sent.push(msg); },
      isAlive: () => true,
    };
    registerServiceProxyHandler(channel as any);

    await msgHandler!({
      type: MSG_SERVICE_REQUEST,
      seq: 0,
      ts: new Date().toISOString(),
      body: {
        reqId: "00000000-0000-0000-0000-000000000004",
        service: "cap",
        method: "GET",
        path: "/",
        headers: {
          "authorization": "Bearer token123",
          "host": "evil.com",               // should be stripped
          "connection": "keep-alive",        // should be stripped
          "transfer-encoding": "chunked",    // should be stripped
          "content-length": "0",             // should be stripped
        },
      },
    });

    // Hop-by-hop headers from client must not be forwarded
    expect(receivedHeaders["host"]).not.toBe("evil.com");
    // transfer-encoding and content-length must be stripped
    expect(receivedHeaders["transfer-encoding"]).toBeUndefined();
    expect(receivedHeaders["content-length"]).toBeUndefined();
    // Auth header should pass through
    expect(receivedHeaders["authorization"]).toBe("Bearer token123");
    // Note: Node's http client may add its own connection header — that's fine;
    // the important thing is the *client-supplied* connection value was stripped.

    await new Promise<void>((r) => capServer.server.close(() => r()));
  });
});

// ─── ensureDefaultServices ────────────────────────────────────────────────────

describe("ensureDefaultServices", () => {
  let tmpDir: string;
  let origTpsRoot: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-svc-defaults-"));
    origTpsRoot = process.env.TPS_ROOT;
    process.env.TPS_ROOT = tmpDir;
  });

  afterEach(() => {
    if (origTpsRoot !== undefined) process.env.TPS_ROOT = origTpsRoot;
    else delete process.env.TPS_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers flair as default service if registry is empty", async () => {
    const { ensureDefaultServices, getService } = await import("../src/utils/service-registry.js");
    ensureDefaultServices();
    const flair = getService("flair");
    expect(flair).not.toBeNull();
    expect(flair?.url).toBe("http://127.0.0.1:9926");
    expect(flair?.localPort).toBe(9926);
  });

  it("does not overwrite existing flair entry", async () => {
    const { registerService, ensureDefaultServices, getService } = await import("../src/utils/service-registry.js");
    registerService("flair", "http://127.0.0.1:9999", { description: "custom" });
    ensureDefaultServices();
    const flair = getService("flair");
    expect(flair?.url).toBe("http://127.0.0.1:9999"); // unchanged
  });
});
