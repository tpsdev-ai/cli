// start-token-source.mjs — TEST-ONLY support for cli#1045.
//
// processStartToken (packages/agent) reads `/proc/<pid>/stat` with
// `fs.readFileSync` and falls back to `ps -o lstart=` when that read fails. The
// production package has no hook to change that choice; tests change what the
// READ returns instead, by wrapping `fs.readFileSync`:
//
//   "ps"   — every `/proc/<pid>/stat` read fails as absent (ENOENT), so the
//            `ps` fallback runs where /proc exists too (Linux CI).
//   "proc" — the real file where it is readable; otherwise, for a live pid, a
//            stat line whose starttime is the pid, so a `proc:` token can be
//            staged where /proc is absent (macOS). The staged value is the same
//            in every process, so a preloaded CLI subprocess agrees with the test.
//
// Every other call is forwarded unchanged, with all of its arguments.
//
// Installed three ways, all from test code: `spyOn` on the `node:fs` namespace
// inside a bun test (start-token-source-test.ts), `bun --preload` for a bun
// child, and `node --import` for a node child (the two preload files beside
// this one). Plain JS so that node can preload it. It loads `node:fs` through
// `require` only: an ESM import of `node:fs` here would bind the program's
// imports before the preload patches them.
import { createRequire, syncBuiltinESMExports } from "node:module";

const STAT_PATH = /^\/proc\/(\d+)\/stat$/;

/** The ENOENT the "ps" mode throws, marked so it can be told from a real one. */
function forcedAbsent(path) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}' (start-token-source: forced)`), {
    code: "ENOENT",
    startTokenSourceForced: true,
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** A stat line whose fields after `comm` are the state `S`, eighteen zeros, and starttime = pid. */
function stagedStatLine(pid) {
  return `${pid} (staged) S ${Array(18).fill("0").join(" ")} ${pid}`;
}

/** Wrap `real` (a readFileSync) for `mode` ("ps" or "proc"); see the header. */
export function wrapReadFileSync(real, mode) {
  if (mode !== "ps" && mode !== "proc") throw new Error(`unknown start-token source mode: ${mode}`);
  return function readFileSync(...args) {
    const path = args[0];
    const match = typeof path === "string" ? STAT_PATH.exec(path) : null;
    if (match === null) return real(...args);
    if (mode === "ps") throw forcedAbsent(path);
    try {
      return real(...args);
    } catch (error) {
      const pid = Number(match[1]);
      if (!isAlive(pid)) throw error;
      const line = stagedStatLine(pid);
      const options = args[1];
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? line : Buffer.from(line);
    }
  };
}

/**
 * For a preload: replace `readFileSync` on the CommonJS `fs` module before the
 * program's modules load, and resync the ESM bindings (node needs this; bun's
 * preload is seen by later imports either way).
 */
export function installForPreload(mode) {
  const fs = createRequire(import.meta.url)("node:fs");
  fs.readFileSync = wrapReadFileSync(fs.readFileSync, mode);
  syncBuiltinESMExports();
}
