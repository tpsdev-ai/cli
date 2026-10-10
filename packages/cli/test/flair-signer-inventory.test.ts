/**
 * cli#554 — a production Flair signer with no stub-backed test is a hole.
 * `helpers/flair-signer-scan.ts` lists every occurrence of the `TPS-Ed25519`
 * literal in the packages' src trees, plus every reference to a binding that
 * holds it. Each listed site is either a signer mapped to a test that drives it
 * against `helpers/stub-flair.ts` (which verifies the caller's signature) or an
 * explicit non-signer with a reason. An unclassified site, a stale entry, or a
 * reference the scan cannot resolve fails.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSignerInventory,
  findSignerSites,
  readSources,
  type SignerExclusion,
  scanSources,
  verifyingStubProblem,
} from "./helpers/flair-signer-scan.js";

const REPO = join(import.meta.dir, "..", "..", "..");

/** Each production signer and the test file that drives it against `helpers/stub-flair.ts`. */
const INVENTORY: Record<string, string> = {
  "packages/cli/src/utils/flair-client.ts#FlairClient.sign": "packages/cli/test/mail-flair-read-auth.test.ts",
  "packages/cli/src/commands/init.ts#registerWithFlair": "packages/cli/test/flair-signer-commands.test.ts",
  "packages/cli/src/commands/office-status.ts#makeAuth": "packages/cli/test/office-status.test.ts",
  "packages/cli/src/commands/roster.ts#makeAuth": "packages/cli/test/flair-signer-commands.test.ts",
  "packages/agent/src/io/flair.ts#FlairContextProvider.sign": "packages/cli/test/flair-signer-agent.test.ts",
};

/** Sites that are not Flair signers, each with the reason. */
const NON_SIGNERS: Record<string, SignerExclusion> = {
  "packages/agent/src/llm/provider.ts#ProviderManager.completeViaProxy": {
    reason: "signs an LLM proxy request, not a Flair request",
  },
  "packages/cli/src/bridge/openclaw-adapter.ts#verifyTpsEd25519": {
    reason: "verifier: startsWith/slice on an inbound header",
  },
  "packages/cli/src/bridge/openclaw-adapter.ts#OpenClawAdapter.start": {
    reason: "names the scheme in a 401 error message",
  },
  "packages/cli/src/utils/llm-proxy.ts#verifyRequest": {
    reason: "verifier: startsWith/slice on an inbound header",
  },
};

describe("cli#554 — every TPS-Ed25519 site is classified", () => {
  const scan = findSignerSites(REPO);

  test("the scan finds sites and resolves every reference", () => {
    expect(scan.sites.length).toBeGreaterThan(0);
    for (const site of scan.sites) expect(site.line, site.key).toBeGreaterThan(0);
    expect(scan.unresolved).toEqual([]);
  });

  test("every site is a mapped signer or an explained non-signer, and no entry is stale", () => {
    const result = checkSignerInventory(scan.sites, INVENTORY, NON_SIGNERS);
    expect(result.unmapped).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.staleExclusions).toEqual([]);
  });

  test("each mapped signer names a test file that exists", () => {
    for (const [signer, testFile] of Object.entries(INVENTORY)) {
      expect(existsSync(join(REPO, testFile)), `${signer} -> ${testFile}`).toBe(true);
    }
  });

  test("each mapped signer test drives the verifying stub and asserts a refusal", () => {
    for (const [signer, testFile] of Object.entries(INVENTORY)) {
      const source = readFileSync(join(REPO, testFile), "utf8");
      expect(verifyingStubProblem(testFile, source), signer).toBeNull();
    }
  });

  test("each non-signer has a reason", () => {
    for (const [site, { reason }] of Object.entries(NON_SIGNERS)) expect(reason, site).not.toBeEmpty();
  });
});

