/**
 * cli#394 — NODE behaviour of the CLI's mail-archive utility.
 *
 * `utils/mail.js` statically imports `utils/archive.js`; the OpenClaw gateway
 * loads the plugin under NODE, so BOTH must load there. These tests spawn the
 * REAL `node` binary against the built CLI dist:
 *
 *  - importing `utils/mail.js` (calling nothing) must exit 0;
 *  - calling `logEvent` under node must return without throwing, `queryArchive`
 *    must return an empty list, and the "archive unavailable" note must be
 *    printed exactly ONCE per process (visible gap, never silent, never spammy).
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
const NOTE = "mail archive unavailable under this runtime (no bun:sqlite); events are not being logged";

function runNode(script: string) {
  return spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: DEADLINE_MS,
    killSignal: "SIGKILL",
  });
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
    "logEvent is a visible no-op under node: returns, prints the note once",
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
      const res = runNode(script);
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
