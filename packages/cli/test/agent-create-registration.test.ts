import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
/**
 * cli#512 — `tps agent create` reports registration only when Flair reads the
 * local key back equal. cli#607 — and only when the local key pair is
 * consistent and Flair accepts a request signed with the private key. These
 * tests drive the create path against a fake Flair. Every fixture's Agent PUT obeys Flair: it never
 * stores `publicKey` (see `refusePut`).
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { runAgent } from "../src/commands/agent.js";
import { generateKeyPair, saveKeyPair } from "../src/utils/identity.js";
import { flairTarget } from "./helpers/scratch-flair.js";
import { requestSigner, stubFlairHandler } from "./helpers/stub-flair.js";

const AGENT = "create-registration-agent";
const ADMIN_AUTH = "admin:admin123";
const ADMIN_HEADER = `Basic ${Buffer.from(ADMIN_AUTH).toString("base64")}`;

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

/**
 * The registration POST happened, and no Agent PUT/PATCH for `id` follows it: the
 * refusal branches send no fallback write. The registered request list is the
 * server's own record, so a fallback write that lands after the POST shows here.
 */
function expectNoAgentWriteAfterRegistration(requests: Array<{ method: string; path: string }>, id: string): void {
  const post = requests.findIndex((req) => req.method === "POST" && req.path === "/AgentKeyRegister");
  expect(post).toBeGreaterThan(-1);
  expect(requests.slice(post + 1).filter((req) => (req.method === "PUT" || req.method === "PATCH") && req.path === `/Agent/${id}`)).toEqual([]);
}

/** The registration POST happened, and a read-back `GET /Agent/<id>` follows it. */
function expectReadBackAfterRegistration(requests: Array<{ method: string; path: string }>, id: string): void {
  const post = requests.findIndex((req) => req.method === "POST" && req.path === "/AgentKeyRegister");
  expect(post).toBeGreaterThan(-1);
  expect(requests.slice(post + 1).some((req) => req.method === "GET" && req.path === `/Agent/${id}`)).toBe(true);
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
    expect(res.stderr).toContain("seed failed");
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

test("a pending row and an unrecognized 404 from POST /AgentKeyRegister: exits non-zero naming the minimum version as the likely cause, prints no success", async () => {
  const id = `${AGENT}-pending-no-route`;
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, id);
    if (url.pathname === `/Agent/${id}`) return Response.json({ id, name: id, publicKey: "pending" });
    return undefined;
  });
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain(`Agent '${id}'`);
    expect(res.stderr).toContain(`this attempt to register a key in Flair at ${fake.url} was not confirmed`);
    // the response is not asserted to have a cause: only that this client cannot
    // recognize it as the endpoint's refusal
    expect(res.stderr).toContain("POST /AgentKeyRegister answered 404 with no refusal this client recognizes");
    expect(res.stderr).toContain("this Flair may not serve the route");
    expect(res.stderr).toContain("upgrade it to 0.62.0 or newer");
    // no fallback write after the registration POST: the POST is last, and no
    // Agent PUT/PATCH follows it
    expectNoAgentWriteAfterRegistration(fake.requests, id);
    expect(fake.requests.at(-1)).toEqual({ method: "POST", path: "/AgentKeyRegister", auth: expect.stringContaining("Basic ") });
  } finally {
    fake.stop();
  }
});

test("a 405 on the registration route: exits non-zero naming the minimum version as the likely cause, and sends no fallback write", async () => {
  const id = `${AGENT}-pending-method`;
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT") return refusePut(url, id);
    if (req.method === "POST" && url.pathname === "/AgentKeyRegister") return new Response("method not allowed", { status: 405 });
    if (url.pathname === `/Agent/${id}`) return Response.json({ id, name: id, publicKey: "pending" });
    return undefined;
  });
  try {
    const res = await runCreate(fake.url, id);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain("POST /AgentKeyRegister answered 405 with no refusal this client recognizes");
    expect(res.stderr).toContain("this Flair may not serve the route");
    expect(res.stderr).toContain("upgrade it to 0.62.0 or newer");
    expectNoAgentWriteAfterRegistration(fake.requests, id);
  } finally {
    fake.stop();
  }
});

