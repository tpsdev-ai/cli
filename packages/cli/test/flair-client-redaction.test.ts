/**
 * cli#597 — the Flair client's errors never carry credential material.
 *
 * The client used to build an error from a response body and from a transport
 * failure's message and cause, so a server that echoed the request's credential
 * (whole, as a fragment, as an encoding, or as a signature component) put it into
 * the thrown error. Exact-value redaction cannot be the control: a fragment, a
 * base64 slice or an Ed25519 signature component survives it, and a JSON parse
 * error can quote a fragment of the body too.
 *
 * The guarantee is a WHITELIST. An error the client builds names only safe,
 * client-constructed context — the entry point, the method and path (never the
 * query), the HTTP status and, when the body is JSON with a short `error` code,
 * that code. A transport failure is named by a fixed reason class derived from
 * the error's `code`, never its message. A successful response whose body is not
 * JSON throws a safe error. No response body, transport message, parser message
 * or original `cause` is ever included.
 *
 * The entry points that surface errors are driven twice here, per the repo's
 * convention (cli#395, cli#566): in-process, and in a spawned `node` child that
 * imports the built dist (`dist/src/utils/flair-client.js`). The echo server sits
 * behind the shared VERIFYING stub (`helpers/stub-flair.ts`) for a registered
 * signer; the Basic paths sit behind an authorized fixture with its own refusal.
 *
 * Precondition: the CLI is built — root `bun run build` does that before
 * `bun run test`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "../src/commands/agent.js";
import { FlairClient } from "../src/utils/flair-client.js";
import { stubFlairHandler, writeKeyFile } from "./helpers/stub-flair.js";

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

/** The three entry points that build errors. The route is the path without its query. */
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

/** A response body that quotes the caller's credential in several shapes. */
function echoResponse(shape: EchoShape, auth: string): Response {
  const secret = carriedCredential(auth);
  switch (shape) {
    case "text": {
      const body = `denied Authorization=${secret.whole} decoded=${secret.decoded} fragment=${secret.fragment} signature=${secret.signature}`;
      return new Response(body, { status: 500, headers: { "Content-Type": "text/plain" } });
    }
    case "json": {
      const body = JSON.stringify({
        error: "denied",
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
    `cli#597 — Flair client errors contain only the entry point, method and path, status, and a short server error code when present; response bodies and transport messages are never included (${runtime})`,
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

            // The error names only safe, client-constructed context.
            expect(observed!.message).toContain(`Flair ${entry.name} ${entry.method} ${entry.route}`);
            expect(observed!.message).not.toContain("Authorization=");
          }

          type Message = Observation["message"];
          const messageOf = (name: string): Message =>
            observations.find((candidate) => candidate.name === `${name}:echo`)?.message;

          if (shape === "json") {
            // The one response value that IS named: a short server `error` code.
            for (const entry of ENTRIES) expect(messageOf(entry.name)).toContain("→ 500: denied");
          } else if (shape === "malformed") {
            for (const entry of ENTRIES) expect(messageOf(entry.name)).toContain("→ 200: malformed response body");
          } else {
            for (const entry of ENTRIES) expect(messageOf(entry.name)).toContain("→ 500");
          }

          // A transport failure quotes the request in its message and cause; the
          // client names only the entry point, route and a fixed reason class.
          for (const entry of ENTRIES) {
            const transport = observations.find((candidate) => candidate.name === `${entry.name}:transport-mock`);
            expect(transport, `${entry.name} transport ran`).toBeDefined();
            expect(transport!.threw).toBe(true);
            expect(transport!.message).toContain("transport error: connection refused");
            expectNoLeak(transport!, secretsFor(transport!.auth ?? ""));
          }

          // A real transport failure under this runtime, same guarantee.
          const real = observations.find((candidate) => candidate.name === "request:transport-real");
          expect(real, "real transport ran").toBeDefined();
          expect(real!.threw).toBe(true);
          expect(real!.message).toContain("Flair request GET /Memory/mem-1 transport error: ");
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

test("the Basic fixture is authorized for the operator credential and refuses any other before the echo", async () => {
  const echo = startEchoFlair("json");
  try {
    const client = new FlairClient({ baseUrl: echo.url, agentId: AGENT, keyPath });
    await expect(client.readStoredPublicKey(AGENT, OPERATOR)).rejects.toThrow("→ 500: denied");
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

// ─── A real printing caller: `tps agent create`'s read-back remedy ────────────

test("tps agent create's read-back remedy prints the client error without the operator credential", async () => {
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
