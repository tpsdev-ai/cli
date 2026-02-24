import { describe, it, expect } from "bun:test";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import { generateKeyPair } from "../src/utils/identity.js";

describe("Noise_IK handshake with TPS keys", () => {
  it("completes handshake and produces session keys", () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();

    const prologue = Buffer.from("tps-v1");

    const hostStatic = {
      publicKey: Buffer.from(host.encryption.publicKey),
      secretKey: Buffer.from(host.encryption.privateKey),
    };

    const branchStatic = {
      publicKey: Buffer.from(branch.encryption.publicKey),
      secretKey: Buffer.from(branch.encryption.privateKey),
    };

    const initiator = new Noise("IK", true, branchStatic);
    const responder = new Noise("IK", false, hostStatic);

    initiator.initialise(prologue, hostStatic.publicKey);
    responder.initialise(prologue);

    const branchId = "test-branch-001";
    const msg1 = initiator.send(Buffer.from(branchId));

    const payload = responder.recv(msg1);
    expect(payload.toString()).toBe(branchId);

    expect(Buffer.from(responder.rs)).toEqual(branchStatic.publicKey);

    const msg2 = responder.send();
    initiator.recv(msg2);

    expect(initiator.complete).toBe(true);
    expect(responder.complete).toBe(true);

    expect(initiator.tx).toBeTruthy();
    expect(initiator.rx).toBeTruthy();
    expect(Buffer.from(initiator.tx)).toEqual(Buffer.from(responder.rx));
    expect(Buffer.from(initiator.rx)).toEqual(Buffer.from(responder.tx));

    const sendCipher = new Cipher(initiator.tx);
    const recvCipher = new Cipher(responder.rx);

    const plaintext = Buffer.from("hello from branch");
    const encrypted = sendCipher.encrypt(plaintext);
    const decrypted = recvCipher.decrypt(encrypted);

    expect(decrypted).toEqual(plaintext);
    expect(encrypted).not.toEqual(plaintext);
  });

  it("rejects wrong host key", () => {
    const host = generateKeyPair();
    const branch = generateKeyPair();
    const wrongHost = generateKeyPair();

    const prologue = Buffer.from("tps-v1");

    const initiator = new Noise("IK", true, {
      publicKey: Buffer.from(branch.encryption.publicKey),
      secretKey: Buffer.from(branch.encryption.privateKey),
    });

    initiator.initialise(prologue, Buffer.from(wrongHost.encryption.publicKey));

    const responder = new Noise("IK", false, {
      publicKey: Buffer.from(host.encryption.publicKey),
      secretKey: Buffer.from(host.encryption.privateKey),
    });
    responder.initialise(prologue);

    const msg1 = initiator.send(Buffer.from("branch-1"));

    expect(() => responder.recv(msg1)).toThrow();
  });
});