interface RegistrarFlair {
  url: string;
  stop(): void;
  readonly row: { id: string; name: string; publicKey: string; updatedAt?: string };
  readonly requests: Array<{ method: string; path: string; auth: string }>;
  readonly registerBodies: Array<Record<string, unknown>>;
  fetch(req: Request): Response | Promise<Response>;
}

function startRegistrarFlair(
  id: string,
  publicKey: string,
  opts: {
    fetchOnly?: boolean;
    route?: "serve" | "missing" | "method" | "transport" | "unparseable" | "unavailable";
    refusal?: { status: number; error: string };
    store?: boolean;
    commit?: boolean;
  } = {},
): RegistrarFlair {
  const route = opts.route ?? "serve";
  const row: RegistrarFlair["row"] = { id, name: id, publicKey: "pending" };
  const requests: RegistrarFlair["requests"] = [];
  const registerBodies: Array<Record<string, unknown>> = [];
  let registrations = 0;
  const routes = async (req: Request, url: URL): Promise<Response | undefined> => {
    if (req.method === "POST" && url.pathname === "/AgentKeyRegister") {
      if (route === "missing") return undefined;
      if (route === "method") return new Response("method not allowed", { status: 405 });
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        /* no body */
      }
      registerBodies.push(body);
      // `commit: true` models a write Flair made before the unconfirmed
      // response: the row then holds the key although the client cannot confirm
      // the response, and the read-back after the POST reads it equal.
      const commit = opts.commit === true;
      // A transport failure: the client follows this redirect to a closed port and
      // its fetch rejects, so no response body reaches the caller.
      if (route === "transport") {
        if (commit) row.publicKey = String(body.publicKey);
        return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1/nope" } });
      }
      // A success status whose body is not JSON: the parse path, not a refusal.
      if (route === "unparseable") {
        if (commit) row.publicKey = String(body.publicKey);
        return new Response("not json", { status: 200 });
      }
      // The committed write, then the endpoint reports the registration
      // unavailable (as Flair does after committing when its read-back fails).
      if (route === "unavailable") {
        if (commit) row.publicKey = String(body.publicKey);
        return Response.json({ error: "registration_unavailable" }, { status: 503 });
      }
      if (opts.refusal) return Response.json({ error: opts.refusal.error }, { status: opts.refusal.status });
      registrations += 1;
      if (opts.store === false) {
        return Response.json({ agentId: id, publicKey: String(body.publicKey), updatedAt: new Date().toISOString(), registrationId: `reg-${registrations}` });
      }
      row.publicKey = String(body.publicKey);
      return Response.json({ agentId: id, publicKey: row.publicKey, updatedAt: new Date().toISOString(), registrationId: `reg-${registrations}` });
    }
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) {
      return Response.json({ ...row });
    }
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    return undefined;
  };
  const signedStub = stubFlairHandler({ [id]: publicKey }, routes);
  const pendingStub = stubFlairHandler({ [id]: "pending" }, routes);
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/Health") return new Response("ok");
    const auth = req.headers.get("Authorization") ?? "";
    requests.push({ method: req.method, path: url.pathname, auth });
    if (auth.startsWith("Basic ")) {
      if (auth !== ADMIN_HEADER) return Response.json({ error: "authentication required" }, { status: 401 });
      return (await routes(req, url)) ?? new Response("not found", { status: 404 });
    }
    return (row.publicKey === "pending" ? pendingStub : signedStub)(req);
  };
  const server = opts.fetchOnly ? undefined : Bun.serve({ port: 0, fetch: handler });
  return { url: server ? `http://127.0.0.1:${server.port}` : "http://flair.test", stop: () => server?.stop(true), row, requests, registerBodies, fetch: handler };
}

test("the registrar rejects other Basic credentials and a signed pending row", async () => {
  const id = `${AGENT}-auth-boundary`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { fetchOnly: true });
  try {
    const path = `/Agent/${id}`;
    const admin = await fake.fetch(new Request(`${fake.url}${path}`, { headers: { Authorization: ADMIN_HEADER } }));
    expect(admin.status).toBe(200);
    expect((await admin.json()).publicKey).toBe("pending");
    const wrong = await fake.fetch(new Request(`${fake.url}/AgentKeyRegister`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, publicKey }),
    }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "authentication required" });
    expect(fake.registerBodies).toEqual([]);
    const sign = requestSigner(id, Buffer.from(keyPair.signing.privateKey));
    const pending = await fake.fetch(new Request(`${fake.url}${path}`, { headers: { Authorization: sign("GET", path) } }));
    expect(pending.status).toBe(401);
    expect(await pending.json()).toEqual({ error: "signature_verification_failed" });
  } finally {
    fake.stop();
  }
});

