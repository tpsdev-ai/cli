import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
/**
 * cli#512 — `tps agent create` reports registration only when Flair reads the
 * local key back equal. cli#607 — and only when the local key pair is
 * consistent and Flair accepts a request signed with the private key. These
 * tests drive the create path against a fake Flair: signed calls reach the
 * shared verifying stub (cli#554), and the operator-credentialed calls the
 * create flow makes — the Agent PUT and the read-back GET, both Basic — reach a
 * route this file controls. Every fixture's Agent PUT obeys Flair: it never
 * stores `publicKey` (see `refusePut`).
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createPrivateKey, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { runAgent } from "../src/commands/agent.js";
import { generateKeyPair, saveKeyPair } from "../src/utils/identity.js";
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
 * verifying stub — so a fresh agent's own signed
 * read (getAgent) and seed (AgentSeed) are refused 401 `unknown_agent`, exactly
 * as a real Flair refuses an unregistered caller. A request carrying Basic
 * reaches `basic` (the Agent PUT and the read-back GET).
 */
function startFakeFlair(
  basic: (req: Request, url: URL) => Promise<Response | undefined>,
  signers: Record<string, string> = {},
): FakeFlair {
  const signed = stubFlairHandler(signers, basic);
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

/**
 * A Basic `PUT /Agent/<id>`, as Flair answers it: Flair's Agent.put deletes
 * `publicKey` and `createdAt` from the body (flair resources/Agent.ts), both of
 * which its Agent schema requires, so the write is refused and the stored row,
 * if any, is unchanged.
 */
function refusePut(url: URL, id: string): Response | undefined {
  if (url.pathname === `/Agent/${id}`) return Response.json({ type: "error:ValidationError", code: "ValidationError", status: 400 }, { status: 400 });
  return undefined;
}

/** Run `tps agent create` for `id` against `url`, capturing its exit code and output. */
async function runCreate(
  url: string,
  id: string,
  flags: { noSeed?: boolean; credential?: string; inspectError?: boolean; keyPair?: ReturnType<typeof generateKeyPair> } = {},
  create: typeof runAgent = runAgent,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string; error: unknown; hasError: boolean }> {
  const home = homedir();
  const savedCredential = process.env.FLAIR_ADMIN_AUTH;
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
    if (flags.keyPair) saveKeyPair(flags.keyPair, join(home, ".tps", "identity"), id);
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
    if (savedCredential === undefined) delete process.env.FLAIR_ADMIN_AUTH; else process.env.FLAIR_ADMIN_AUTH = savedCredential;
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), error, hasError };
}

/** `output` carries none of `bytes` in hex, base64 or base64url. */
function expectNoKeyBytes(output: string, bytes: Uint8Array): void {
  for (const encoding of ["hex", "base64", "base64url"] as const) {
    expect(output).not.toContain(Buffer.from(bytes).toString(encoding));
  }
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

test("the private key does not derive the public key file: exits non-zero before any Flair request, prints no success", async () => {
  const id = `${AGENT}-keypair-mismatch`;
  const priv = generateKeyPair();
  const other = generateKeyPair();
  // The reachable false success (cli#607): an Agent row already holds the `.pub`
  // file's key, so the operator read-back matches the `.pub`. As in Flair, the
  // Basic PUT stores nothing (refusePut) and a signed request is verified against
  // the stored key, which the private key's signatures do not verify under.
  const otherPublicKey = Buffer.from(other.signing.publicKey).toString("base64url");
  const row = { id, name: id, publicKey: otherPublicKey, createdAt: other.createdAt };
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) return Response.json(row);
    return undefined;
  }, { [id]: otherPublicKey });
  const identityDir = join(homedir(), ".tps", "identity");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, `${id}.key`), Buffer.from(priv.signing.privateKey));
  writeFileSync(join(identityDir, `${id}.pub`), Buffer.from(other.signing.publicKey));
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered");
    expect(res.stderr).toContain(id);
    expect(res.stderr).toContain("does not derive the public key");
    expect(res.stderr).toContain(join(".tps", "identity", `${id}.key`));
    expect(res.stderr).toContain(join(".tps", "identity", `${id}.pub`));
    expectNoKeyBytes(res.stdout + res.stderr, priv.signing.privateKey);
    // refused locally, before any Flair request
    expect(fake.requests).toEqual([]);
  } finally {
    fake.stop();
  }
});

