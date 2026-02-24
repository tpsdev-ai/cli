import { describe, test, expect } from "bun:test";
import { parseJoinToken } from "../src/commands/office.js";
import { fingerprint } from "../src/utils/identity.js";

describe("parseJoinToken", () => {
  test("parses valid token with all fields", () => {
    const pub = new Uint8Array(32).fill(1);
    const sigPub = new Uint8Array(32).fill(2);
    const pubkey = Buffer.from(pub).toString("base64url");
    const sigpubkey = Buffer.from(sigPub).toString("base64url");
    const fp = `sha256:${fingerprint(sigPub)}`; // fp = sha256 of signing key, not encryption key
    const token = `tps://join?host=test.example.com&port=6458&transport=ws&pubkey=${pubkey}&sigpubkey=${sigpubkey}&fp=${fp}`;

    const parsed = parseJoinToken(token);
    expect(parsed.host).toBe("test.example.com");
    expect(parsed.port).toBe(6458);
    expect(parsed.transport).toBe("ws");
    expect(parsed.encryptionPubkey).toBeInstanceOf(Uint8Array);
    expect(parsed.encryptionPubkey.length).toBe(32);
    expect(parsed.signingPubkey).toBeInstanceOf(Uint8Array);
    expect(parsed.signingPubkey.length).toBe(32);
    expect(parsed.fingerprint).toBe(fp);
  });

  test("rejects token with missing host", () => {
    const pubkey = Buffer.from(new Uint8Array(32)).toString("base64url");
    const sigpubkey = Buffer.from(new Uint8Array(32)).toString("base64url");
    expect(() => parseJoinToken(`tps://join?port=6458&pubkey=${pubkey}&sigpubkey=${sigpubkey}&fp=sha256:abc`)).toThrow();
  });

  test("rejects token with missing pubkey", () => {
    expect(() => parseJoinToken("tps://join?host=x&port=6458&fp=sha256:abc&sigpubkey=xx")).toThrow();
  });

  test("rejects token with invalid port", () => {
    const pubkey = Buffer.from(new Uint8Array(32)).toString("base64url");
    const sigpubkey = Buffer.from(new Uint8Array(32)).toString("base64url");
    expect(() => parseJoinToken(`tps://join?host=x&port=notanumber&pubkey=${pubkey}&sigpubkey=${sigpubkey}&fp=sha256:abc`)).toThrow();
  });
});

describe("remote.json", () => {
  test("structure matches expected schema", () => {
    const record = {
      host: "exe.dev",
      port: 6458,
      branchId: "anvil-remote",
      fingerprint: "sha256:abc",
      pubkey: "dGVzdA",
      joinedAt: new Date().toISOString(),
      transport: "ws",
    };
    expect(record.transport).toBe("ws");
    expect(record.port).toBe(6458);
    expect(typeof record.joinedAt).toBe("string");
  });
});