describe("cli#554 — the inventory is a live check (mutation on a copy of the sources)", () => {
  const real = readSources(REPO);
  const scanWith = (added: Record<string, string>) => {
    const scan = scanSources({ ...real, ...added });
    return {
      unresolved: scan.unresolved,
      unmapped: checkSignerInventory(scan.sites, INVENTORY, NON_SIGNERS).unmapped,
    };
  };
  const EXTRA = "packages/cli/src/commands/extra.ts";

  test("a template-form signer is unmapped", () => {
    const r = scanWith({
      [EXTRA]: "export function extraSign(a: string) { return `TPS-Ed25519 ${a}:1:n:s`; }",
    });
    expect(r.unmapped).toEqual([`${EXTRA}#extraSign`]);
  });

  test("a concatenation-form signer is unmapped", () => {
    const r = scanWith({
      [EXTRA]: 'export function extraSign(a: string) { return "TPS-Ed25519 " + a; }',
    });
    expect(r.unmapped).toEqual([`${EXTRA}#extraSign`]);
  });

  test("a join-form signer is unmapped", () => {
    const r = scanWith({
      [EXTRA]: 'export function extraSign(a: string) { return ["TPS-Ed25519", a].join(" "); }',
    });
    expect(r.unmapped).toEqual([`${EXTRA}#extraSign`]);
  });

  test("a constant-prefix signer is unmapped, through an alias and a re-export", () => {
    const r = scanWith({
      "packages/cli/src/commands/scheme.ts": 'export const PREFIX = "TPS-Ed25519 ";',
      "packages/cli/src/commands/reexport.ts": 'export { PREFIX as SCHEME } from "./scheme.js";',
      [EXTRA]:
        'import { SCHEME } from "./reexport.js";\nconst P = SCHEME;\nexport function extraSign(a: string) { return P + a; }',
    });
    expect(r.unmapped).toContain(`${EXTRA}#extraSign`);
    expect(r.unmapped).toContain("packages/cli/src/commands/scheme.ts#PREFIX");
  });

  test("a reference the scan cannot resolve fails", () => {
    const r = scanWith({
      "packages/cli/src/commands/scheme.ts": 'export const PREFIX = "TPS-Ed25519 ";',
      [EXTRA]:
        'import { PREFIX } from "./scheme.js";\nexport function extraSign() { const { length } = PREFIX; return length; }',
    });
    expect(r.unresolved).not.toEqual([]);
  });

  test("removing a signer leaves its inventory entry stale", () => {
    const sources = { ...real };
    delete sources["packages/cli/src/commands/roster.ts"];
    const result = checkSignerInventory(scanSources(sources).sites, INVENTORY, NON_SIGNERS);
    expect(result.stale).toEqual(["packages/cli/src/commands/roster.ts#makeAuth"]);
  });

  test("a stale non-signer entry (its site is gone) fails", () => {
    const sources = { ...real };
    delete sources["packages/cli/src/utils/llm-proxy.ts"];
    const result = checkSignerInventory(scanSources(sources).sites, INVENTORY, NON_SIGNERS);
    expect(result.staleExclusions).toEqual(["packages/cli/src/utils/llm-proxy.ts#verifyRequest"]);
  });
});

describe("cli#554 — a mapped test must drive the verifying stub (mutation on a copy of a test)", () => {
  const FILE = "packages/cli/test/flair-signer-agent.test.ts";
  const real = readFileSync(join(REPO, FILE), "utf8");

  test("the real test passes", () => {
    expect(verifyingStubProblem(FILE, real)).toBeNull();
  });

  test("a test on the non-verifying stub fails", () => {
    const source = [
      "import { startUnverifiedFetchFlair } from \"./helpers/fetch-flair.js\";",
      "test(\"x\", async () => { startUnverifiedFetchFlair({}); expect((await fetch(\"http://x\")).status).toBe(403); });",
    ].join("\n");
    expect(verifyingStubProblem(FILE, source)).toContain("imports no verifying helper");
  });

  test("a verifying helper imported from another module fails", () => {
    const source = real.replace("./helpers/stub-flair.js", "./helpers/fetch-flair.js");
    expect(verifyingStubProblem(FILE, source)).toContain("imports no verifying helper");
  });

  test("a verifying helper that is imported but never called fails", () => {
    const source = real.replaceAll("startStubFlair(", "unusedStub(");
    expect(verifyingStubProblem(FILE, source)).toContain("never calls it");
  });

  test("a test with no refusal assertion fails", () => {
    const source = real.replace(/\b(401|403)\b|AccessViolation/g, "200");
    expect(verifyingStubProblem(FILE, source)).toContain("no refusal assertion");
  });

  const IMPORT = 'import { startStubFlair } from "./helpers/stub-flair.js";';
  const body = "{ startStubFlair(); expect(res.status).toBe(403); }";
  const accepted = (wrapper: string) => verifyingStubProblem(FILE, `${IMPORT}\n${wrapper}`);

  test("a stub call and refusal inside a running test are accepted", () => {
    expect(accepted(`test("x", async () => ${body});`)).toBeNull();
    expect(accepted(`describe("s", () => { test("x", async () => ${body}); });`)).toBeNull();
    expect(accepted(`test.skipIf(false)("x", async () => ${body});`)).toBeNull();
  });

  test.each([
    ["test.skip", `test.skip("x", async () => ${body});`],
    ["it.skip", `it.skip("x", async () => ${body});`],
    ["describe.skip", `describe.skip("s", () => { test("x", async () => ${body}); });`],
    ["test.todo", `test.todo("x", async () => ${body});`],
    ["xtest", `xtest("x", async () => ${body});`],
    ["test.skipIf(true)", `test.skipIf(true)("x", async () => ${body});`],
    ["test.skipIf(cond)", `test.skipIf(cond)("x", async () => ${body});`],
    ["test.if(false)", `test.if(false)("x", async () => ${body});`],
  ])("a stub call and refusal inside %s are rejected", (_label, wrapper) => {
    expect(accepted(wrapper)).toContain("outside skipped or unclassifiable tests");
  });

  test("a negated status assertion is not a refusal", () => {
    const source = `${IMPORT}\ntest("x", async () => { startStubFlair(); expect(res.status).not.toBe(403); });`;
    expect(verifyingStubProblem(FILE, source)).toContain("no refusal assertion");
  });
});