test("the private key file is in no format the Flair client loads: a named refusal before any Flair request, not a throw", async () => {
  const id = `${AGENT}-malformed-key`;
  const keyPair = generateKeyPair();
  const truncated = Buffer.from(keyPair.signing.privateKey).subarray(0, 31);
  const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
  const identityDir = join(homedir(), ".tps", "identity");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, `${id}.key`), truncated);
  writeFileSync(join(identityDir, `${id}.pub`), Buffer.from(keyPair.signing.publicKey));
  try {
    const res = await runCreate(fake.url, id, { inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered");
    expect(res.stderr).toContain(`Agent '${id}' has no usable private key at`);
    expect(res.stderr).toContain(join(".tps", "identity", `${id}.key`));
    expect(res.stderr).toContain("the file holds 31 bytes and is not a PEM private key, a raw 32-byte Ed25519 seed or base64 PKCS8 DER");
    expect(res.stderr).toContain(`tps agent create --id ${id}`);
    expectNoKeyBytes(res.stdout + res.stderr, truncated);
    expect(fake.requests).toEqual([]);
  } finally {
    fake.stop();
  }
});

/** Write a matched key pair for `id` into the identity dir, plus any `extra` files; returns the paths. */
function writeIdentity(id: string, keyPair: ReturnType<typeof generateKeyPair>, extra: Record<string, string> = {}) {
  const identityDir = join(homedir(), ".tps", "identity");
  mkdirSync(identityDir, { recursive: true });
  const keyPath = join(identityDir, `${id}.key`);
  writeFileSync(keyPath, Buffer.from(keyPair.signing.privateKey));
  writeFileSync(join(identityDir, `${id}.pub`), Buffer.from(keyPair.signing.publicKey));
  for (const [suffix, content] of Object.entries(extra)) writeFileSync(join(identityDir, `${id}${suffix}`), content);
  return { identityDir, keyPath };
}

