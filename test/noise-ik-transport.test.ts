import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, registerBranch } from "../src/utils/identity.js";
import { NoiseIkTransport } from "../src/utils/noise-ik-transport.js";
import { WireDeliveryTransport } from "../src/utils/wire-delivery.js";
import { MailDeliverBodySchema, MSG_MAIL_ACK, MSG_MAIL_DELIVER } from "../src/utils/wire-mail.js";

describe("NoiseIkTransport", () => {
  let root: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-noise-ik-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = root;
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("handshake + encrypted mail delivery", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch1", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const serverTransport = new NoiseIkTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    server.onConnection((channel) => {
      channel.onMessage((msg) => {
        if (msg.type === MSG_MAIL_DELIVER) {
          const body = MailDeliverBodySchema.parse(msg.body);
          channel.send({
            type: MSG_MAIL_ACK,
            seq: 0,
            ts: new Date().toISOString(),
            body: { id: body.id, accepted: true },
          });
        }
      });
    });

    const clientTransport = new NoiseIkTransport(branch);
    const channel = await clientTransport.connect({
      host: "127.0.0.1",
      port,
      branchId: "branch1",
      hostPublicKey: host.encryption.publicKey,
    });

    const delivery = new WireDeliveryTransport(channel, 5000);
    const result = await delivery.deliver({
      from: "test-branch",
      to: "test-host",
      body: Buffer.from("secret message over encrypted channel"),
      headers: {},
    });

    expect(result.delivered).toBe(true);
    expect(result.transport).toBe("wire");

    await channel.close();
    await server.close();
  });

  test("rejects unknown branch", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();

    const serverTransport = new NoiseIkTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const clientTransport = new NoiseIkTransport(branch);
    await expect(
      clientTransport.connect({
        host: "127.0.0.1",
        port,
        branchId: "unknown-branch",
        hostPublicKey: host.encryption.publicKey,
      })
    ).rejects.toThrow();

    await server.close();
  });

  test("rejects wrong host key", async () => {
    const host = generateKeyPair();
    const wrongHost = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch2", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const serverTransport = new NoiseIkTransport(branch, host);
    const server = await serverTransport.listen(0);
    const port = (server as any).port();

    const clientTransport = new NoiseIkTransport(branch);
    await expect(
      clientTransport.connect({
        host: "127.0.0.1",
        port,
        branchId: "branch2",
        hostPublicKey: wrongHost.encryption.publicKey,
      })
    ).rejects.toThrow();

    await server.close();
  });

  test("data is encrypted on the wire", async () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    registerBranch("branch3", branch.signing.publicKey, undefined, branch.encryption.publicKey);

    const serverTransport = new NoiseIkTransport(branch, host);
    const server = await serverTransport.listen(0);
    const realPort = (server as any).port();

    const captured: Buffer[] = [];

    const proxy = net.createServer((clientSock) => {
      const serverSock = net.createConnection({ host: "127.0.0.1", port: realPort });
      clientSock.on("data", (d) => {
        captured.push(d);
        serverSock.write(d);
      });
      serverSock.on("data", (d) => {
        captured.push(d);
        clientSock.write(d);
      });
      clientSock.on("close", () => serverSock.end());
      serverSock.on("close", () => clientSock.end());
    });

    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxy.address() as any).port;

    server.onConnection((ch) => {
      ch.onMessage((msg) => {
        if (msg.type === MSG_MAIL_DELIVER) {
          const id = (msg.body as any).id;
          ch.send({
            type: MSG_MAIL_ACK,
            seq: 0,
            ts: new Date().toISOString(),
            body: { id, accepted: true },
          });
        }
      });
    });

    const clientTransport = new NoiseIkTransport(branch);
    const channel = await clientTransport.connect({
      host: "127.0.0.1",
      port: proxyPort,
      branchId: "branch3",
      hostPublicKey: host.encryption.publicKey,
    });

    const secretMessage = "this-should-not-appear-in-plaintext-on-the-wire";
    const result = await new WireDeliveryTransport(channel, 5000).deliver({
      from: "test-branch",
      to: "test-host",
      body: Buffer.from(secretMessage),
      headers: {},
    });

    expect(result.delivered).toBe(true);
    const allBytes = Buffer.concat(captured).toString("utf-8");
    expect(allBytes).not.toContain(secretMessage);

    await channel.close();
    await server.close();
    await new Promise<void>((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
  });
});
