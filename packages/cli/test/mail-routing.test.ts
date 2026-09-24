/**
 * mail-routing.test.ts — cli#389: the ONE locality decision, and the two
 * callers that must agree on it — `resolveMailRoute` (used by the
 * openclaw-tps-mail plugin) and `tps mail send`.
 *
 * Table: branch → bound local / else outbox; office → GAL+remote.json remote;
 * GAL WITHOUT remote.json a named failure (gal-without-remote), never a
 * fall-through to a maildir; a recipient addressed by its OWN branch id
 * (remote.json under the name, no GAL) still remote; a branch-office inbox
 * (no remote.json) the bridge; else local (binding/maildir) or unknown.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const FLINT_SEED = Buffer.alloc(32, 0x01);

let root: string;
let mailDir: string;
let savedHome: string | undefined;
let savedMail: string | undefined;

function branchHost(): void {
  mkdirSync(join(root, ".tps", "identity"), { recursive: true });
  writeFileSync(join(root, ".tps", "identity", "host.json"), "{}\n", "utf-8");
}
function maildirFor(a: string): void {
  mkdirSync(join(mailDir, a, "new"), { recursive: true });
}
function galEntry(agentId: string, branchId: string): void {
  mkdirSync(join(root, ".tps"), { recursive: true });
  writeFileSync(
    join(root, ".tps", "gal.json"),
    JSON.stringify({ version: 1, entries: [{ agentId, branchId, updatedAt: new Date().toISOString() }] }),
    "utf-8",
  );
}
function remoteBranch(b: string): void {
  mkdirSync(join(root, ".tps", "branch-office", b), { recursive: true });
  writeFileSync(join(root, ".tps", "branch-office", b, "remote.json"), JSON.stringify({ host: "127.0.0.1", port: 1, transport: "ws" }), "utf-8");
}
function branchInbox(b: string): void {
  mkdirSync(join(root, ".tps", "branch-office", b, "mail", "inbox"), { recursive: true });
}
function countJson(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-routing-"));
  mailDir = join(root, "mail");
  mkdirSync(mailDir, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = root;
  savedMail = process.env.TPS_MAIL_DIR;
  process.env.TPS_MAIL_DIR = mailDir;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedMail === undefined) delete process.env.TPS_MAIL_DIR;
  else process.env.TPS_MAIL_DIR = savedMail;
  rmSync(root, { recursive: true, force: true });
});

const { resolveMailRoute } = await import("../src/utils/mail-routing.js");

describe("resolveMailRoute — the shared table (cli#389)", () => {
  test("branch: bound → local, everything else → outbox (directory existence ignored)", () => {
    branchHost();
    maildirFor("flint");
    expect(resolveMailRoute({ to: "flint", mailDir, localAgents: ["anvil"] }).kind).toBe("outbox");
    expect(resolveMailRoute({ to: "anvil", mailDir, localAgents: ["anvil"] }).kind).toBe("local");
  });

  test("office: GAL + remote.json → remote-branch (a maildir does not change it)", () => {
    galEntry("rockit", "tps-rockit");
    remoteBranch("tps-rockit");
    maildirFor("rockit");
    expect(resolveMailRoute({ to: "rockit", mailDir, localAgents: [] }).kind).toBe("remote-branch");
  });

  test("office: GAL with NO remote.json → failed(gal-without-remote), whatever maildirs exist", () => {
    galEntry("sherlock", "tps-sherlock");
    maildirFor("sherlock");
    const r = resolveMailRoute({ to: "sherlock", mailDir, localAgents: [] });
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" ? r.reason : null).toBe("gal-without-remote");
  });

  test("office: remote.json under the recipient's OWN name (no GAL) → remote-branch", () => {
    remoteBranch("tps-rockit");
    expect(resolveMailRoute({ to: "tps-rockit", mailDir, localAgents: [] }).kind).toBe("remote-branch");
  });

  test("office: a branch-office inbox with no remote.json → bridge", () => {
    branchInbox("ember");
    expect(resolveMailRoute({ to: "ember", mailDir, localAgents: [] }).kind).toBe("bridge");
  });

  test("office: a binding or a maildir → local; otherwise → unknown", () => {
    maildirFor("flint");
    expect(resolveMailRoute({ to: "flint", mailDir, localAgents: [] }).kind).toBe("local");
    expect(resolveMailRoute({ to: "kern", mailDir, localAgents: ["kern"] }).kind).toBe("local");
    expect(resolveMailRoute({ to: "stranger", mailDir, localAgents: [] }).kind).toBe("unknown");
  });
});

// ── the CLI caller: `tps mail send` must make the SAME decision ──────────────

function runMailSend(args: string[]): ReturnType<typeof spawnSync> {
  const keysDir = join(root, "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, "flint.key"), FLINT_SEED);
  return spawnSync("bun", [TPS_BIN, "mail", "send", ...args], {
    encoding: "utf-8",
    cwd: tmpdir(),
    env: { ...process.env, HOME: root, TPS_MAIL_DIR: mailDir, TPS_AGENT_ID: "flint", TPS_TEST_KEYS_DIR: keysDir },
  });
}

describe("tps mail send — the CLI caller (cli#389)", () => {
  test("GAL without remote.json: exits NON-ZERO with the named failure and writes nothing", () => {
    galEntry("sherlock", "tps-sherlock");
    maildirFor("sherlock"); // a maildir must NOT make it fall through to a local write
    const res = runMailSend(["sherlock", "hello"]);
    expect(res.status).not.toBe(0);
    expect(`${res.stderr ?? ""}${res.stdout ?? ""}`).toContain("gal-without-remote");
    expect(countJson(join(mailDir, "sherlock", "new"))).toBe(0);
  });

  test("branch-office inbox with no remote.json: bridges via deliverToSandbox", () => {
    branchInbox("ember");
    const res = runMailSend(["ember", "hello"]);
    expect(res.status).toBe(0);
    // deliverToSandbox writes to the branch mail root's new/.
    expect(countJson(join(root, ".tps", "branch-office", "ember", "mail", "new"))).toBeGreaterThan(0);
  });
});