// chmod 000 does not stop root from reading, so the case cannot be built as root.
test.skipIf(process.getuid?.() === 0)("an existing private key file that cannot be read: a named refusal before any Flair request, not a throw", async () => {
  const id = `${AGENT}-unreadable-key`;
  const keyPair = generateKeyPair();
  const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
  const { keyPath } = writeIdentity(id, keyPair);
  chmodSync(keyPath, 0o000);
  try {
    const res = await runCreate(fake.url, id, { inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered");
    expect(res.stderr).toContain(`Agent '${id}' cannot load its identity at`);
    expect(res.stderr).toContain(`${keyPath} cannot be read (EACCES)`);
    expect(res.stderr).toContain("make that file readable by the user running tps");
    expect(res.stderr).toContain(`tps agent create --id ${id}`);
    expectNoKeyBytes(res.stdout + res.stderr, keyPair.signing.privateKey);
    expect(fake.requests).toEqual([]);
  } finally {
    chmodSync(keyPath, 0o600);
    fake.stop();
  }
});

test("an identity's .meta.json is not JSON: a named refusal before any Flair request, not a throw", async () => {
  const id = `${AGENT}-bad-meta`;
  const keyPair = generateKeyPair();
  const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
  const marker = `not-json-${randomUUID()}`;
  const { identityDir } = writeIdentity(id, keyPair, { ".meta.json": marker });
  try {
    const res = await runCreate(fake.url, id, { inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered");
    expect(res.stderr).toContain(`${join(identityDir, `${id}.meta.json`)} is not valid JSON`);
    expect(res.stderr).toContain("move it aside");
    // the parser's message, which can quote the file, is not printed
    expect(res.stderr).not.toContain(marker);
    expect(fake.requests).toEqual([]);
  } finally {
    fake.stop();
  }
});

test("a PEM or base64 PKCS8 private key matching the .pub, with a row in Flair that holds the key: the probe accepts it and create reports registered", async () => {
  // The Flair client signs with a PEM block, a raw 32-byte seed or base64 PKCS8
  // DER (loadFlairSigningKey); the key-pair probe loads the file the same way,
  // so a matched pair in either non-raw format passes the probe. The row already
  // holds the matching key and Flair accepts the signed request, so create then
  // reports registered, as main did for these files.
  const encodings = {
    pem: (der: Buffer) => createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }).toString(),
    pkcs8: (der: Buffer) => `${der.toString("base64")}\n`,
  };
  for (const [encoding, encode] of Object.entries(encodings)) {
    const id = `${AGENT}-${encoding}-key`;
    const keyPair = generateKeyPair();
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
    const row = { id, name: id, publicKey, createdAt: keyPair.createdAt };
    const fake = startFakeFlair(async (req, url) => {
      if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
      if (req.method === "GET" && url.pathname === `/Agent/${id}`) return Response.json(row);
      return undefined;
    }, { [id]: publicKey });
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(keyPair.signing.privateKey)]);
    const identityDir = join(homedir(), ".tps", "identity");
    mkdirSync(identityDir, { recursive: true });
    writeFileSync(join(identityDir, `${id}.key`), encode(der));
    writeFileSync(join(identityDir, `${id}.pub`), Buffer.from(keyPair.signing.publicKey));
    try {
      const res = await runCreate(fake.url, id, { inspectError: true });
      expect(`${encoding}: ${String(res.hasError)}`).toBe(`${encoding}: false`);
      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toContain("already registered in Flair");
      expect(res.stderr).toBe("");
      // the third request is the signed verification, made with the same key file
      expect(fake.requests.map(({ method, path, auth }) => ({ method, path, signed: auth.startsWith(`TPS-Ed25519 ${id}:`) }))).toEqual([
        { method: "GET", path: `/Agent/${id}`, signed: true },
        { method: "GET", path: `/Agent/${id}`, signed: false },
        { method: "GET", path: `/Agent/${id}`, signed: true },
      ]);
    } finally {
      fake.stop();
    }
  }
});

test("an existing row holds the matching key but Flair refuses the agent's signed request: exits non-zero, prints no success", async () => {
  const id = `${AGENT}-signed-refused`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  // A row that holds the matching key, for a principal Flair no longer
  // authenticates: Flair answers every signed request from a principal whose
  // `status` is set and is not "active" with 401 `principal_deactivated` (flair
  // resources/auth-middleware.ts), while the operator's Basic read-back still
  // reads the row and its matching key. As in Flair, the Basic PUT stores nothing
  // (refusePut). The shared stub verifies each signature before this route runs,
  // so the 401 here answers only a correctly signed request.
  const row = { id, name: id, publicKey, createdAt: keyPair.createdAt, status: "deactivated" };
  const fake = startFakeFlair(async (req, url) => {
    if (!(req.headers.get("Authorization") ?? "").startsWith("Basic ")) {
      return Response.json({ error: "principal_deactivated" }, { status: 401 });
    }
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) return Response.json(row);
    return undefined;
  }, { [id]: publicKey });
  try {
    const res = await runCreate(fake.url, id, { keyPair });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered");
    expect(res.stderr).toContain(id);
    expect(res.stderr).toContain("signed with the private key was refused");
    expect(res.stderr).toContain("401: principal_deactivated");
    expectNoKeyBytes(res.stdout + res.stderr, keyPair.signing.privateKey);
    // The read-back matched the generated key; the refusal is the signed
    // verification request that follows it.
    expect(fake.requests.map(({ method, path, auth }) => ({ method, path, signed: auth.startsWith("TPS-Ed25519 ") }))).toEqual([
      { method: "GET", path: `/Agent/${id}`, signed: true },
      { method: "POST", path: "/AgentSeed/", signed: true },
      { method: "PUT", path: `/Agent/${id}`, signed: false },
      { method: "GET", path: `/Agent/${id}`, signed: false },
      { method: "GET", path: `/Agent/${id}`, signed: true },
    ]);
  } finally {
    fake.stop();
  }
});

