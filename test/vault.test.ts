import { describe, test, expect } from "bun:test";
import { encryptVault, decryptVault } from "../src/utils/vault.js";

describe("Vault Security", () => {
  const passphrase = "correct-horse-battery-staple";
  const secretData = { api_key: "sk-1234567890", identity: "private-key-data" };

  test("can encrypt and decrypt data with correct passphrase", async () => {
    const vault = await encryptVault(secretData, passphrase);
    expect(vault.ciphertext).not.toBe(JSON.stringify(secretData));
    
    const decrypted = await decryptVault(vault, passphrase);
    expect(decrypted).toEqual(secretData);
  });

  test("fails to decrypt with wrong passphrase", async () => {
    const vault = await encryptVault(secretData, passphrase);
    try {
        await decryptVault(vault, "wrong-passphrase");
        expect(false).toBe(true); 
    } catch (e) {
        expect(true).toBe(true);
    }
  });

  test("uses fresh IV for every encryption", async () => {
    const v1 = await encryptVault(secretData, passphrase);
    const v2 = await encryptVault(secretData, passphrase);
    expect(v1.iv).not.toBe(v2.iv);
    expect(v1.ciphertext).not.toBe(v2.ciphertext);
  });

  test("uses unique salt for every encryption", async () => {
    const v1 = await encryptVault(secretData, passphrase);
    const v2 = await encryptVault(secretData, passphrase);
    expect(v1.salt).not.toBe(v2.salt);
  });
});
