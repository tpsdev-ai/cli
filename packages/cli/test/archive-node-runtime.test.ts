/**
 * cli#394 / cli#395 — NODE behaviour of the CLI's mail-archive utility.
 *
 * `utils/mail.js` statically imports `utils/archive.js`; the OpenClaw gateway
 * loads the plugin under NODE, so BOTH must load there. These tests spawn the
 * REAL `node` binary against the built CLI dist:
 *
 *  - importing `utils/mail.js` (calling nothing) must exit 0;
 *  - when no SQLite backend exists (cli#395: `--no-experimental-sqlite` removes
 *    `node:sqlite`, the pre-22.13 shape), calling `logEvent` must return without
 *    throwing, `queryArchive` must return an empty list, and the named warning
 *    must be printed exactly ONCE per process (visible gap, never silent, never
 *    spammy). The live node path — with `node:sqlite` present — is covered by
 *    archive-runtime-adapter.test.ts.
 *
 * Precondition: the CLI is built (`dist/src/utils/*.js` exists) — root `bun run
 * build` does that before `bun run test`.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const utilsDir = resolve(here, "..", "dist", "src", "utils");
const mailJs = resolve(utilsDir, "mail.js");
const archiveJs = resolve(utilsDir, "archive.js");

const DEADLINE_MS = 30_000;
const NOTE =
  "tps-mail archive: no sqlite backend in this runtime (neither bun:sqlite nor node:sqlite); mail events are not being logged";

function runNode(script: string, nodeArgs: string[] = []) {
  return spawnSync("node", [...nodeArgs, "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: DEADLINE_MS,
    killSignal: "SIGKILL",
  });
}

// `--no-experimental-sqlite` removes node:sqlite on a node that has it. A node older than 22.5
// rejects the flag (exit 9) and has no node:sqlite anyway, so it needs no flag to reproduce the
// no-backend condition (the Docker lane runs such a node).
function noSqliteNodeArgs(): string[] {
  return runNode("", ["--no-experimental-sqlite"]).status === 0 ? ["--no-experimental-sqlite"] : [];
}

describe("archive under node (cli#394)", () => {
  test(
    "utils/mail.js imports under node without calling anything",
    () => {
      expect(existsSync(mailJs)).toBe(true);
      const res = runNode(`await import(${JSON.stringify(mailJs)}); console.log("MAIL_IMPORTED");`);
      expect(res.stdout).toContain("MAIL_IMPORTED");
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
    },
    DEADLINE_MS + 5_000,
  );

  test(
    "no SQLite backend (old node): logEvent is a visible no-op, prints the warning once",
    () => {
      expect(existsSync(archiveJs)).toBe(true);
      const script = `
        const a = await import(${JSON.stringify(archiveJs)});
        let threw = false;
        try { a.logEvent({ event: "sent", from: "a", to: "b", messageId: "1" }, "x"); } catch { threw = true; }
        a.logEvent({ event: "sent", from: "a", to: "b", messageId: "2" }, "y");
        console.log("THREW=" + threw);
        console.log("QUERY=" + JSON.stringify(a.queryArchive()));
      `;
      // `--no-experimental-sqlite` makes `node:sqlite` unresolvable, reproducing
      // a node older than 22.13 on this modern runner.
      const res = runNode(script, noSqliteNodeArgs());
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("THREW=false");
      expect(res.stdout).toContain("QUERY=[]");

      const notes = (res.stderr ?? "").split("\n").filter((l) => l.includes(NOTE));
      expect(notes).toHaveLength(1);
    },
    DEADLINE_MS + 5_000,
  );
});
