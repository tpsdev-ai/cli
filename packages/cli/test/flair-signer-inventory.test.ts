/**
 * cli#554 — a production Flair signer with no stub-backed test is a hole.
 * `helpers/flair-signer-scan.ts` lists every occurrence of the `TPS-Ed25519`
 * literal in the packages' src trees, plus every reference to a binding that
 * holds it. Each listed site is either a signer mapped to a test that drives it
 * against `helpers/stub-flair.ts` (which verifies the caller's signature) or an
 * explicit non-signer with a reason. An unclassified site, a stale entry, or a
 * reference the scan cannot resolve fails.
 *
 * cli#606: each signer's mapping also names the runtime entry point through
 * which its test reaches it (`roster.ts#makeAuth` is nested in `runDashboard`),
 * and the mapped test must call that entry point, through a value import,
 * inside a `test`/`it` callback that Bun runs, where `test`/`it`/`describe`
 * must be bound to Bun's API (a `bun:test` import or Bun's unshadowed global).
 * The check is lexical; `signerDrivingProblem`'s doc states its limit.
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
  type SignerMapping,
  signerDrivingProblem,
  verifyingStubProblem,
} from "./helpers/flair-signer-scan.js";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * Each production signer, the test file that drives it against
 * `helpers/stub-flair.ts`, and the entry point that test calls to reach it.
 */