for (const body of ["unrecognized", "unreadable"] as const) {
  test(`an ${body} registration error body leaves the outcome unconfirmed with its HTTP status`, async () => {
    const id = `${AGENT}-${body}-error`;
    const keyPair = generateKeyPair();
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
    const fake = startRegistrarFlair(id, publicKey, { fetchOnly: true });
    const restore = patchShared(globalThis, "fetch", (async (input, init) => {
      const req = new Request(input, init);
      if (req.method === "POST" && new URL(req.url).pathname === "/AgentKeyRegister") {
        const response = Response.json({ error: "unexpected_server_error" }, { status: 502 });
        if (body === "unreadable") response.text = async () => { throw new Error("body read failed"); };
        return response;
      }
      return fake.fetch(req);
    }) as typeof fetch);
    try {
      const res = await runCreate(fake.url, id, { keyPair, credential: ADMIN_AUTH });
      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain("registered in Flair");
      expect(res.stderr).toContain("was not confirmed");
      expect(res.stderr).toContain("POST /AgentKeyRegister answered HTTP 502");
      expect(res.stderr).toContain("whether a key was stored is unknown");
      expect(res.stderr).not.toContain("refused the registration");
    } finally {
      restore();
      fake.stop();
    }
  });
}

test("a pending row and a Flair that serves POST /AgentKeyRegister: the generated key is registered and read back equal, then success", async () => {
  const id = `${AGENT}-registers`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey);
  try {
    const res = await runCreate(fake.url, id, { keyPair, inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("registered in Flair");
    // the key registered is the base64url of the generated public key
    expect(fake.registerBodies).toEqual([{ agentId: id, publicKey }]);
    expect(fake.row.publicKey).toBe(publicKey);
    // the registration is over Basic admin; the signed verification follows it
    const registration = fake.requests.findIndex((req) => req.method === "POST" && req.path === "/AgentKeyRegister");
    expect(registration).toBeGreaterThan(-1);
    expect(fake.requests[registration]!.auth).toStartWith("Basic ");
    expect(fake.requests.at(-1)).toEqual({ method: "GET", path: `/Agent/${id}`, auth: expect.stringContaining("TPS-Ed25519 ") });
  } finally {
    fake.stop();
  }
});

for (const route of ["serve", "unavailable"] as const) {
  test(`a ${route === "serve" ? "successful" : "registration_unavailable"} POST followed by a read-back exception: unconfirmed with a re-run remedy and no removal advice`, async () => {
    const id = `${AGENT}-${route}-read-fail`;
    const keyPair = generateKeyPair();
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
    const fake = startRegistrarFlair(id, publicKey, { fetchOnly: true, route, commit: true });
    const restore = patchShared(globalThis, "fetch", (async (input, init) => {
      const req = new Request(input, init);
      const response = await fake.fetch(req);
      if (req.method === "GET" && new URL(req.url).pathname === `/Agent/${id}` && fake.registerBodies.length > 0) {
        throw new Error("post-registration read failed");
      }
      return response;
    }) as typeof fetch);
    try {
      const res = await runCreate(fake.url, id, { keyPair, credential: ADMIN_AUTH });
      expect(fake.registerBodies).toEqual([{ agentId: id, publicKey }]);
      expect(fake.row.publicKey).toBe(publicKey);
      expectReadBackAfterRegistration(fake.requests, id);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain("registered in Flair");
      expect(res.stderr).toContain(`this attempt to register a key in Flair at ${fake.url} was not confirmed`);
      expect(res.stderr).toContain(route === "serve" ? "POST /AgentKeyRegister succeeded" : "POST /AgentKeyRegister answered registration_unavailable");
      expect(res.stderr).toContain("The read-back after the POST failed (");
      expect(res.stderr).toContain("transport error: network failure");
      expect(res.stderr).toContain(`Remedy: re-run \`tps agent create --id ${id}\``);
      expect(res.stderr).not.toContain("flair agent remove");
      expect(res.stderr).not.toContain("is not registered in Flair");
      expectNoAgentWriteAfterRegistration(fake.requests, id);
    } finally {
      restore();
      fake.stop();
    }
  });
}

test("the endpoint answers 200 but the row does not read the key back: exits non-zero, prints no success", async () => {
  const id = `${AGENT}-accepted-unstored`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { store: false });
  try {
    const res = await runCreate(fake.url, id, { keyPair });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain("the stored public key is 'pending', not the generated key");
  } finally {
    fake.stop();
  }
});

