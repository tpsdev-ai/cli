/**
 * cli#597 — non-OK HTTP response errors use
 * `Flair <entry> <method> <pathname> → <status>: <code>`, with an allow-listed
 * string from the response's `error` field (else `unrecognized_error`). These
 * messages exclude raw bodies, other response text and transport messages.
 * Encoded parameters stay encoded when the wrapper or caller encodes them;
 * request() sends the path its caller supplies, without encoding ids itself.
 *
 * Caught transport failures use
 * `Flair <entry> <method> <pathname> transport error: <reason>`.
 * Failed successful-response JSON parses use
 * `Flair <entry> <method> <pathname> → <status>: malformed response body`;
 * request() and registerAgent() accept 204 without parsing.
 * Local checks interpolate ids (promotion refusals, invalid principal records,
 * governance read refusals and missing agents); the private-key read failure
 * interpolates the key path and agent id. A governance read failure also embeds
 * the caught error's message. These local messages are outside the response bound.
 *
 * Each entry point is driven in a Bun child importing the source client
 * (`src/utils/flair-client.ts`) and a Node child importing the built client
 * (`dist/src/utils/flair-client.js`). The echo server uses the shared verifying
 * stub for a registered signer; the Basic paths use an authorized fixture with
 * its own refusal. The native transport case asserts the thrown message only.
 *
 * Precondition: build the CLI before running this suite's Node children.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "../src/commands/agent.js";
import { FLAIR_ERROR_CODES, FlairClient } from "../src/utils/flair-client.js";
import { createPatchShared } from "./helpers/patch-shared.js";
import { stubFlairHandler, writeKeyFile } from "./helpers/stub-flair.js";

// cli#555: a patch of a shared global goes through the file-scope factory, so
// the guard accepts it and owns the teardown.
const patchShared = createPatchShared();

// cli#555: a file that names `spyOn` carries the top-level teardown; each test
// below restores its own spies in a finally as well.
afterEach(() => {
  mock.restore();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT = "agent-a";
const SEED = Buffer.alloc(32, 0x7a);
/** The operator credential a `Basic` header is built from — client-constructed, never a server value. */
const OPERATOR = "operator-a:op-pass-4f9c";
const OPERATOR_B64 = Buffer.from(OPERATOR).toString("base64");
const WRONG_OPERATOR = "operator-impostor:wrong-pass-0000";

const TEST_DIR = resolve(import.meta.dir);
const CLIENT_MODULE = {
  bun: resolve(TEST_DIR, "../src/utils/flair-client.ts"),
  node: resolve(TEST_DIR, "../dist/src/utils/flair-client.js"),
} as const;
type Runtime = keyof typeof CLIENT_MODULE;

/**
 * Entry points exercised by the child driver; route is the requested pathname.
 */
const ENTRIES = [
  { name: "request", method: "GET", route: "/Memory/mem-1" },
  { name: "registerAgent", method: "PUT", route: `/Agent/${AGENT}` },
  { name: "readStoredPublicKey", method: "GET", route: `/Agent/${AGENT}` },
] as const;

let workDir: string;
let keyPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "flair-redaction-"));
  keyPath = writeKeyFile(workDir, AGENT, SEED);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ─── The echoing server, behind the verifying stub ───────────────────────────

type EchoShape = "text" | "json" | "malformed";

interface SeenRequest {
  method: string;
  route: string;
  auth: string;
}

interface Echo {
  url: string;
  /** Requests the echo route ANSWERED (a verified signer, or the authorized operator). */
  seen: SeenRequest[];
  stop(): void;
}

/** The credential a request carries, for the body an echoing server returns. */
function carriedCredential(auth: string): { whole: string; decoded: string; fragment: string; signature: string } {
  if (auth.startsWith("Basic ")) {
    const b64 = auth.slice(6);
    return {
      whole: auth,
      decoded: Buffer.from(b64, "base64").toString("utf-8"),
      fragment: b64.slice(0, 12),
      signature: "",
    };
  }
  return { whole: auth, decoded: "", fragment: auth.slice(0, 12), signature: auth.split(":").pop() ?? "" };
}

/**
 * An 8+ char, code-shaped window of the request's credential — the value an
 * echoing server could choose to make look like a Flair error code. For a Basic
 * request it is a substring of the operator credential; for a signed request it
 * is the nonce (which is credential material the leak assertion checks).
 */
