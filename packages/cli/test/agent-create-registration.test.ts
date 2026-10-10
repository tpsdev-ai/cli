import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
/**
 * cli#512 — `tps agent create` reports registration only when Flair reads the
 * generated key back equal. These tests drive the create path against a fake
 * Flair: signed calls reach the shared verifying stub (cli#554), and the
 * operator-credentialed calls the create flow makes — the Agent PUT and the
 * read-back GET, both Basic — reach a route this file controls. Each failure
 * branch (refused write, no row, `pending` stored, mismatch, failed read) and
 * the success branch is covered; the real-Harper case runs under
 * TPS_TEST_REAL_FLAIR=1.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/commands/agent.js";
import { stubFlairHandler } from "./helpers/stub-flair.js";

const AGENT = "create-registration-agent";

// cli#555: a file that names `spyOn` carries the top-level teardown; each
// runCreate restores its own spies in a finally as well.
afterEach(() => {
  mock.restore();
});

interface FakeFlair {
  url: string;
  stop(): void;
}

/**
 * A fake Flair. A request carrying a TPS-Ed25519 header reaches the shared
 * verifying stub with no registered signers — so a fresh agent's own signed
 * read (getAgent) and seed (AgentSeed) are refused 401 `unknown_agent`, exactly
 * as a real Flair refuses an unregistered caller. A request carrying Basic
 * reaches `basic` (the Agent PUT and the read-back GET).
 */
function startFakeFlair(basic: (req: Request, url: URL) => Promise<Response | undefined>): FakeFlair {
  const signed = stubFlairHandler({});
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/Health") return new Response("ok");
      const auth = req.headers.get("Authorization") ?? "";
      if (auth.startsWith("Basic ")) return (await basic(req, url)) ?? new Response("not found", { status: 404 });
      return signed(req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A Basic `PUT /Agent/<id>` that Flair refuses (it drops `publicKey`, so the write cannot complete). */
function refusePut(url: URL, id: string): Response | undefined {
  if (url.pathname === `/Agent/${id}`) return Response.json({ type: "error:ValidationError", code: "ValidationError", status: 400 }, { status: 400 });
  return undefined;
}

/** Run `tps agent create` for `id` against `url`, capturing its exit code and output. */
async function runCreate(
  url: string,
  id: string,
  flags: { noSeed?: boolean } = {},
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "create-registration-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { stdout.push(args.join(" ")); });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(args.join(" ")); });
  let exitCode: number | undefined;
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number): never => {
    exitCode = code;
    throw new Error(`exit:${code}`);
  }) as never);
  try {
    await runAgent({ action: "create", id, name: id, flairUrl: url, noSeed: flags.noSeed });
  } catch (err) {
    if (!String(err).includes("exit:")) throw err;
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

test("refused write and no Agent row: exits non-zero, prints no success, names agent, URL and remedy", async () => {
  const id = `${AGENT}-no-row`;
  const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain(id);
    expect(res.stderr).toContain(fake.url);
    expect(res.stderr).toContain("no Agent row exists");
    expect(res.stderr).toContain("seed or key update failed");
    expect(res.stderr).toContain("flair#2266");
    expect(res.stderr).toContain(`flair agent add ${id} --keys-dir`);
    expect(res.stderr).toContain(join(".tps", "identity", `${id}.key`));
    expect(res.stderr).toContain(join(".tps", "identity", `${id}.pub`));
    expect(res.stderr).toContain(join(".tps", "identity"));
  } finally {
    fake.stop();
  }
});

test("the stored key is still `pending`: exits non-zero naming the stored value", async () => {
  const id = `${AGENT}-pending`;
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, id);
    if (url.pathname === `/Agent/${id}`) return Response.json({ id, name: id, publicKey: "pending" });
    return undefined;
  });
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain("the stored public key is 'pending'");
  } finally {
    fake.stop();
  }
});

test("the stored key differs from the generated one: exits non-zero", async () => {
  const id = `${AGENT}-mismatch`;
  const other = "de".repeat(32);
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, id);
    if (url.pathname === `/Agent/${id}`) return Response.json({ id, name: id, publicKey: other });
    return undefined;
  });
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain("not the generated key");
  } finally {
    fake.stop();
  }
});

test("the read-back fails: exits non-zero, never treating a failed read as absent", async () => {
  const id = `${AGENT}-read-fail`;
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT") return Response.json({}, { status: 200 });
    if (url.pathname === `/Agent/${id}`) return new Response("boom", { status: 500 });
    return undefined;
  });
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain("the read-back failed");
  } finally {
    fake.stop();
  }
});