/** A refusal from POST /AgentKeyRegister: the status the endpoint answers and the remedy its refusal names. */
const KEY_REGISTRATION_REFUSALS: ReadonlyArray<{ status: number; error: string; remedy: string }> = [
  { status: 400, error: "registration_request_invalid", remedy: "the agent id or public key was refused as malformed" },
  { status: 401, error: "authentication required", remedy: "set FLAIR_ADMIN_AUTH" },
  { status: 403, error: "forbidden", remedy: "set FLAIR_ADMIN_AUTH to its admin credential" },
  { status: 403, error: "agent_not_local", remedy: "register its key on the agent's home instance" },
  { status: 403, error: "agent_inactive", remedy: "reactivate it before registering a key" },
  { status: 404, error: "agent_not_found", remedy: "no Agent row exists" },
  { status: 409, error: "agent_key_not_pending", remedy: "key-rotation path" },
  { status: 409, error: "registration_conflict", remedy: "another write to this agent is in progress" },
];

for (const refusal of KEY_REGISTRATION_REFUSALS) {
  test(`POST /AgentKeyRegister refusal ${refusal.error}: exits non-zero naming the agent, URL, refusal and remedy, and sends no fallback write`, async () => {
    const id = `${AGENT}-refuse-${refusal.error.replace(/\W/g, "-")}`;
    const keyPair = generateKeyPair();
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
    const fake = startRegistrarFlair(id, publicKey, { refusal: { status: refusal.status, error: refusal.error } });
    try {
      const res = await runCreate(fake.url, id, { keyPair });
      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain("registered in Flair");
      expect(res.stderr).toContain(`Agent '${id}'`);
      expect(res.stderr).toContain(`this attempt to register a key in Flair at ${fake.url} was not confirmed`);
      expect(res.stderr).toContain(`POST /AgentKeyRegister refused the registration (${refusal.error})`);
      expect(res.stderr).toContain(refusal.remedy);
      // the endpoint's own refusal, never the unrecognized-response case
      expect(res.stderr).not.toContain("this Flair may not serve the route");
      // no Agent PUT/PATCH follows the refused registration POST
      expectNoAgentWriteAfterRegistration(fake.requests, id);
    } finally {
      fake.stop();
    }
  });
}

test("a transport failure after the POST was sent, but the key reads back equal: success, and the read-back runs after the POST", async () => {
  const id = `${AGENT}-transport-equal`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { route: "transport", commit: true });
  try {
    const res = await runCreate(fake.url, id, { keyPair, inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("registered in Flair");
    expectReadBackAfterRegistration(fake.requests, id);
  } finally {
    fake.stop();
  }
});

test("a transport failure after the POST and a pending read-back: this attempt was not confirmed, naming the observed state", async () => {
  const id = `${AGENT}-transport-pending`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { route: "transport" });
  try {
    const res = await runCreate(fake.url, id, { keyPair });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain(`this attempt to register a key in Flair at ${fake.url} was not confirmed`);
    expect(res.stderr).toContain("transport failure");
    // the transport failure's own bounded reason, not a refusal name
    expect(res.stderr).toContain("connection refused");
    expect(res.stderr).toContain("The read-back after the POST found the stored public key 'pending', not the generated key");
    expect(res.stderr).not.toContain("refused the registration");
    expect(res.stderr).not.toContain("not registered");
    expectReadBackAfterRegistration(fake.requests, id);
    expectNoAgentWriteAfterRegistration(fake.requests, id);
  } finally {
    fake.stop();
  }
});

