import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, registerBranch, saveKeyPair, fingerprint } from "../src/utils/identity.js";
import { WsNoiseTransport } from "../src/utils/ws-noise-transport.js";
import { deliverToRemoteBranch } from "../src/utils/relay.js";
import { MSG_MAIL_DELIVER, MSG_MAIL_ACK } from "../src/utils/wire-mail.js";
import { encodeWireMessage, decodeWireMessage } from "../src/utils/wire-frame.js";
import net from "node:net";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import Noise from "noise-handshake/noise.js";
import Cipher from "noise-handshake/cipher.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.once("error", reject);
  });
}

const PROLOGUE = Buffer.from("tps-v1");

describe("deliverToRemoteBranch", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-mail-remote-"));
    process.env.HOME = root;
    process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
    process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");
    mkdirSync(process.env.TPS_IDENTITY_DIR, { recursive: true });
    mkdirSync(process.env.TPS_REGISTRY_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.TPS_IDENTITY_DIR;
    delete process.env.TPS_REGISTRY_DIR;
  });

  test("connects via WS and delivers MSG_MAIL_DELIVER, receives ACK", async () => {
    const hostKp = generateKeyPair(); // Host's own key
    saveKeyPair(hostKp, process.env.TPS_IDENTITY_DIR!, "host");

    const branchKp = generateKeyPair(); // Remote branch's key

    // 1. Register branch in host's registry
    registerBranch("remote-a", branchKp.signing.publicKey, undefined, branchKp.encryption.publicKey);

    // 2. Mock branch-office/<name>/remote.json
    const port = await freePort();
    const branchOfficeDir = join(root, ".tps", "branch-office", "remote-a");
    mkdirSync(branchOfficeDir, { recursive: true });
    writeFileSync(
      join(branchOfficeDir, "remote.json"),
      JSON.stringify({ host: "127.0.0.1", port, transport: "ws" }),
      "utf-8"
    );

    // 3. Start a server acting as the branch (Noise responder)
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/tps/wire" });
    
    const receivedMail = new Promise<any>((resolve) => {
      wss.on("connection", (ws) => {
        const responder = new Noise("IK", false, {
          publicKey: Buffer.from(branchKp.encryption.publicKey),
          secretKey: Buffer.from(branchKp.encryption.privateKey),
        });
        responder.initialise(PROLOGUE);

        ws.on("message", async (data) => {
          const raw = Buffer.from(data as any);
          if (!responder.rx) {
            // Handshake msg1
            responder.recv(raw);
            const msg2 = Buffer.from(responder.send());
            ws.send(msg2);
            return;
          }

          // Encrypted message
          const decrypted = Buffer.from(new Cipher(responder.rx).decrypt(raw));
          const msg = decodeWireMessage(decrypted);

          if (msg.type === MSG_MAIL_DELIVER) {
            // Send back ACK
            const ack = {
              type: MSG_MAIL_ACK,
              seq: 0,
              ts: new Date().toISOString(),
              body: { id: (msg.body as any).id, accepted: true },
            };
            const encryptedAck = Buffer.from(new Cipher(responder.tx).encrypt(encodeWireMessage(ack)));
            ws.send(encryptedAck);
            resolve(msg.body);
          }
        });
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));

    // 4. Deliver
    await deliverToRemoteBranch("remote-a", {
      to: "remote-a",
      from: "host-agent",
      body: "hello remote",
    });

    const mail = await receivedMail;
    expect(mail.to).toBe("remote-a");
    expect(mail.from).toBe("host-agent");
    expect(mail.content).toBe("hello remote");

    wss.close();
    httpServer.close();
  });

  test("throws if remote.json is missing", async () => {
    await expect(deliverToRemoteBranch("ghost", { to: "ghost", body: "x" })).rejects.toThrow(/No remote.json/);
  });
});
