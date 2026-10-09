/**
 * cli#554 — the command-level Flair signers. `runInit` registers through
 * `registerWithFlair`, and `runDashboard`'s nested `makeAuth` signs its Agent
 * and OrgEvent reads. Each is driven against the shared verifying stub
 * (`helpers/stub-flair.ts`): the stub accepts a request signed by a caller it
 * knows and refuses one it does not, exactly as real Flair does.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.js";
import { runDashboard } from "../src/commands/roster.js";
import { pubkeyFromSeed, startStubFlair, type StubFlair } from "./helpers/stub-flair.js";

const SEED = Buffer.alloc(32, 0x51);

let root: string;
let savedHome: string | undefined;
let savedAgentId: string | undefined;
let logs: string[];
let savedLog: typeof console.log;
let savedError: typeof console.error;
let savedStdout: typeof process.stdout.write;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli554-signers-"));
  savedHome = process.env.HOME;
  savedAgentId = process.env.TPS_AGENT_ID;
  process.env.HOME = root;
  delete process.env.TPS_AGENT_ID;
  logs = [];
  savedLog = console.log;
  savedError = console.error;
  savedStdout = process.stdout.write;
  console.log = ((...args: unknown[]) => { logs.push(args.join(" ")); }) as typeof console.log;
  console.error = ((...args: unknown[]) => { logs.push("[ERR] " + args.join(" ")); }) as typeof console.error;
  process.stdout.write = ((chunk: string) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
});

afterEach(() => {
  console.log = savedLog;
  console.error = savedError;
  process.stdout.write = savedStdout;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedAgentId === undefined) delete process.env.TPS_AGENT_ID;
  else process.env.TPS_AGENT_ID = savedAgentId;
  rmSync(root, { recursive: true, force: true });
});

/** A 32-byte seed file plus the `.pub` hex the registration body reads. */
afterEach(() => {
  mock.restore();
});

function seedKeyFile(agentId: string): void {
  const dir = join(root, ".tps", "identity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.key`), SEED);
  writeFileSync(join(dir, `${agentId}.pub`), pubkeyFromSeed(SEED).toString("hex"));
}

describe("cli#554 — runInit registers signed with Flair", () => {
  /** The route Flair serves for the identity registration the signer posts. */
  const identityRoute = (req: Request, url: URL) =>
    req.method === "POST" && url.pathname === "/Identity" ? new Response(null, { status: 201 }) : undefined;

  test("a caller the stub knows is registered", async () => {
    const stub: StubFlair = startStubFlair({ "agent-a": SEED }, identityRoute);
    try {
      seedKeyFile("agent-a");
      await runInit({ agentId: "agent-a", flairUrl: stub.url });
      expect(logs.join("\n")).toContain("registered");
      expect(logs.join("\n")).not.toContain("skipped");
    } finally {
      stub.stop();
    }
  });

  test("a caller the stub does not know is refused and reported as skipped", async () => {
    const stub = startStubFlair({}, identityRoute);
    try {
      seedKeyFile("agent-b");
      await runInit({ agentId: "agent-b", flairUrl: stub.url });
      expect(logs.join("\n")).toContain("skipped");
      expect(logs.join("\n")).not.toContain("registered");
    } finally {
      stub.stop();
    }
  });
});

describe("cli#554 — runDashboard signs its Flair reads", () => {
  function routes(req: Request, url: URL): Response | undefined {
    if (req.method === "GET" && url.pathname === "/Agent/") return Response.json([{ id: "ember", name: "Ember" }]);
    if (req.method === "GET" && url.pathname.startsWith("/OrgEventCatchup/")) return Response.json([]);
    return undefined;
  }

  test("a signed viewer's reads are answered", async () => {
    const stub = startStubFlair({ "viewer-a": SEED }, routes);
    try {
      const keyPath = join(root, "viewer-a.key");
      writeFileSync(keyPath, SEED);
      await expect(runDashboard({ flairUrl: stub.url, agentId: "viewer-a", keyPath })).resolves.toBeUndefined();
      expect(logs.join("\n")).toContain("ember");
    } finally {
      stub.stop();
    }
  });

  test("a viewer with no key sends no Authorization and the read is refused", async () => {
    const savedExit = process.exit;
    process.exit = mock(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit);
    const stub = startStubFlair({ "viewer-a": SEED }, routes);
    try {
      await expect(
        runDashboard({ flairUrl: stub.url, agentId: "viewer-a", keyPath: "/nonexistent" }),
      ).rejects.toThrow("exit:1");
      expect(logs.join("\n")).toContain(`Cannot reach Flair at ${stub.url} (HTTP 403)`);
    } finally {
      stub.stop();
      process.exit = savedExit;
    }
  });
});
