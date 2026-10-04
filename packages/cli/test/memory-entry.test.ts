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

  test("search propagates a SemanticSearch refusal as a non-zero exit with no results output", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-entry-"));
    try {
      const identity = join(home, ".tps", "identity");
      mkdirSync(identity, { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      writeFileSync(join(identity, "operator.key"), privateKey, { mode: 0o600 });
      const preload = join(home, "fetch.mjs");
      // Model SemanticSearch: a non-admin search whose body agentId differs from
      // the authenticated (signing) principal is refused 403.
      writeFileSync(preload, `globalThis.fetch = async (url, options) => {
        const principal = String(options.headers.Authorization || "").split(" ")[1]?.split(":")[0];
        const target = JSON.parse(options.body).agentId;
        if (target !== principal) {
          return new Response(JSON.stringify({ error: "forbidden: agentId must match authenticated agent" }), { status: 403 });
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };`);
      const result = spawnSync(
        "node",
        ["--import", preload, bin, "memory", "search", "target-a", "hello", "--flair-url", "http://example.invalid"],
        { env: { ...process.env, HOME: home, TPS_AGENT_ID: "operator" }, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("forbidden: agentId must match authenticated agent");
      expect(result.stdout.trim()).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("archive propagates a Memory.patch refusal as a non-zero exit with no success output", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-entry-"));
    try {
      const identity = join(home, ".tps", "identity");
      mkdirSync(identity, { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      writeFileSync(join(identity, "operator.key"), privateKey, { mode: 0o600 });
      const preload = join(home, "fetch.mjs");
      // Model Memory.patch's skill-write path rejection: a patch to a row whose
      // stored tags include `skill` is refused.
      writeFileSync(preload, `globalThis.fetch = async (url, options) => {
        if (options.method === "GET") {
          return new Response(JSON.stringify({ id: "m1", agentId: "operator", content: "a skill", tags: ["skill"] }), { status: 200 });
        }
        if (options.method === "PATCH") {
          return new Response(JSON.stringify({ error: "skill_write_path", message: "skill memories must be written via skill_store (or Memory post/put); this path does not gate skill writes" }), { status: 400 });
        }
        return new Response("{}", { status: 200 });
      };`);
      const result = spawnSync(
        "node",
        ["--import", preload, bin, "memory", "archive", "m1", "--flair-url", "http://example.invalid"],
        { env: { ...process.env, HOME: home, TPS_AGENT_ID: "operator" }, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("skill_write_path");
      expect(result.stdout.trim()).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