function codeShapedFragment(auth: string): string {
  const candidates = auth.startsWith("Basic ")
    ? [Buffer.from(auth.slice(6), "base64").toString("utf-8")]
    : [auth.split(":")[2] ?? "", auth.split(":")[3] ?? ""];
  for (const candidate of candidates) {
    const match = /[a-z0-9_.-]{8,64}/.exec(candidate);
    if (match) return match[0];
  }
  return "";
}

/** A response body that quotes the caller's credential in several shapes. */
function echoResponse(shape: EchoShape, auth: string): Response {
  const secret = carriedCredential(auth);
  switch (shape) {
    case "text": {
      const body = `denied Authorization=${secret.whole} decoded=${secret.decoded} fragment=${secret.fragment} signature=${secret.signature}`;
      return new Response(body, { status: 500, headers: { "Content-Type": "text/plain" } });
    }
    case "json": {
      // The `error` field itself carries a credential fragment that is ALSO
      // shaped like a Flair code (`[a-z0-9_.-]{8,}`): a shape test would pass it
      // through, so only an allow-list can refuse it. For a Basic request that
      // window is an 8+ char substring of the operator credential.
      const body = JSON.stringify({
        error: codeShapedFragment(auth),
        authorization: secret.whole,
        decoded: secret.decoded,
        fragment: secret.fragment,
        signature: secret.signature,
      });
      return new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
    }
    case "malformed": {
      // A 2xx body that is not valid JSON and carries a credential fragment: the
      // parser's own message would quote it.
      const body = `{"echo":"${secret.fragment}`;
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
}

/**
 * A fake Flair. A TPS-Ed25519 request reaches the shared verifying stub for a
 * REGISTERED signer; the stub refuses an unknown caller and a bad signature
 * before any route runs. A Basic request reaches an authorized fixture: only
 * the operator credential the fixture holds gets the echo, anything else is
 * refused 403 before it. `seen` records only requests the echo ANSWERED.
 */
function startEchoFlair(shape: EchoShape): Echo {
  const seen: SeenRequest[] = [];
  const record = (method: string, route: string, auth: string) => {
    seen.push({ method, route, auth });
  };
  const signed = stubFlairHandler({ [AGENT]: SEED }, (req, url) => {
    record(req.method, url.pathname, req.headers.get("Authorization") ?? "");
    return echoResponse(shape, req.headers.get("Authorization") ?? "");
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/Health") return new Response("ok");
      const auth = req.headers.get("Authorization") ?? "";
      if (auth.startsWith("Basic ")) {
        if (auth !== `Basic ${OPERATOR_B64}`) return new Response("forbidden", { status: 403 });
        record(req.method, url.pathname, auth);
        return echoResponse(shape, auth);
      }
      return signed(req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

/** A port nothing listens on, obtained by binding one and closing it. */
function deadUrl(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return `http://127.0.0.1:${port}`;
}

// ─── The child driver (Node and Bun) ─────────────────────────────────────────

interface Observation {
  name: string;
  threw: boolean;
  message?: string;
  fields?: string;
  auth?: string;
}

function childScript(specifier: string): string {
  return `
const { FlairClient } = await import(${JSON.stringify(specifier)});
const AGENT = ${JSON.stringify(AGENT)};
const OPERATOR = ${JSON.stringify(OPERATOR)};
const KEY_PATH = process.env.KEY_PATH;
const ECHO_URL = process.env.ECHO_URL;
const DEAD_URL = process.env.DEAD_URL;
const client = (baseUrl) => new FlairClient({ baseUrl, agentId: AGENT, keyPath: KEY_PATH });

function describeError(err) {
  const fields = [];
  let cur = err;
  for (let i = 0; cur != null && i < 8; i++) {
    if (cur instanceof Error) {
      fields.push(cur.name + ": " + cur.message);
      if (typeof cur.stack === "string") fields.push(cur.stack);
    } else {
      fields.push(String(cur));
    }
    if (typeof cur === "object") {
      for (const key of Object.keys(cur)) {
        if (key === "stack") continue;
        let value;
        try { value = cur[key]; } catch { value = "<unreadable>"; }
        fields.push(key + "=" + (typeof value === "string" ? value : JSON.stringify(value)));
      }
    }
    cur = cur && cur.cause;
  }
  return { message: err instanceof Error ? err.message : String(err), fields: fields.join("\\n") };
}

const observations = [];
async function capture(name, run) {
  try {
    await run();
    observations.push({ name, threw: false });
  } catch (err) {
    observations.push(Object.assign({ name, threw: true }, describeError(err)));
  }
}

const entryRuns = [
  ["request", (c) => c.getMemory("mem-1")],
  ["registerAgent", (c) => c.registerAgent(AGENT, "public-key", OPERATOR)],
  ["readStoredPublicKey", (c) => c.readStoredPublicKey(AGENT, OPERATOR)],
];

for (const [name, run] of entryRuns) await capture(name + ":echo", () => run(client(ECHO_URL)));

// A transport failure whose message AND cause quote the request's credential.
let mockedAuth = "";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  mockedAuth = (init && init.headers && init.headers.Authorization) || "";
  const error = new Error("connect failed for " + String(input) + " Authorization=" + mockedAuth);
  error.code = "ECONNREFUSED";
  error.cause = new Error("cause Authorization=" + mockedAuth);
  throw error;
};
for (const [name, run] of entryRuns) {
  mockedAuth = "";
  await capture(name + ":transport-mock", () => run(client(ECHO_URL)));
  observations[observations.length - 1].auth = mockedAuth;
}
globalThis.fetch = realFetch;

// A REAL transport failure under this runtime (a closed port), so each runtime's
// native error shape is exercised.
await capture("request:transport-real", () => client(DEAD_URL).getMemory("mem-1"));

process.stdout.write(JSON.stringify(observations) + "\\n");
`;
}

/** Run the driver under `runtime` and parse the JSON report it writes to stdout. */
function runChild(runtime: Runtime, env: Record<string, string>): Promise<Observation[]> {
  return new Promise((resolveReport, rejectReport) => {
    const child = spawn(runtime, ["--input-type=module", "-e", childScript(CLIENT_MODULE[runtime])], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectReport(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        expect(signal, `${runtime} child stderr:\n${stderr}`).toBeNull();
        expect(code, `${runtime} child stderr:\n${stderr}`).toBe(0);
        const line = stdout.split("\n").reverse().find((candidate) => candidate.trim().startsWith("["));
        expect(line, `${runtime} child produced no report:\n${stdout}\n${stderr}`).toBeDefined();
        resolveReport(JSON.parse(line!) as Observation[]);
      } catch (err) {
        rejectReport(err);
      }
    });
  });
}

// ─── The leak assertion ───────────────────────────────────────────────────────

/** Every credential value a request by `entry` carried, given the header it sent. */
function secretsFor(auth: string): string[] {
  if (auth.length === 0) return [];
  if (auth.startsWith("Basic ")) {
    const b64 = auth.slice(6);
    return [auth, b64, Buffer.from(b64, "base64").toString("utf-8"), OPERATOR, OPERATOR_B64];
  }
  const parts = auth.split(":");
  return [auth, parts[parts.length - 1] ?? "", parts[parts.length - 2] ?? "", parts[parts.length - 3] ?? ""];
}

/**
 * The error's message and every stack-visible field and cause link must contain
 * none of the credential, an 8+ char substring of it, the Authorization header
 * value, or the signature.
 */
function expectNoLeak(observation: Observation, secrets: readonly string[]): void {
  const haystack = `${observation.message ?? ""}\n${observation.fields ?? ""}`;
  for (const secret of new Set(secrets)) {
    expect(secret, "a fixture secret").not.toBeEmpty();
    expect(haystack, `the error carried the credential`).not.toContain(secret);
    for (let i = 0; i + 8 <= secret.length; i++) {
      expect(haystack, `the error carried an 8-char window of the credential`).not.toContain(secret.slice(i, i + 8));
    }
  }
}

// ─── The whitelist, per runtime and per response shape ───────────────────────

for (const runtime of ["bun", "node"] as const) {
  describe(
    `cli#597 — a non-OK response error contains only the entry point, method and requested path, status, and an allow-listed error code (else unrecognized_error); raw bodies, unlisted response text and transport messages are excluded (${runtime})`,
    () => {
    for (const shape of ["text", "json", "malformed"] as const) {
      test(`${runtime}: a ${shape} body echoing the credential never reaches the error (signed + Basic)`, async () => {
        const echo = startEchoFlair(shape);
        try {
          const observations = await runChild(runtime, { ECHO_URL: echo.url, DEAD_URL: deadUrl(), KEY_PATH: keyPath });

          for (const entry of ENTRIES) {
            const observed = observations.find((candidate) => candidate.name === `${entry.name}:echo`);
            expect(observed, `${entry.name} ran`).toBeDefined();
            expect(observed!.threw, `${entry.name} threw`).toBe(true);

            const auth = echo.seen.find((s) => s.method === entry.method && s.route === entry.route)?.auth ?? "";
            expect(auth, `${entry.name} reached the echo`).not.toBeEmpty();
            expectNoLeak(observed!, secretsFor(auth));

            // The WHOLE message is asserted by exact equality, so appending any
            // response text to a site — even text carrying no credential — fails.
            const tail = shape === "malformed" ? "200: malformed response body" : "500: unrecognized_error";
            expect(observed!.message).toBe(`Flair ${entry.name} ${entry.method} ${entry.route} → ${tail}`);
          }

          type Message = Observation["message"];
          const messageOf = (name: string): Message =>
            observations.find((candidate) => candidate.name === `${name}:echo`)?.message;

          if (shape === "json") {
            // The `error` field itself carried a value shaped like a Flair code
            // that is ALSO a credential fragment; it is not on the allow-list, so
            // the exact message names the constant and none of the fragment.
            for (const entry of ENTRIES) {
              const auth =
                echo.seen.find((s) => s.method === entry.method && s.route === entry.route)?.auth ?? "";
              const fragment = codeShapedFragment(auth);
              expect(fragment, "the code field carried a credential fragment").not.toBeEmpty();
              expect(messageOf(entry.name)).not.toContain(fragment);
            }
          }

          // A transport failure quotes the request in its message and cause; the
          // client names the entry point, method, pathname and a fixed reason class.
          // The whole message is asserted by exact equality, as for the response sites.
          for (const entry of ENTRIES) {
            const transport = observations.find((candidate) => candidate.name === `${entry.name}:transport-mock`);
            expect(transport, `${entry.name} transport ran`).toBeDefined();
            expect(transport!.threw).toBe(true);
            expect(transport!.message).toBe(
              `Flair ${entry.name} ${entry.method} ${entry.route} transport error: connection refused`,
            );
            expectNoLeak(transport!, secretsFor(transport!.auth ?? ""));
          }

          // The native transport failure's whole message is asserted by exact equality.
          const real = observations.find((candidate) => candidate.name === "request:transport-real");
          expect(real, "real transport ran").toBeDefined();
          expect(real!.threw).toBe(true);
          expect(real!.message).toBe("Flair request GET /Memory/mem-1 transport error: connection refused");
        } finally {
          echo.stop();
        }
      }, 30_000);
    }
  },
);
}

// ─── The verifying stub and the Basic fixture actually gate the echo ─────────

test("the verifying stub refuses an unregistered signer and a bad signature before the echo runs", async () => {
  const echo = startEchoFlair("text");
  try {
    const unregistered = new FlairClient({
      baseUrl: echo.url,
      agentId: "agent-unregistered",
      keyPath: writeKeyFile(workDir, "agent-unregistered", Buffer.alloc(32, 0x11)),
    });
    await expect(unregistered.getMemory("mem-1")).rejects.toThrow("→ 401: unknown_agent");

    const badSignature = new FlairClient({
      baseUrl: echo.url,
      agentId: AGENT,
      keyPath: writeKeyFile(workDir, "agent-bad", Buffer.alloc(32, 0x22)),
    });
    await expect(badSignature.getMemory("mem-1")).rejects.toThrow("→ 401: invalid_signature");

    // Neither reached the echo: the refusal is the stub's, before any route ran.
    expect(echo.seen).toEqual([]);
  } finally {
    echo.stop();
  }
});

/**
 * cli#597: request's non-OK response errors name listed codes verbatim and use
 * `unrecognized_error` for off-list `error` values. This is a fixed-list property;
 * route, verb and emitter reachability are not asserted.
 */
test("request's non-OK response errors name listed codes and use unrecognized_error for off-list values (cli#597)", async () => {
  let errorValue: unknown = null;
  const restore = patchShared(globalThis, "fetch", (async () =>
    new Response(JSON.stringify({ error: errorValue }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch);
  const messageFor = async (): Promise<string> => {
    try {
      await new FlairClient({ baseUrl: "http://127.0.0.1:9", agentId: AGENT, keyPath }).getMemory("mem-1");
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };
  try {
    expect(FLAIR_ERROR_CODES.length, "the list is non-empty").toBeGreaterThan(0);
    for (const code of FLAIR_ERROR_CODES) {
      errorValue = code;
      expect(await messageFor(), `the listed code ${code} is named verbatim`).toBe(
        `Flair request GET /Memory/mem-1 → 400: ${code}`,
      );
    }
    // Any value off the list becomes the constant, never echoed: a code-shaped
    // credential fragment, an unlisted code-shaped string, a non-string.
    for (const value of ["op-pass-4f9c", "unrecognized_error", "not_a_flair_code", 42, null, { error: "x" }]) {
      errorValue = value;
      expect(await messageFor(), `a value off the list (${JSON.stringify(value)}) becomes the constant`).toBe(
        "Flair request GET /Memory/mem-1 → 400: unrecognized_error",
      );
    }
  } finally {
    restore();
  }
});

/**
 * cli#597: membership is module-private. `FLAIR_ERROR_CODES` is exported as
 * a FROZEN ARRAY for inspection; membership is a private Set. Attempted writes
 * to the exported view cannot add a code that changes how a
 * non-OK response is formatted. Were the live Set exported again, the `add`
 * below would succeed and the injected code would be named verbatim, failing
 * this test.
 */
test("attempted writes to the frozen allow-list view leave non-OK response formatting unchanged (cli#597)", async () => {
  const injected = "injected_not_a_flair_code";
  const initialLength = FLAIR_ERROR_CODES.length;
  // The exported view as a consumer would reach it. `add` and `push` are tried
  // because the view is a frozen array while a live-Set regression would expose
  // `add`; `Reflect` stands in for an element write, a truncate and a delete
  // (the cli#568 guard classifies a bare index assignment as unclassified). Any
  // attempt to add a code must not land.
  const view = FLAIR_ERROR_CODES as unknown as {
    push?: (value: string) => unknown;
    add?: (value: string) => unknown;
  };
  for (const attempt of [
    () => view.push?.(injected),
    () => view.add?.(injected),
    () => Reflect.set(view, 0, injected),
    () => Reflect.set(view, "length", 0),
    () => Reflect.deleteProperty(view, 0),
  ]) {
    try {
      attempt();
    } catch {
      // frozen: the write throws
    }
  }

  // A non-OK response naming the injected value is still the constant: the
  // module-private membership test did not learn the code from the attempted
  // writes to the exported view. Were the live membership Set exported again,
  // `add` would land and this assertion would fail: the
  // injected code would be named verbatim.
  const restore = patchShared(globalThis, "fetch", (async () =>
    new Response(JSON.stringify({ error: injected }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch);
  try {
    let message = "";
    try {
      await new FlairClient({ baseUrl: "http://127.0.0.1:9", agentId: AGENT, keyPath }).getMemory("mem-1");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, "the injected code is not named").toBe("Flair request GET /Memory/mem-1 → 400: unrecognized_error");
  } finally {
    restore();
  }

  // Supporting: the view is frozen, still lacks the code, and is unchanged.
  expect(FLAIR_ERROR_CODES, "the injected code is not on the list").not.toContain(injected);
  expect(FLAIR_ERROR_CODES.length, "the view's length is unchanged").toBe(initialLength);
  expect(Object.isFrozen(FLAIR_ERROR_CODES), "the exported view is frozen").toBe(true);
});

test("the Basic fixture is authorized for the operator credential and refuses any other before the echo", async () => {
  const echo = startEchoFlair("json");
  try {
    const client = new FlairClient({ baseUrl: echo.url, agentId: AGENT, keyPath });
    await expect(client.readStoredPublicKey(AGENT, OPERATOR)).rejects.toThrow("→ 500: unrecognized_error");
    expect(echo.seen.at(-1)?.auth).toBe(`Basic ${OPERATOR_B64}`);

    const served = echo.seen.length;
    const refused = client.readStoredPublicKey(AGENT, WRONG_OPERATOR);
    await expect(refused).rejects.toThrow("→ 403");
    await expect(refused).rejects.not.toThrow("denied");
    expect(echo.seen.length).toBe(served);
  } finally {
    echo.stop();
  }
});

test("readStoredPublicKey names the ENCODED request path, the one the request used (cli#597)", async () => {
  const echo = startEchoFlair("json");
  try {
    const client = new FlairClient({ baseUrl: echo.url, agentId: AGENT, keyPath });
    const id = `${AGENT}/sub`;
    const encoded = `/Agent/${encodeURIComponent(id)}`;
    await expect(client.readStoredPublicKey(id, OPERATOR)).rejects.toThrow(
      `Flair readStoredPublicKey GET ${encoded}`,
    );
    // The reported path is the string the request carried, not a decoded one.
    await expect(client.readStoredPublicKey(id, OPERATOR)).rejects.not.toThrow(`/Agent/${id}`);
    expect(echo.seen.at(-1)?.route).toBe(encoded);
  } finally {
    echo.stop();
  }
});

/**
 * cli#597: getMemory() and registerAgent() encode the tested ids with
 * encodeURIComponent. Their reported pathnames are checked against the
 * echo server's recorded pathnames.
 */
test("getMemory and registerAgent encode ids and their response errors name the requested pathname, for '#', '?', '/' and '%' (cli#597)", async () => {
  const echo = startEchoFlair("text");
  const sentPathname: string[] = [];
  try {
    // `request()` reports the pathname of the URL it fetched.
    const client = new FlairClient({ baseUrl: echo.url, agentId: AGENT, keyPath });
    for (const ch of ["#", "?", "/", "%"]) {
      const id = `mem-1${ch}tail`;
      let message = "";
      try {
        await client.getMemory(id);
      } catch (err) {
        message = (err as Error).message;
      }
      const requested = echo.seen.at(-1)?.route ?? "";
      expect(requested, `an id containing '${ch}' reached the echo`).not.toBeEmpty();
      expect(requested, `the id is a single encoded segment ('${ch}')`).toBe(
        `/Memory/${encodeURIComponent(id)}`,
      );
      expect(message).toContain(`Flair request GET ${requested} → 500`);
      sentPathname.push(requested);
    }

    // `registerAgent` builds its own URL from the raw agent id.
    for (const ch of ["#", "?", "/", "%"]) {
      const id = `agent-a${ch}tail`;
      const raw = new FlairClient({ baseUrl: echo.url, agentId: id, keyPath });
      let message = "";
      try {
        await raw.registerAgent(id, "public-key", OPERATOR);
      } catch (err) {
        message = (err as Error).message;
      }
      const requested = echo.seen.at(-1)?.route ?? "";
      expect(requested, `an agent id containing '${ch}' reached the echo`).not.toBeEmpty();
      expect(requested, `the agent id is a single encoded segment ('${ch}')`).toBe(
        `/Agent/${encodeURIComponent(id)}`,
      );
      expect(message).toContain(`Flair registerAgent PUT ${requested} → 500`);
      sentPathname.push(requested);
    }

    // The recorded pathnames contain no fragment or query delimiters.
    for (const path of sentPathname) expect(path).not.toMatch(/[#?]/);
  } finally {
    echo.stop();
  }
});

// ─── Direct runAgent create command path: read-back remedy output ────────────

test("direct runAgent create read-back remedy prints the client error without the operator credential", async () => {
  const id = "redaction-create-agent";
  const home = mkdtempSync(join(tmpdir(), "redaction-create-"));
  const savedHome = process.env.HOME;
  const savedAdmin = process.env.FLAIR_ADMIN_AUTH;
  process.env.HOME = home;
  process.env.FLAIR_ADMIN_AUTH = OPERATOR;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(" "));
  });
  let exitCode: number | undefined;
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number): never => {
    exitCode = code;
    throw new Error(`exit:${code}`);
  }) as never);

  const signed = stubFlairHandler({});
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/Health") return new Response("ok");
      const auth = req.headers.get("Authorization") ?? "";
      if (auth.startsWith("Basic ")) {
        if (url.pathname === `/Agent/${id}` && req.method === "PUT") return new Response("{}", { status: 200 });
        if (url.pathname === `/Agent/${id}` && req.method === "GET") return echoResponse("text", auth);
        return new Response("not found", { status: 404 });
      }
      return signed(req);
    },
  });

  try {
    try {
      await runAgent({ action: "create", id, name: id, flairUrl: `http://127.0.0.1:${server.port}`, noSeed: true });
    } catch (err) {
      if (!String(err).includes("exit:")) throw err;
    }

    expect(exitCode).toBe(1);
    const printed = `${stdout.join("\n")}\n${stderr.join("\n")}`;
    expect(printed).toContain("the read-back failed");
    expect(printed).toContain("→ 500");
    expectNoLeak(
      { name: "tps agent create", threw: true, message: printed, fields: "" },
      [`Basic ${OPERATOR_B64}`, OPERATOR_B64, OPERATOR],
    );
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    server.stop(true);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAdmin === undefined) delete process.env.FLAIR_ADMIN_AUTH;
    else process.env.FLAIR_ADMIN_AUTH = savedAdmin;
    rmSync(home, { recursive: true, force: true });
  }
});