test("an unparseable success body, but the key reads back equal: success, and the read-back runs after the POST", async () => {
  const id = `${AGENT}-unparseable-equal`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { route: "unparseable", commit: true });
  try {
    const res = await runCreate(fake.url, id, { keyPair, inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("registered in Flair");
    expectReadBackAfterRegistration(fake.requests, id);
  } finally {
    fake.stop();
  }
});

test("an unparseable success body and a pending read-back: this attempt was not confirmed, a parsing failure distinct from a transport one", async () => {
  const id = `${AGENT}-unparseable-pending`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { route: "unparseable" });
  try {
    const res = await runCreate(fake.url, id, { keyPair });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain(`this attempt to register a key in Flair at ${fake.url} was not confirmed`);
    expect(res.stderr).toContain("response-parsing failure");
    expect(res.stderr).toContain("malformed response body");
    expect(res.stderr).toContain("The read-back after the POST found the stored public key 'pending', not the generated key");
    expect(res.stderr).not.toContain("refused the registration");
    expect(res.stderr).not.toContain("not registered");
    expectReadBackAfterRegistration(fake.requests, id);
    expectNoAgentWriteAfterRegistration(fake.requests, id);
  } finally {
    fake.stop();
  }
});

test("registration_unavailable after a committed write and an equal read-back: success, and the read-back runs after the POST", async () => {
  const id = `${AGENT}-unavailable-equal`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { route: "unavailable", commit: true });
  try {
    const res = await runCreate(fake.url, id, { keyPair, inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("registered in Flair");
    expectReadBackAfterRegistration(fake.requests, id);
  } finally {
    fake.stop();
  }
});

test("registration_unavailable without a committed write and a pending read-back: this attempt was not confirmed, naming the observed state", async () => {
  const id = `${AGENT}-unavailable-pending`;
  const keyPair = generateKeyPair();
  const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
  const fake = startRegistrarFlair(id, publicKey, { route: "unavailable" });
  try {
    const res = await runCreate(fake.url, id, { keyPair });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered in Flair");
    expect(res.stderr).toContain(`this attempt to register a key in Flair at ${fake.url} was not confirmed`);
    expect(res.stderr).toContain("registration_unavailable");
    expect(res.stderr).toContain("The read-back after the POST found the stored public key 'pending', not the generated key");
    expect(res.stderr).not.toContain("not registered");
    expect(res.stderr).not.toContain("refused the registration");
    expectReadBackAfterRegistration(fake.requests, id);
    expectNoAgentWriteAfterRegistration(fake.requests, id);
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
    expect(res.stderr).toContain("the file holds 31 bytes and could not be loaded as an unencrypted PEM private key, a raw 32-byte Ed25519 seed or base64 PKCS8 DER");
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

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

test("an encrypted PEM private key matching the .pub: named as encrypted and refused before any Flair request, not a throw", async () => {
  const id = `${AGENT}-encrypted-pem`;
  const keyPair = generateKeyPair();
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(keyPair.signing.privateKey)]);
  const encryptedPem = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: `passphrase-${randomUUID()}` })
    .toString();
  const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
  const { keyPath } = writeIdentity(id, keyPair);
  writeFileSync(keyPath, encryptedPem);
  try {
    const res = await runCreate(fake.url, id, { inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("registered");
    expect(res.stderr).toContain(`Agent '${id}' has no usable private key at ${keyPath}`);
    expect(res.stderr).toContain("the file is an encrypted PEM private key, and encrypted keys are not supported");
    expect(res.stderr).toContain(`write its key to ${keyPath} unencrypted`);
    expect(res.stderr).not.toContain("could not be loaded as");
    expect(res.stderr).not.toContain(encryptedPem.split("\n")[1]!);
    expectNoKeyBytes(res.stdout + res.stderr, keyPair.signing.privateKey);
    expect(fake.requests).toEqual([]);
  } finally {
    fake.stop();
  }
});

// A partial identity: some of the files saveKeyPair writes exist, but not both
// `.key` and `.pub`. create must refuse before generating, so each existing
// file is byte-identical afterwards.
for (const partial of [
  { name: "only the .key", files: [".key"], missing: [".pub"] },
  { name: "only the .pub", files: [".pub"], missing: [".key"] },
  { name: "only the .meta.json", files: [".meta.json"], missing: [".key", ".pub"] },
]) {
  test(`a partial identity with ${partial.name}: refused by name, the existing file left byte-identical, before any Flair request`, async () => {
    const id = `${AGENT}-partial-${partial.files[0]!.replace(/\W/g, "")}`;
    const keyPair = generateKeyPair();
    const identityDir = join(homedir(), ".tps", "identity");
    mkdirSync(identityDir, { recursive: true });
    const contents: Record<string, Buffer> = {
      ".key": Buffer.from(keyPair.signing.privateKey),
      ".pub": Buffer.from(keyPair.signing.publicKey),
      ".meta.json": Buffer.from(JSON.stringify({ fingerprint: keyPair.fingerprint, createdAt: keyPair.createdAt })),
    };
    for (const suffix of partial.files) writeFileSync(join(identityDir, `${id}${suffix}`), contents[suffix]!);
    const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
    try {
      const res = await runCreate(fake.url, id, { inspectError: true });
      // first: nothing was written over the existing identity file (compared by
      // digest, so a failure prints no key bytes)
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      for (const suffix of partial.files) {
        expect(`${suffix}: ${digest(readFileSync(join(identityDir, `${id}${suffix}`)))}`).toBe(`${suffix}: ${digest(contents[suffix]!)}`);
      }
      for (const suffix of partial.missing) expect(existsSync(join(identityDir, `${id}${suffix}`))).toBe(false);
      expect(res.hasError).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain("registered");
      expect(res.stdout).not.toContain("Generating");
      expect(res.stderr).toContain(`Agent '${id}' has a partial identity at ${identityDir}`);
      for (const suffix of partial.missing) expect(res.stderr).toContain(join(identityDir, `${id}${suffix}`));
      expect(res.stderr).toContain("create does not generate a new pair over existing identity entries");
      expect(res.stderr).toContain(`tps agent create --id ${id}`);
      expectNoKeyBytes(res.stdout + res.stderr, keyPair.signing.privateKey);
      expect(fake.requests).toEqual([]);
    } finally {
      fake.stop();
    }
  });
}

// A dangling symlink at an identity path is an entry: existsSync reports it
// absent, so it must not let create generate a pair and write through the link.
for (const suffix of [".seed", ".key"]) {
  test(`a dangling symlink at the identity's ${suffix}: refused as a partial identity, the link unchanged and nothing written at its target`, async () => {
    const id = `${AGENT}-dangling-${suffix.replace(/\W/g, "")}`;
    const identityDir = join(homedir(), ".tps", "identity");
    const targetDir = join(homedir(), "dangling-targets");
    mkdirSync(identityDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const linkPath = join(identityDir, `${id}${suffix}`);
    const target = join(targetDir, `${id}${suffix}`);
    symlinkSync(target, linkPath);
    const fake = startFakeFlair(async (req, url) => (req.method === "PUT" ? refusePut(url, id) : undefined));
    try {
      const res = await runCreate(fake.url, id, { inspectError: true });
      // first: nothing was written through the link, and the link is as it was
      expect(existsSync(target)).toBe(false);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(target);
      expect(res.hasError).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).not.toContain("registered");
      expect(res.stdout).not.toContain("Generating");
      expect(res.stderr).toContain(`Agent '${id}' has a partial identity at ${identityDir} — found ${linkPath}`);
      if (suffix === ".key") expect(res.stderr).toContain(`${linkPath} is a symlink to a missing target`);
      expect(res.stderr).toContain("create does not generate a new pair over existing identity entries");
      expect(fake.requests).toEqual([]);
    } finally {
      fake.stop();
    }
  });
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

test("a raw 32-byte seed whose bytes begin with \"-----\", matching the .pub, with a row in Flair that holds the key: read as a seed, not as PEM, and create reports registered", async () => {
  // Any 32 bytes are a valid Ed25519 seed. The loader reads a 32-byte file as a
  // seed before it looks for a PEM prefix, so this one is not sent to the PEM parser.
  const id = `${AGENT}-dash-seed`;
  const seed = Buffer.concat([Buffer.alloc(5, 0x2d), randomBytes(27)]);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  const publicKey = pub.toString("base64url");
  const row = { id, name: id, publicKey, createdAt: new Date().toISOString() };
  const fake = startFakeFlair(async (req, url) => {
    if (req.method === "PUT" || req.method === "PATCH") return refusePut(url, id);
    if (req.method === "GET" && url.pathname === `/Agent/${id}`) return Response.json(row);
    return undefined;
  }, { [id]: publicKey });
  const identityDir = join(homedir(), ".tps", "identity");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, `${id}.key`), seed);
  writeFileSync(join(identityDir, `${id}.pub`), pub);
  try {
    const res = await runCreate(fake.url, id, { inspectError: true });
    expect(res.hasError).toBe(false);
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("already registered in Flair");
    expect(fake.requests.map(({ method, auth }) => ({ method, signed: auth.startsWith(`TPS-Ed25519 ${id}:`) }))).toEqual([
      { method: "GET", signed: true },
      { method: "GET", signed: false },
      { method: "GET", signed: true },
    ]);
  } finally {
    fake.stop();
  }
});

test("an unencrypted PEM or base64 PKCS8 private key matching the .pub, with a row in Flair that holds the key: the probe accepts it and create reports registered", async () => {
  // The Flair client signs with an unencrypted PEM block, a raw 32-byte seed or
  // base64 PKCS8 DER (loadFlairSigningKey); the key-pair probe loads the file the same way,
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
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(keyPair.signing.privateKey)]);
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
 * The seam through the REAL component: a real Harper running Flair. Skipped
 * unless TPS_TEST_REAL_FLAIR=1 (cli#591); the real-Flair lane starts the scratch
 * instance and exports its ports, which `flairTarget()` reads. Flair 0.58.0
 * drops `publicKey` on Agent PUT/PATCH, so a fresh `create` cannot register: it
 * must exit non-zero and print no success line.
 */
test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")(
  "against a real Flair, create refuses when the generated key cannot be registered",
  async () => {
    const { baseUrl, admin } = flairTarget();
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
  240_000,
);

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")(
  "against a real Flair, create succeeds with an existing Agent and matching local key",
  async () => {
    const { baseUrl, opsUrl, admin } = flairTarget();
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
  240_000,
);

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")(
  "against a real Flair, create on a pending row completes registration when the instance serves POST /AgentKeyRegister and the stored key reads back equal; when the route is absent it refuses naming the minimum version",
  async () => {
    const { baseUrl, opsUrl, admin } = flairTarget();
    const id = `create-pending-${randomUUID()}`;
    const wire = Buffer.from(admin).toString("base64");
    const headers = { Authorization: `Basic ${wire}`, "Content-Type": "application/json" };
    const inserted = await fetch(opsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Agent",
        records: [{ id, name: id, publicKey: "pending", createdAt: new Date().toISOString() }],
      }),
    });
    expect(inserted.ok).toBe(true);
    const keyPair = generateKeyPair();
    const publicKey = Buffer.from(keyPair.signing.publicKey).toString("base64url");
    try {
      const path = `/Agent/${id}`;
      const adminRead = await fetch(`${baseUrl}${path}`, { headers });
      expect(adminRead.status).toBe(200);
      expect((await adminRead.json()).publicKey).toBe("pending");
      const wrong = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` },
      });
      expect(wrong.ok).toBe(false);
      const sign = requestSigner(id, Buffer.from(keyPair.signing.privateKey));
      const pending = await fetch(`${baseUrl}${path}`, { headers: { Authorization: sign("GET", path) } });
      expect(pending.status).toBe(401);
      expect((await pending.json()).error).toBe("signature_verification_failed");

      // Whether this Flair serves POST /AgentKeyRegister: a missing route answers
      // 404, a present one refuses an empty body 400. Measured once, before the run.
      const probe = await fetch(`${baseUrl}/AgentKeyRegister`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const capable = probe.status !== 404 && probe.status !== 405;

      const res = await runCreate(baseUrl, id, { keyPair, credential: admin, inspectError: true });
      if (capable) {
        expect(res.exitCode).toBeUndefined();
        expect(res.hasError).toBe(false);
        expect(res.stdout).toContain("registered in Flair");
        const record = await fetch(`${baseUrl}/Agent/${id}`, { headers });
        expect(record.ok).toBe(true);
        expect((await record.json() as { publicKey: string }).publicKey).toBe(publicKey);
      } else {
        expect(res.exitCode).toBe(1);
        expect(res.stdout).not.toContain("registered in Flair");
        expect(res.stderr).toContain("this Flair may not serve the route");
        expect(res.stderr).toContain("0.62.0");
      }
      for (const stream of [res.stdout, res.stderr, format(res.error)]) {
        expect(stream).not.toContain(admin);
        expect(stream).not.toContain(wire);
      }
    } finally {
      const deleted = await fetch(opsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ operation: "delete", database: "flair", table: "Agent", hash_values: [id] }),
      });
      expect(deleted.ok).toBe(true);
    }
  },
  240_000,
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
