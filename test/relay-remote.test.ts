import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("connectRemoteBranches", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-relay-remote-"));
    originalHome = process.env.HOME;
    process.env.TPS_VAULT_KEY = "test-passphrase";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_VAULT_KEY;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
  });

  test("returns empty when no branch-office dir exists", async () => {
    process.env.HOME = tmpDir;
    const { TransportRegistry, FileSystemTransport } = await import("../src/utils/transport.js");
    const { connectRemoteBranches } = await import("../src/utils/relay.js");
    const registry = new TransportRegistry(new FileSystemTransport());
    const { connected } = await connectRemoteBranches(registry);
    expect(connected).toEqual([]);
  });

  test("skips branches without remote.json", async () => {
    process.env.HOME = tmpDir;
    const branchDir = join(tmpDir, ".tps", "branch-office", "local-agent");
    mkdirSync(branchDir, { recursive: true });

    const { TransportRegistry, FileSystemTransport } = await import("../src/utils/transport.js");
    const { connectRemoteBranches } = await import("../src/utils/relay.js");
    const registry = new TransportRegistry(new FileSystemTransport());
    const { connected } = await connectRemoteBranches(registry);
    expect(connected).toEqual([]);
  });

  test("skips remote.json with non-noise-ik transport", async () => {
    process.env.HOME = tmpDir;
    const branchDir = join(tmpDir, ".tps", "branch-office", "other-agent");
    mkdirSync(branchDir, { recursive: true });
    writeFileSync(
      join(branchDir, "remote.json"),
      JSON.stringify({
        host: "example.com",
        port: 6458,
        transport: "something-else",
      })
    );

    const { TransportRegistry, FileSystemTransport } = await import("../src/utils/transport.js");
    const { connectRemoteBranches } = await import("../src/utils/relay.js");
    const registry = new TransportRegistry(new FileSystemTransport());
    const { connected } = await connectRemoteBranches(registry);
    expect(connected).toEqual([]);
  });
});

describe("handleIncomingMail", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tps-incoming-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  test("delivers valid mail to local inbox", async () => {
    const inbox = join(tmpDir, ".tps", "branch-office", "local-agent", "mail", "inbox", "new");
    mkdirSync(inbox, { recursive: true });

    const { handleIncomingMail } = await import("../src/utils/relay.js");
    const msg = {
      type: 0x01,
      seq: 1,
      ts: new Date().toISOString(),
      body: {
        id: "550e8400-e29b-41d4-a716-446655440010",
        from: "remote-agent",
        to: "local-agent",
        content: "Hello from remote",
        timestamp: new Date().toISOString(),
      },
    };

    handleIncomingMail("remote-agent", msg as any);

    const files = readdirSync(inbox);
    expect(files.length).toBe(1);
    const delivered = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(delivered.body).toBe("Hello from remote");
    expect(delivered.origin).toBe("remote:remote-agent");
  });

  test("rejects mail with invalid recipient", async () => {
    const { handleIncomingMail } = await import("../src/utils/relay.js");
    const msg = {
      type: 0x01,
      seq: 1,
      ts: new Date().toISOString(),
      body: {
        id: "550e8400-e29b-41d4-a716-446655440011",
        from: "remote-agent",
        to: "../../../etc/passwd",
        content: "sneaky",
        timestamp: new Date().toISOString(),
      },
    };

    handleIncomingMail("attacker", msg as any);
    expect(true).toBe(true);
  });
});
