/**
 * cli#395 — the archive runtime adapter: one `archive.db`, two runtimes.
 *
 * Under bun `utils/archive.ts` uses `bun:sqlite`; under node it uses
 * `node:sqlite` (`DatabaseSync`, Node >= 22.13). Same file path, same schema, so
 * a host's archive is ONE database whichever runtime wrote it. These tests spawn
 * the REAL `node` binary against the built CLI dist and read/write the same
 * `archive.db` from both runtimes:
 *
 *  - node writes an event; the in-process (bun) reader sees it, and node reads it
 *    back;
 *  - bun writes an event; node reads it back;
 *  - each runtime writes a batch to one file while the other runs;
 *  - the shared CLI promote(), run under node, logs the `read` event.
 *
 * The `node:sqlite`-dependent cases are gated on the `node` under test actually
 * exposing the binding (probed ONCE below). Where it is absent — Node < 22.13
 * without `--experimental-sqlite`, e.g. Debian bookworm's apt `nodejs` — the
 * documented fallback is exercised instead: one named warning, no throw,
 * nothing written. The absent path is never a silent skip; the probe logs the
 * node version and which suite it selected.
 *
 * Precondition: the CLI is built (`dist/src/utils/*.js` exists) — root `bun run
 * build` does that before `bun run test`.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent, queryArchive } from "../src/utils/archive.js";
import { sendMessage, getInbox } from "../src/utils/mail.js";
import { startStubFlair, writeKeyFile, buildSignedEnvelope, type StubFlair } from "./helpers/stub-flair.js";

const here = dirname(fileURLToPath(import.meta.url));
const utilsDir = resolve(here, "..", "dist", "src", "utils");
const archiveJs = resolve(utilsDir, "archive.js");
const mailJs = resolve(utilsDir, "mail.js");

const DEADLINE_MS = 30_000;
const FLINT_SEED = Buffer.alloc(32, 0x01);
const KERN_SEED = Buffer.alloc(32, 0x02);

// Must match the adapter's one-per-process warning in `src/utils/archive.ts`.
const ARCHIVE_UNAVAILABLE_WARNING =
  "tps-mail archive: no sqlite backend in this runtime (neither bun:sqlite nor node:sqlite); mail events are not being logged";

// The node under test is the one the cases below spawn. Probe it ONCE for
// `node:sqlite` (the same bare specifier the adapter resolves) and announce the
// choice with the node version, so a missing binding is visible in the log and
// never silently skipped.
const nodeHasSqlite = spawnSync("node", ["-e", "require('node:sqlite')"], {
  encoding: "utf8",
  timeout: DEADLINE_MS,
}).status === 0;
const nodeVersion = (spawnSync("node", ["--version"], { encoding: "utf8", timeout: DEADLINE_MS }).stdout || "unknown").trim();
console.log(
  `[archive-runtime-adapter] node ${nodeVersion}: node:sqlite ${
    nodeHasSqlite ? "available — running the cross-runtime suite" : "UNAVAILABLE — running the fallback suite"
  }`,
);

function runNode(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: DEADLINE_MS,
    killSignal: "SIGKILL",
    env,
  });
}

function runNodeAsync(script: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn("node", ["--input-type=module", "-e", script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

describe("archive runtime adapter (cli#395)", () => {
  let tempRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tps-archive-adapter-"));
    savedEnv = {};
    for (const k of ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.HOME = tempRoot;
    process.env.TPS_MAIL_DIR = join(tempRoot, "mail");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test.if(nodeHasSqlite)(
    "node writes through the adapter; the bun path reads it back",
    () => {
      expect(existsSync(archiveJs)).toBe(true);
      const script = `
        const a = await import(${JSON.stringify(archiveJs)});
        a.logEvent({ event: "sent", from: "node", to: "kern", messageId: "node-msg-1" }, "written by node");
        console.log("WROTE");
      `;
      const res = runNode(script, process.env);
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("WROTE");

      // The in-process (bun) reader sees the row node wrote — one database.
      const events = queryArchive();
      const written = events.find((e) => e.messageId === "node-msg-1");
      expect(written).toBeDefined();
      expect(written!.event).toBe("sent");
      expect(written!.from).toBe("node");
      expect(written!.to).toBe("kern");
      expect(written!.body).toBe("written by node");
    },
    DEADLINE_MS + 5_000,
  );

  test.if(nodeHasSqlite)(
    "node reads back an event the bun path wrote (reverse)",
    () => {
      logEvent({ event: "read", from: "kern", to: "flint", messageId: "bun-msg-1" }, "written by bun");

      const script = `
        const a = await import(${JSON.stringify(archiveJs)});
        const rows = a.queryArchive().filter((r) => r.messageId === "bun-msg-1");
        console.log("ROWS=" + JSON.stringify(rows));
      `;
      const res = runNode(script, process.env);
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("bun-msg-1");

      const marker = res.stdout.split("ROWS=")[1] ?? "";
      const rows = JSON.parse(marker.split("\n")[0]!) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event).toBe("read");
      expect(rows[0]!.body).toBe("written by bun");
    },
    DEADLINE_MS + 5_000,
  );

  test.if(nodeHasSqlite)(
    "each runtime writes a batch to one file while the other runs",
    async () => {
      const N = 20;
      const script = `
        const a = await import(${JSON.stringify(archiveJs)});
        for (let i = 0; i < ${N}; i++) {
          a.logEvent({ event: "sent", from: "node", to: "kern", messageId: "node-" + i }, "batch node " + i);
        }
        console.log("DONE");
      `;
      const child = runNodeAsync(script, process.env);
      for (let i = 0; i < N; i++) {
        logEvent({ event: "sent", from: "bun", to: "kern", messageId: "bun-" + i }, `batch bun ${i}`);
      }
      const res = await child;
      expect(res.code).toBe(0);
      expect(res.out).toContain("DONE");

      // Every write from BOTH runtimes landed in the one file: no lost writer.
      const events = queryArchive({ limit: N * 2 + 10 });
      const nodeRows = events.filter((e) => e.messageId.startsWith("node-"));
      const bunRows = events.filter((e) => e.messageId.startsWith("bun-"));
      expect(nodeRows).toHaveLength(N);
      expect(bunRows).toHaveLength(N);
    },
    DEADLINE_MS + 5_000,
  );

  test.if(nodeHasSqlite)(
    "the shared CLI promote() under node logs a 'read' event into archive.db",
    async () => {
      const stub: StubFlair = startStubFlair({ flint: FLINT_SEED, kern: KERN_SEED });
      try {
        const key = writeKeyFile(join(tempRoot, "keys"), "kern", KERN_SEED);
        process.env.FLAIR_URL = stub.url;
        process.env.FLAIR_KEY_PATH = key;

        const env = buildSignedEnvelope("flint", "kern", "hello under node", { flint: FLINT_SEED });
        sendMessage("kern", JSON.stringify(env), "flint");
        const inbox = getInbox("kern");
        const [file] = readdirSync(inbox.fresh).filter((f) => f.endsWith(".json"));
        expect(file).toBeDefined();
        const filePath = join(inbox.fresh, file!);

        expect(existsSync(mailJs)).toBe(true);
        const script = `
          const m = await import(${JSON.stringify(mailJs)});
          const res = await m.promote("kern", ${JSON.stringify(filePath)});
          console.log("RESULT=" + JSON.stringify(res.ok ? { ok: true, id: res.message.id } : { ok: false, cls: res.class }));
        `;
        const res = await runNodeAsync(script, process.env);
        expect(res.code).toBe(0);
        expect(res.out).toContain('"ok":true');
        // The id the child logged: promote()'s `read` event carries the promoted
        // record's id (the wrapper id), not the envelope messageId.
        const childId = /"id":"([^"]+)"/.exec(res.out)?.[1];
        expect(childId).toBeDefined();

        // The promote() under node wrote the same archive.db the bun reader reads.
        const reads = queryArchive({ event: "read" });
        const read = reads.find((e) => e.messageId === childId);
        expect(read).toBeDefined();
        expect(read!.from).toBe("flint");
        expect(read!.to).toBe("kern");
      } finally {
        stub.stop();
      }
    },
    DEADLINE_MS + 5_000,
  );

  test.skipIf(nodeHasSqlite)(
    "no node:sqlite in the node under test: logEvent/queryArchive are a visible no-op",
    () => {
      expect(existsSync(archiveJs)).toBe(true);
      const script = `
        const a = await import(${JSON.stringify(archiveJs)});
        let threw = false;
        try {
          a.logEvent({ event: "sent", from: "node", to: "kern", messageId: "noop-1" }, "x");
          a.logEvent({ event: "sent", from: "node", to: "kern", messageId: "noop-2" }, "y");
        } catch { threw = true; }
        console.log("THREW=" + threw);
        console.log("QUERY=" + JSON.stringify(a.queryArchive()));
      `;
      const res = runNode(script, process.env);
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("THREW=false");
      expect(res.stdout).toContain("QUERY=[]");
      // One named warning for the process, however many entry points hit it.
      const hits = res.stderr.split(ARCHIVE_UNAVAILABLE_WARNING).length - 1;
      expect(hits).toBe(1);
      // Nothing was written: no archive.db under the isolated mail dir.
      expect(existsSync(join(tempRoot, "mail", "archive.db"))).toBe(false);
    },
    DEADLINE_MS + 5_000,
  );
});
