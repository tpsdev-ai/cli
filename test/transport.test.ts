import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystemTransport, type DeliveryTransport, TransportRegistry, resolveTransport } from "../src/utils/transport.js";

describe("transport", () => {
  let root: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-transport-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = join(root, ".tps", "mail");
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_MAIL_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("filesystem transport delivers to recipient inbox", async () => {
    const t = new FileSystemTransport();
    const res = await t.deliver({
      from: "container:brancha",
      to: "kern",
      body: Buffer.from("hello", "utf-8"),
      headers: {
        "x-tps-id": "msg-1",
        "x-tps-timestamp": new Date().toISOString(),
        "x-tps-origin": "docker-sandbox",
      },
    });

    expect(res.delivered).toBe(true);
    expect(res.transport).toBe("filesystem");

    const inbox = join(root, ".tps", "mail", "kern", "new");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const delivered = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(delivered.from).toBe("container:brancha");
    expect(delivered.to).toBe("kern");
    expect(delivered.body).toBe("hello");
    expect(delivered.origin).toBe("docker-sandbox");
  });

  test("filesystem transport name", () => {
    const t = new FileSystemTransport();
    expect(t.name()).toBe("filesystem");
  });
});

describe("TransportRegistry", () => {
  const mockTransport = (name: string): DeliveryTransport => ({
    name: () => name,
    deliver: async () => ({ delivered: true, transport: name }),
  });

  test("resolve returns default when no per-branch registered", () => {
    const defaultT = mockTransport("default");
    const registry = new TransportRegistry(defaultT);
    expect(registry.resolve("unknown-branch").name()).toBe("default");
  });

  test("resolve returns registered transport for known branch", () => {
    const defaultT = mockTransport("default");
    const wireT = mockTransport("wire");
    const registry = new TransportRegistry(defaultT);
    registry.register("remote-1", wireT);
    expect(registry.resolve("remote-1").name()).toBe("wire");
  });

  test("resolve still returns default for unregistered branches", () => {
    const defaultT = mockTransport("default");
    const wireT = mockTransport("wire");
    const registry = new TransportRegistry(defaultT);
    registry.register("remote-1", wireT);
    expect(registry.resolve("local-1").name()).toBe("default");
  });

  test("unregister falls back to default", () => {
    const defaultT = mockTransport("default");
    const wireT = mockTransport("wire");
    const registry = new TransportRegistry(defaultT);
    registry.register("remote-1", wireT);
    registry.unregister("remote-1");
    expect(registry.resolve("remote-1").name()).toBe("default");
  });

  test("has returns true for registered, false for unregistered", () => {
    const registry = new TransportRegistry(mockTransport("default"));
    registry.register("remote-1", mockTransport("wire"));
    expect(registry.has("remote-1")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
  });

  test("multiple branches can have different transports", () => {
    const registry = new TransportRegistry(mockTransport("fs"));
    registry.register("remote-1", mockTransport("wire-1"));
    registry.register("remote-2", mockTransport("wire-2"));
    expect(registry.resolve("remote-1").name()).toBe("wire-1");
    expect(registry.resolve("remote-2").name()).toBe("wire-2");
    expect(registry.resolve("local").name()).toBe("fs");
  });

  test("resolveTransport function delegates to registry", () => {
    const registry = new TransportRegistry(mockTransport("fs"));
    registry.register("remote-1", mockTransport("wire"));
    expect(resolveTransport("remote-1", registry).name()).toBe("wire");
    expect(resolveTransport("local", registry).name()).toBe("fs");
  });
});
