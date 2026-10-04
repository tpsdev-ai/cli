import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve(import.meta.dir, "../dist/bin/tps.js");
const actions = ["review", "approve", "reject", "archive", "unarchive", "purge", "list", "show", "search"];

describe("memory CLI entry", () => {
  for (const action of actions) {
    test(`${action} refuses without an operator identity`, () => {
      const home = mkdtempSync(join(tmpdir(), "memory-entry-"));
      try {
        const env = { ...process.env, HOME: home };
        delete env.TPS_AGENT_ID;
        const result = spawnSync("node", [bin, "memory", action, ...(["review", "list", "search"].includes(action) ? [] : ["m1"])], { env, encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no memory operator id");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("archive reads first, then PATCHes the governance fields as the configured operator", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-entry-"));
    try {
      const identity = join(home, ".tps", "identity");
      mkdirSync(identity, { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      writeFileSync(join(identity, "operator.key"), privateKey, { mode: 0o600 });
      const preload = join(home, "fetch.mjs");
      writeFileSync(preload, `globalThis.fetch = async (url, options) => {
        if (options.method === "GET") {
          return new Response(JSON.stringify({ id: "m1", agentId: "operator", content: "keep this" }), { status: 200 });
        }
        console.log(JSON.stringify({ url, method: options.method, body: JSON.parse(options.body), headers: options.headers }));
        return new Response("{}", { status: 200 });
      };`);
      const result = spawnSync("node", ["--import", preload, bin, "memory", "archive", "m1", "--flair-url", "http://example.invalid"], {
        env: { ...process.env, HOME: home, TPS_AGENT_ID: "operator" }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(0);
      const request = JSON.parse(result.stdout.split("\n")[0]);
      expect(request.url).toBe("http://example.invalid/Memory/m1");
      expect(request.method).toBe("PATCH");
      expect(Object.keys(request.body).sort()).toEqual(["archived", "archivedAt", "archivedBy"]);
      expect(request.body.archived).toBe(true);
      expect(request.body.archivedBy).toBe("operator");
      expect(request.headers.Authorization).toStartWith("TPS-Ed25519 operator:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
