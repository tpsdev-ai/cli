/**
 * cli#554 — a production Flair signer with no stub-backed test is a hole.
 * `helpers/flair-signer-scan.ts` finds every production signing path in the
 * packages' src trees; this inventory fails when the scan finds a signer that
 * no test file is mapped to, and when a mapped signer no longer exists. See
 * `helpers/stub-flair.ts` for the stub each mapped test drives its signer
 * through (it verifies the caller's TPS-Ed25519 signature).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeSignerSource,
  checkSignerInventory,
  findSignerSites,
  type SignerSite,
} from "./helpers/flair-signer-scan.js";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * Each production signer and the test file that drives it against
 * `helpers/stub-flair.ts`, asserting an accepted signed request and a refused
 * one.
 */
const INVENTORY: Record<string, string> = {
  "packages/cli/src/utils/flair-client.ts#FlairClient.sign": "packages/cli/test/mail-flair-read-auth.test.ts",
  "packages/cli/src/commands/init.ts#registerWithFlair": "packages/cli/test/flair-signer-commands.test.ts",
  "packages/cli/src/commands/office-status.ts#makeAuth": "packages/cli/test/office-status.test.ts",
  "packages/cli/src/commands/roster.ts#makeAuth": "packages/cli/test/flair-signer-commands.test.ts",
  "packages/agent/src/io/flair.ts#FlairContextProvider.sign": "packages/cli/test/flair-signer-agent.test.ts",
};

/** Signed requests that are not Flair requests, with the reason each is out of scope. */
const EXCLUDED: Record<string, string> = {
  "packages/agent/src/llm/provider.ts#ProviderManager.completeViaProxy":
    "signs an LLM proxy request, not a Flair request",
};

describe("cli#554 — every Flair signer is mapped to a stub-backed test", () => {
  const sites = findSignerSites(REPO);

  test("the scan finds signing sites and locates each", () => {
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(site.line, site.key).toBeGreaterThan(0);
  });

  test("every signer is mapped or excluded, and no entry is stale", () => {
    const result = checkSignerInventory(sites, INVENTORY, EXCLUDED);
    expect(result.unmapped).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.staleExclusions).toEqual([]);
  });

  test("each mapped signer names a test file that exists", () => {
    for (const [signer, testFile] of Object.entries(INVENTORY)) {
      expect(signer).not.toBeEmpty();
      expect(existsSync(join(REPO, testFile)), `${signer} -> ${testFile}`).toBe(true);
    }
  });
});

describe("cli#554 — the inventory is a live check (mutation on a copy)", () => {
  test("a new signing call site is unmapped and fails the inventory", () => {
    const added = analyzeSignerSource(
      "packages/cli/src/commands/extra.ts",
      "export function extraSign(a: string) { return `TPS-Ed25519 ${a}:1:n:s`; }",
    );
    expect(added.map((s) => s.key)).toEqual(["packages/cli/src/commands/extra.ts#extraSign"]);
    const result = checkSignerInventory([...findSignerSites(REPO), ...added], INVENTORY, EXCLUDED);
    expect(result.unmapped).toEqual(["packages/cli/src/commands/extra.ts#extraSign"]);
  });

  test("removing a signer leaves its inventory entry stale and fails", () => {
    const sites = findSignerSites(REPO);
    const removed = sites.find((s) => s.key.endsWith("#makeAuth"));
    expect(removed).toBeDefined();
    const without: SignerSite[] = sites.filter((s) => s.key !== removed!.key);
    const result = checkSignerInventory(without, INVENTORY, EXCLUDED);
    expect(result.stale).toEqual([removed!.key]);
  });

  test("a verifier's plain-string header prefix is not a signer", () => {
    const verifier = analyzeSignerSource(
      "packages/cli/src/utils/check.ts",
      'export function check(h: string) { return h.startsWith("TPS-Ed25519 "); }',
    );
    expect(verifier).toEqual([]);
  });

  test("a stale exclusion (its site is gone) fails the inventory", () => {
    const sites = findSignerSites(REPO).filter(
      (s) => s.key !== "packages/agent/src/llm/provider.ts#ProviderManager.completeViaProxy",
    );
    const result = checkSignerInventory(sites, INVENTORY, EXCLUDED);
    expect(result.staleExclusions).toEqual(["packages/agent/src/llm/provider.ts#ProviderManager.completeViaProxy"]);
  });
});