test("the key reads back equal: prints success and exits zero", async () => {
  const id = `${AGENT}-ok`;
  let stored: string | null = null;
  const fake = startFakeFlair(async (req, url) => {
    if (url.pathname === `/Agent/${id}` && req.method === "PUT") {
      const body = (await req.json()) as { publicKey?: string };
      stored = body.publicKey ?? null;
      return Response.json({}, { status: 200 });
    }
    if (url.pathname === `/Agent/${id}` && stored !== null) return Response.json({ id, name: id, publicKey: stored });
    return undefined;
  });
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("registered in Flair (no seed");
    expect(res.stderr).toBe("");
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    fake.stop();
  }
});

/** A fake whose Agent row holds `encode(<the key create generated>)` */
async function runWithStoredEncoding(
  id: string,
  encode: (hexKey: string) => string,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  let stored: string | null = null;
  const fake = startFakeFlair(async (req, url) => {
    if (url.pathname === `/Agent/${id}` && req.method === "PUT") {
      const body = (await req.json()) as { publicKey?: string };
      stored = body.publicKey ? encode(body.publicKey) : null;
      return Response.json({}, { status: 200 });
    }
    if (url.pathname === `/Agent/${id}` && stored !== null) return Response.json({ id, name: id, publicKey: stored });
    return undefined;
  });
  try {
    return await runCreate(fake.url, id);
  } finally {
    fake.stop();
  }
}

const b64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

test("the row holds the base64url of the generated key (what flair stores): exits zero", async () => {
  const res = await runWithStoredEncoding(`${AGENT}-b64-equal`, b64url);
  expect(res.exitCode).toBeUndefined();
  expect(res.stdout).toContain("registered in Flair");
});

test("the row holds the base64url of a different key: exits non-zero", async () => {
  const res = await runWithStoredEncoding(`${AGENT}-b64-other`, () => b64url("de".repeat(32)));
  expect(res.exitCode).toBe(1);
  expect(res.stdout).not.toContain("registered in Flair");
  expect(res.stderr).toContain("not the generated key");
});

test("the row holds the hex of the generated key (flair accepts either): exits zero", async () => {
  const res = await runWithStoredEncoding(`${AGENT}-hex-equal`, (hex) => hex);
  expect(res.exitCode).toBeUndefined();
});

test("the row holds a value that decodes to the wrong length: exits non-zero", async () => {
  const res = await runWithStoredEncoding(`${AGENT}-short`, (hex) => Buffer.from(hex, "hex").subarray(0, 31).toString("base64url"));
  expect(res.exitCode).toBe(1);
  expect(res.stdout).not.toContain("registered in Flair");
});

/**
 * The seam through the REAL component: a real Harper running Flair. Skips
 * everywhere one is not reachable (CI has no Flair lane); run it with
 * TPS_TEST_REAL_FLAIR=1 and TPS_TEST_FLAIR_URL pointing at an instance whose
 * admin credential is TPS_TEST_FLAIR_ADMIN (default admin:test123). Current
 * Flair drops `publicKey` on Agent PUT/PATCH, so a fresh `create` cannot
 * register: it must exit non-zero and print no success line.
 */
test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")(
  "against a real Flair, create refuses when the generated key cannot be registered",
  async () => {
    const baseUrl = process.env.TPS_TEST_FLAIR_URL ?? "http://127.0.0.1:9926";
    const admin = process.env.TPS_TEST_FLAIR_ADMIN ?? "admin:test123";
    const id = `create-refusal-${randomUUID()}`;
    const savedAdmin = process.env.FLAIR_ADMIN_AUTH;
    process.env.FLAIR_ADMIN_AUTH = admin;
    try {
      const res = await runCreate(baseUrl, id);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain("registered in Flair");
      expect(res.stdout).not.toContain("✅");
      expect(res.stderr).toContain(id);
      expect(res.stderr).toContain(baseUrl);
      expect(res.stderr).toContain("flair#2266");
      // Independently of the CLI's own read-back: the real Flair stored no row.
      const record = await fetch(`${baseUrl}/Agent/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Basic ${Buffer.from(admin).toString("base64")}` },
      });
      expect(record.status).toBe(404);
    } finally {
      if (savedAdmin === undefined) delete process.env.FLAIR_ADMIN_AUTH; else process.env.FLAIR_ADMIN_AUTH = savedAdmin;
    }
  },
  30_000,
);
