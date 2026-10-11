import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
/**
 * cli#512 — `tps agent create` reports registration only when Flair reads the
 * generated key back equal. These tests drive the create path against a fake
 * Flair: signed calls reach the shared verifying stub (cli#554), and the
 * operator-credentialed calls the create flow makes — the Agent PUT and the
 * read-back GET, both Basic — reach a route this file controls.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
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
  requests: Array<{ method: string; path: string; auth: string }>;
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
  const requests: FakeFlair["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/Health") return new Response("ok");
      const auth = req.headers.get("Authorization") ?? "";
      requests.push({ method: req.method, path: url.pathname, auth });
      if (auth.startsWith("Basic ")) return (await basic(req, url)) ?? new Response("not found", { status: 404 });
      return signed(req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), requests };
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
  flags: { noSeed?: boolean; credential?: string; inspectError?: boolean } = {},
  create: typeof runAgent = runAgent,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string; error: unknown; hasError: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "create-registration-"));
  const savedHome = process.env.HOME;
  const savedCredential = process.env.FLAIR_ADMIN_AUTH;
  process.env.HOME = home;
  if (flags.credential !== undefined) process.env.FLAIR_ADMIN_AUTH = flags.credential;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleSpies = (["log", "info", "warn", "error"] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      (method === "log" || method === "info" ? stdout : stderr).push(`${format(...args)}\n`);
    }),
  );
  const captureWrite = (output: string[]): typeof process.stdout.write => (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (done) queueMicrotask(() => done());
    return true;
  };
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(captureWrite(stdout));
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation(captureWrite(stderr));
  const syntheticExit = Symbol("runCreate exit");
  let exitCode: number | undefined;
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number): never => {
    exitCode = code;
    throw syntheticExit;
  }) as never);
  let error: unknown = null;
  let hasError = false;
  try {
    await create({ action: "create", id, name: id, flairUrl: url, noSeed: flags.noSeed });
  } catch (err) {
    if (err !== syntheticExit) {
      if (!flags.inspectError) throw err;
      error = err;
      hasError = true;
    }
  } finally {
    exitSpy.mockRestore();
    for (const spy of consoleSpies) spy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedCredential === undefined) delete process.env.FLAIR_ADMIN_AUTH; else process.env.FLAIR_ADMIN_AUTH = savedCredential;
    rmSync(home, { recursive: true, force: true });
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), error, hasError };
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
    expect(res.stderr).not.toContain("remove");
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
    const remove = res.stderr.indexOf(`flair agent remove ${id}`);
    expect(remove).toBeGreaterThan(-1);
    expect(remove).toBeLessThan(res.stderr.indexOf(`flair agent add ${id}`));
    expect(res.stderr).toContain("Memory and Soul rows");
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

test("the read-back fails: exits non-zero, never treating a failed read as absent, and names both remedy branches", async () => {
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
    // cli#593: a non-404 read failure leaves the row's existence unknown, so the
    // remedy names the remove branch as well as the add branch.
    expect(res.stderr).toContain(`flair agent show ${id}`);
    expect(res.stderr).toContain(`flair agent remove ${id}`);
    expect(res.stderr).toContain(`flair agent add ${id} --keys-dir`);
    expect(res.stderr).toContain("Memory and Soul rows");
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

test("selected create cases omit the credential marker and Basic encoding from captured output and errors", async () => {
  const marker = `credential-593-${randomUUID()}-${"z".repeat(40)}`;
  const credential = `operator:${marker}`;
  const wire = Buffer.from(credential).toString("base64");

  const fakes: FakeFlair[] = [];
  const make = (basic: (req: Request, url: URL) => Promise<Response | undefined>): FakeFlair => {
    const fake = startFakeFlair(basic);
    fakes.push(fake);
    return fake;
  };

  const noRowId = `${AGENT}-cred-no-row`;
  const noRow = make(async (req, url) => (req.method === "PUT" ? refusePut(url, noRowId) : undefined));

  const noSeedId = `${AGENT}-cred-no-seed`;
  const noSeed = make(async (req, url) => (req.method === "PUT" ? refusePut(url, noSeedId) : undefined));

  const readFailId = `${AGENT}-cred-read-fail`;
  const readFail = make(async (req, url) => {
    if (req.method === "PUT") return Response.json({}, { status: 200 });
    if (url.pathname === `/Agent/${readFailId}`) return new Response("boom", { status: 500 });
    return undefined;
  });

  const noKeyId = `${AGENT}-cred-no-key`;
  const noKey = make(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, noKeyId);
    if (url.pathname === `/Agent/${noKeyId}`) return Response.json({ id: noKeyId, name: noKeyId });
    return undefined;
  });

  const differId = `${AGENT}-cred-differ`;
  const differ = make(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, differId);
    if (url.pathname === `/Agent/${differId}`) return Response.json({ id: differId, name: differId, publicKey: "de".repeat(32) });
    return undefined;
  });

  const okId = `${AGENT}-cred-ok`;
  let okStored: string | null = null;
  const ok = make(async (req, url) => {
    if (url.pathname === `/Agent/${okId}` && req.method === "PUT") {
      const body = (await req.json()) as { publicKey?: string };
      okStored = body.publicKey ?? null;
      return Response.json({}, { status: 200 });
    }
    if (url.pathname === `/Agent/${okId}` && okStored !== null) return Response.json({ id: okId, name: okId, publicKey: okStored });
    return undefined;
  });

  const paths = [
    { name: "missing id", url: "http://127.0.0.1:1", id: "", exitCode: 1, message: "Usage: tps agent create" },
    { name: "refused write over no row", fake: noRow, id: noRowId, exitCode: 1, message: "no Agent row exists", seed: true },
    { name: "refused write, --no-seed", fake: noSeed, id: noSeedId, noSeed: true, exitCode: 1, message: "no Agent row exists", seed: false },
    { name: "failed read-back", fake: readFail, id: readFailId, exitCode: 1, message: "the read-back failed", seed: true },
    { name: "row holds no key", fake: noKey, id: noKeyId, exitCode: 1, message: "the row has no public key", seed: true },
    { name: "row holds a different key", fake: differ, id: differId, exitCode: 1, message: "not the generated key", seed: true },
    { name: "success", fake: ok, id: okId, exitCode: undefined, message: "registered in Flair (no seed", seed: true },
  ];

  try {
    for (const path of paths) {
      const res = await runCreate(path.fake?.url ?? path.url!, path.id, { credential, noSeed: path.noSeed, inspectError: true });
      for (const stream of [res.stdout, res.stderr, format(res.error)]) {
        expect(`${path.name}: ${stream}`).not.toContain(marker);
        expect(`${path.name}: ${stream}`).not.toContain(wire);
      }
      expect(res.hasError).toBe(false);
      expect(res.error).toBeNull();
      expect(res.exitCode).toBe(path.exitCode);
      expect(path.exitCode === 1 ? res.stderr : res.stdout).toContain(path.message);
      if (path.exitCode === 1) expect(res.stdout).not.toContain("registered in Flair");
      else {
        expect(res.stderr).toBe("");
        expect(res.stdout).toContain("Config written to");
        expect(okStored).toMatch(/^[a-f0-9]{64}$/);
      }
      if (path.fake) {
        const basic = path.fake.requests.filter((req) => req.auth.startsWith("Basic "));
        expect(basic).toEqual([
          { method: "PUT", path: `/Agent/${path.id}`, auth: `Basic ${wire}` },
          { method: "GET", path: `/Agent/${path.id}`, auth: `Basic ${wire}` },
        ]);
        expect(path.fake.requests.some((req) => req.method === "POST" && req.path === "/AgentSeed/")).toBe(path.seed);
      }
    }
  } finally {
    for (const fake of fakes) fake.stop();
  }
});

test("runCreate captures console methods and direct stream writes", async () => {
  const res = await runCreate("", "", {}, async () => {
    console.log("log");
    console.info("info");
    console.warn("warn");
    console.error("error");
    await new Promise<void>((resolve) => process.stdout.write(Buffer.from("stdout"), resolve));
    await new Promise<void>((resolve) => process.stderr.write("stderr", "utf8", resolve));
  });
  expect(res.stdout).toBe("log\ninfo\nstdout");
  expect(res.stderr).toBe("warn\nerror\nstderr");
  expect(res.exitCode).toBeUndefined();
  expect(res.error).toBeNull();
});

test("runCreate retains non-exit thrown values by identity when inspected", async () => {
  for (const error of [new Error("credential exit:1"), new Error("early failure"), null, undefined]) {
    const res = await runCreate("", "", { inspectError: true }, async () => { throw error; });
    expect(res.hasError).toBe(true);
    expect(res.error).toBe(error);
    expect(res.exitCode).toBeUndefined();
  }
});

test("runCreate rejects unexpected errors for callers without inspection", async () => {
  for (const error of [new Error("credential exit:1"), new Error("early failure"), null, undefined]) {
    await expect(runCreate("", "", {}, async () => { throw error; })).rejects.toBe(error);
  }
  const res = await runCreate("", "", {}, async () => { process.exit(1); });
  expect(res.exitCode).toBe(1);
  expect(res.error).toBeNull();
});