test("the signed request is accepted but its response does not carry the registered key: exits non-zero", async () => {
  const id = `${AGENT}-signed-unconfirmed`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const otherKey = Buffer.from(generateKeyPair().signing.publicKey).toString("base64url");
  const row = { id, name: id, publicKey, createdAt: keyPair.createdAt };
  let signedGets = 0;
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) {
      if ((req.headers.get("Authorization") ?? "").startsWith("Basic ")) return Response.json(row);
      // The first signed GET finds the matching row; the verification GET answers
      // with a different key, so the response does not confirm the registered one.
      signedGets += 1;
      return Response.json(signedGets === 1 ? row : { ...row, publicKey: otherKey });
    }
    return undefined;
  }, { [id]: publicKey });
  try {
    const res = await runCreate(fake.url, id, { keyPair });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain("did not confirm the registered key");
    // one refusal: the accepted request is not also reported as refused
    expect(res.stderr).not.toContain("was refused");
  } finally {
    fake.stop();
  }
});

test("the read-back fails: exits non-zero, never treating a failed read as absent, and names both remedy branches", async () => {
  const id = `${AGENT}-read-fail`;
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, id);
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

test("an existing Agent with the local key: prints success without a seed or write", async () => {
  const id = `${AGENT}-ok`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const row = { id, name: id, publicKey, createdAt: keyPair.createdAt };
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) return Response.json(row);
    return undefined;
  }, { [id]: publicKey });
  try {
    const res = await runCreate(fake.url, id, { keyPair, inspectError: true });
    expect(res.exitCode).toBeUndefined();
    expect(res.hasError).toBe(false);
    expect(res.error).toBeNull();
    expect(res.stdout).toContain("already registered in Flair");
    expect(res.stderr).toBe("");
    expect(fake.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: `/Agent/${id}` },
      { method: "GET", path: `/Agent/${id}` },
      { method: "GET", path: `/Agent/${id}` },
    ]);
    expect(fake.requests[0]!.auth).toStartWith(`TPS-Ed25519 ${id}:`);
    // the third request is the signed verification (cli#607), not another Basic read
    expect(fake.requests[2]!.auth).toStartWith(`TPS-Ed25519 ${id}:`);
    expect(row.publicKey).toBe(publicKey);
  } finally {
    fake.stop();
  }
});

async function runWithStoredEncoding(
  id: string,
  encode: (hexKey: string) => string,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const keyPair = generateKeyPair();
  const publicKey = encode(Buffer.from(keyPair.signing.publicKey).toString("hex"));
  const row = { id, name: id, publicKey, createdAt: keyPair.createdAt };
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) return Response.json(row);
    return undefined;
  }, { [id]: /^[a-f0-9]{64}$/.test(publicKey) ? Buffer.from(publicKey, "hex").toString("base64") : publicKey });
  try {
    return await runCreate(fake.url, id, { keyPair });
  } finally {
    fake.stop();
  }
}

const b64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