const INVENTORY: Record<string, SignerMapping> = {
  "packages/cli/src/utils/flair-client.ts#FlairClient.sign": {
    test: "packages/cli/test/mail-flair-read-auth.test.ts",
    entry: "packages/cli/src/utils/flair-client.ts#FlairClient.getAgentForVerification",
  },
  "packages/cli/src/commands/init.ts#registerWithFlair": {
    test: "packages/cli/test/flair-signer-commands.test.ts",
    entry: "packages/cli/src/commands/init.ts#runInit",
  },
  "packages/cli/src/commands/office-status.ts#makeAuth": {
    test: "packages/cli/test/office-status.test.ts",
    entry: "packages/cli/src/commands/office-status.ts#runOfficeStatus",
  },
  "packages/cli/src/commands/roster.ts#makeAuth": {
    test: "packages/cli/test/flair-signer-commands.test.ts",
    entry: "packages/cli/src/commands/roster.ts#runDashboard",
  },
  "packages/agent/src/io/flair.ts#FlairContextProvider.sign": {
    test: "packages/cli/test/flair-signer-agent.test.ts",
    entry: "packages/agent/src/io/flair.ts#FlairContextProvider.getAgent",
  },
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
    for (const [signer, { test: testFile }] of Object.entries(INVENTORY)) {
      expect(existsSync(join(REPO, testFile)), `${signer} -> ${testFile}`).toBe(true);
    }
  });

  test("each mapped signer test drives the verifying stub and asserts a refusal", () => {
    for (const [signer, { test: testFile }] of Object.entries(INVENTORY)) {
      const source = readFileSync(join(REPO, testFile), "utf8");
      expect(verifyingStubProblem(testFile, source), signer).toBeNull();
    }
  });

  test("each mapped signer's test calls its entry point inside a running test", () => {
    const sources = readSources(REPO);
    for (const [signer, mapping] of Object.entries(INVENTORY)) {
      const source = readFileSync(join(REPO, mapping.test), "utf8");
      expect(signerDrivingProblem(mapping, source, sources), signer).toBeNull();
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

describe("cli#606 — a mapped test must call its signer's entry point (mutation on a test source)", () => {
  const sources = readSources(REPO);
  const DASHBOARD: SignerMapping = {
    test: "packages/cli/test/x.test.ts",
    entry: "packages/cli/src/commands/roster.ts#runDashboard",
  };
  const PROVIDER: SignerMapping = {
    test: "packages/cli/test/x.test.ts",
    entry: "packages/agent/src/io/flair.ts#FlairContextProvider.getAgent",
  };
  const ROSTER = 'import { runDashboard } from "../src/commands/roster.js";';
  const check = (mapping: SignerMapping, source: string) => signerDrivingProblem(mapping, source, sources);

  test("the dashboard signer mapped to a test of another command fails", () => {
    const other = "packages/cli/test/office-status.test.ts";
    const source = readFileSync(join(REPO, other), "utf8");
    expect(check({ ...DASHBOARD, test: other }, source)).toContain("has no value import of runDashboard");
  });

  test("a test that calls another export of the entry's module fails", () => {
    const source = 'import { runDashboard, runRoster } from "../src/commands/roster.js";\ntest("x", () => runRoster({ action: "list" }));';
    expect(check(DASHBOARD, source)).toContain("never calls packages/cli/src/commands/roster.ts#runDashboard inside a running test");
  });

  test.each([
    ["import type", 'import type { runDashboard } from "../src/commands/roster.js";'],
    ["an inline type specifier", 'import { type runDashboard } from "../src/commands/roster.js";'],
    ["import type * as", 'import type * as roster from "../src/commands/roster.js";\nconst runDashboard = roster.runDashboard;'],
  ])("a call through %s fails", (_label, imports) => {
    expect(check(DASHBOARD, `${imports}\ntest("x", () => runDashboard({}));`)).toContain("has no value import of runDashboard");
  });

  test.each([
    ["outside any test", "runDashboard({});"],
    ["in a beforeEach", "beforeEach(() => runDashboard({}));"],
    ["in test.skip", 'test.skip("x", () => runDashboard({}));'],
    ["in test.todo", 'test.todo("x", () => runDashboard({}));'],
    ["in xit", 'xit("x", () => runDashboard({}));'],
    ["in describe.skip", 'describe.skip("s", () => { test("x", () => runDashboard({})); });'],
    ["in test.if(false)", 'test.if(false)("x", () => runDashboard({}));'],
    ["in test.skipIf(cond)", 'test.skipIf(cond)("x", () => runDashboard({}));'],
  ])("a call %s fails", (_label, body) => {
    expect(check(DASHBOARD, `${ROSTER}\n${body}`)).toContain("never calls packages/cli/src/commands/roster.ts#runDashboard inside a running test");
  });

  test.each([
    ["in test", 'test("x", () => runDashboard({}));'],
    ["in it inside describe", 'describe("s", () => { it("x", async () => { await runDashboard({}); }); });'],
    ["in test.skipIf(false)", 'test.skipIf(false)("x", () => runDashboard({}));'],
  ])("a call %s through a value import is accepted", (_label, body) => {
    expect(check(DASHBOARD, `${ROSTER}\n${body}`)).toBeNull();
  });

  test.each([
    ["a local function named test", 'function test(name: string, fn: () => unknown) { void name; void fn; }\ntest("x", () => runDashboard({}));'],
    ["a local arrow named it", 'const it = (name: string, fn: () => unknown) => { void name; void fn; };\nit("x", () => runDashboard({}));'],
    ["a parameter named test", 'export function wrap(test: (name: string, fn: () => unknown) => void) { test("x", () => runDashboard({})); }'],
    ["a test imported from another module", 'import { test } from "./helpers/not-bun.js";\ntest("x", () => runDashboard({}));'],
    ["a bun:test test shadowed by a parameter", 'import { test } from "bun:test";\nexport function wrap(test: (name: string, fn: () => unknown) => void) { test("x", () => runDashboard({})); }'],
    ["an aliased bun:test test.skip", 'import { test as check } from "bun:test";\ncheck.skip("x", () => runDashboard({}));'],
    ["a namespace bun:test test.skip", 'import * as bun from "bun:test";\nbun.test.skip("x", () => runDashboard({}));'],
  ])("a call inside %s is not inside a Bun test, and fails", (_label, body) => {
    const problem = check(DASHBOARD, `${ROSTER}\n${body}`);
    expect(problem).not.toBeNull();
    expect(problem).toContain("never calls packages/cli/src/commands/roster.ts#runDashboard inside a running test");
  });

  test.each([
    ["a named bun:test import", 'import { test } from "bun:test";\ntest("x", () => runDashboard({}));'],
    ["an aliased bun:test import", 'import { test as check } from "bun:test";\ncheck("x", () => runDashboard({}));'],
    ["a namespace bun:test import", 'import * as bun from "bun:test";\nbun.it("x", () => runDashboard({}));'],
  ])("a call inside a test bound through %s is accepted", (_label, body) => {
    expect(check(DASHBOARD, `${ROSTER}\n${body}`)).toBeNull();
  });

  test("a call through a namespace import is accepted", () => {
    const source = 'import * as roster from "../src/commands/roster.js";\ntest("x", () => roster.runDashboard({}));';
    expect(check(DASHBOARD, source)).toBeNull();
  });

  const AGENT = 'import { FlairContextProvider } from "../../agent/src/io/flair.js";';

  test("a method entry called on a constructed instance inside a test is accepted", () => {
    const source = `${AGENT}\ntest("x", () => new FlairContextProvider("a", { url: "u" }).getAgent("b"));`;
    expect(check(PROVIDER, source)).toBeNull();
  });

  test("a method entry reached through a local helper's return value is accepted", () => {
    const source = `${AGENT}\nfunction p(): FlairContextProvider { return new FlairContextProvider("a", { url: "u" }); }\ntest("x", () => p().getAgent("b"));`;
    expect(check(PROVIDER, source)).toBeNull();
  });

  test("a method entry on a class the test never constructs fails", () => {
    const source = `${AGENT}\ndeclare const p: FlairContextProvider;\ntest("x", () => p.getAgent("b"));`;
    expect(check(PROVIDER, source)).toContain("never constructs FlairContextProvider");
  });

  test("calling another method of the entry's class fails", () => {
    const source = `${AGENT}\ntest("x", () => new FlairContextProvider("a", { url: "u" }).ping());`;
    expect(check(PROVIDER, source)).toContain("never calls packages/agent/src/io/flair.ts#FlairContextProvider.getAgent inside a running test");
  });

  test("an entry its module does not export fails", () => {
    const source = `${ROSTER}\ntest("x", () => runDashboard({}));`;
    expect(check({ ...DASHBOARD, entry: "packages/cli/src/commands/roster.ts#makeAuth" }, source)).toContain("does not export makeAuth");
  });
});

describe("cli#606 — the scan reads the packages' .tsx sources", () => {
  test("the source walk reads the repo's .tsx files", () => {
    for (const file of ["packages/cli/src/cli/hire.tsx", "packages/cli/src/cli/roster.tsx"])
      expect(Object.keys(readSources(REPO)), file).toContain(file);
  });

  test("a signer in a .tsx source file is listed", () => {
    const scan = scanSources({
      ...readSources(REPO),
      "packages/cli/src/cli/extra.tsx": "export function extraSign(a: string) { return <p>{`TPS-Ed25519 ${a}`}</p>; }",
    });
    expect(scan.sites.map((s) => s.key)).toContain("packages/cli/src/cli/extra.tsx#extraSign");
  });
});