test("the row holds the base64url of the local key: exits zero", async () => {
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

test("the row holds the hex of the local key: exits zero", async () => {
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

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")(
  "against a real Flair, create succeeds with an existing Agent and matching local key",
  async () => {
    const baseUrl = process.env.TPS_TEST_FLAIR_URL ?? "http://127.0.0.1:9926";
    const opsUrl = process.env.TPS_TEST_FLAIR_OPS_URL ?? "http://127.0.0.1:9925";
    const admin = process.env.TPS_TEST_FLAIR_ADMIN ?? "admin:test123";
    const id = `create-existing-${randomUUID()}`;
    const keyPair = generateKeyPair();
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
    const wire = Buffer.from(admin).toString("base64");
    const headers = { Authorization: `Basic ${wire}`, "Content-Type": "application/json" };
    const inserted = await fetch(opsUrl, {
      method: "POST", headers,
      body: JSON.stringify({
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id, name: id, publicKey, createdAt: keyPair.createdAt }],
      }),
    });
    try {
      expect(inserted.ok).toBe(true);
      const res = await runCreate(baseUrl, id, { keyPair, credential: admin, inspectError: true });
      expect(res.exitCode).toBeUndefined();
      expect(res.hasError).toBe(false);
      expect(res.error).toBeNull();
      expect(res.stdout).toContain("already registered in Flair");
      expect(res.stderr).toBe("");
      for (const stream of [res.stdout, res.stderr, format(res.error)]) {
        expect(stream).not.toContain(admin);
        expect(stream).not.toContain(wire);
      }
      const record = await fetch(`${baseUrl}/Agent/${id}`, { headers });
      expect(record.ok).toBe(true);
      expect((await record.json() as { publicKey: string }).publicKey).toBe(publicKey);
    } finally {
      const deleted = await fetch(opsUrl, {
        method: "POST", headers,
        body: JSON.stringify({ operation: "delete", database: "flair", table: "Agent", hash_values: [id] }),
      });
      expect(deleted.ok).toBe(true);
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
    if (req.method === "PUT") return refusePut(url, readFailId);
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
  const okKeyPair = generateKeyPair();
  const okPublicKey = Buffer.from(okKeyPair.signing.publicKey).toString("base64url");
  const okRow = { id: okId, name: okId, publicKey: okPublicKey, createdAt: okKeyPair.createdAt };
  const ok = startFakeFlair(async (req, url) => {
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, okId);
    if (req.method === "GET" && url.pathname === `/Agent/${okId}`) return Response.json(okRow);
    return undefined;
  }, { [okId]: okPublicKey });
  fakes.push(ok);

  const paths = [
    { name: "missing id", url: "http://127.0.0.1:1", id: "", exitCode: 1, message: "Usage: tps agent create" },
    { name: "refused write over no row", fake: noRow, id: noRowId, exitCode: 1, message: "no Agent row exists", seed: true },
    { name: "refused write, --no-seed", fake: noSeed, id: noSeedId, noSeed: true, exitCode: 1, message: "no Agent row exists", seed: false },
    { name: "failed read-back", fake: readFail, id: readFailId, exitCode: 1, message: "the read-back failed", seed: true },
    { name: "row holds no key", fake: noKey, id: noKeyId, exitCode: 1, message: "the row has no public key", seed: true },
    { name: "row holds a different key", fake: differ, id: differId, exitCode: 1, message: "not the generated key", seed: true },
    { name: "success", fake: ok, id: okId, keyPair: okKeyPair, exitCode: undefined, message: "already registered in Flair", seed: false },
  ];

  try {
    for (const path of paths) {
      const res = await runCreate(path.fake?.url ?? path.url!, path.id, { credential, noSeed: path.noSeed, inspectError: true, keyPair: path.keyPair });
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
        expect(okRow.publicKey).toBe(okPublicKey);
        expect(ok.requests.map(({ method, path }) => ({ method, path }))).toEqual([
          { method: "GET", path: `/Agent/${okId}` },
          { method: "GET", path: `/Agent/${okId}` },
          { method: "GET", path: `/Agent/${okId}` },
        ]);
        expect(ok.requests[0]!.auth).toStartWith(`TPS-Ed25519 ${okId}:`);
        expect(ok.requests[2]!.auth).toStartWith(`TPS-Ed25519 ${okId}:`);
      }
      if (path.fake) {
        const basic = path.fake.requests.filter((req) => req.auth.startsWith("Basic "));
        expect(basic).toEqual([
          ...(path.keyPair ? [] : [{ method: "PUT", path: `/Agent/${path.id}`, auth: `Basic ${wire}` }]),
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
