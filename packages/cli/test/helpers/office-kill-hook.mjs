// office-kill-hook.mjs — test support for cli#602.
//
// Loaded as a bun `--preload` module before `tps office connect` starts and
// before the CLI's own modules, so `import { writeFileSync } from "node:fs"`
// resolves to these wrappers (the CJS namespace object is mutated). The hook
// blocks at a named step boundary in the relay acceptance path so a test can
// SIGKILL the command there — a crash simulated with a killed process, never an
// injected error.
//
// env:
//   TPS_KILL_AT      step boundary (see BOUNDARIES); an unknown value exits 2
//   TPS_KILL_MARKER  marker file written just before the process blocks
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const origWriteFileSync = fs.writeFileSync;

const KILL_AT = process.env.TPS_KILL_AT ?? "";
const MARKER = process.env.TPS_KILL_MARKER ?? "";

// The acceptance receipt is written to `<marker>.tmp` under `.relay-accepted/`
// before it is renamed into place: a kill here is between publishing the inbox
// record and finishing the delivery.
const isAcceptanceReceiptTemp = (path) =>
  typeof path === "string" && path.includes("/.relay-accepted/") && path.endsWith(".tmp");
// `office connect` announces a delivery with a single `console.log` of a
// "Mail received" line; the line does not name the delivery. Blocking here is
// before the line is printed.
const announcesMail = (args) => typeof args[0] === "string" && args[0].includes("Mail received");

// kind -> predicate over the call's arguments; true means "block HERE".
const BOUNDARIES = {
  "accept-marker": (kind, args) => kind === "writeFileSync" && isAcceptanceReceiptTemp(args[0]),
  announce: (kind, args) => kind === "consoleLog" && announcesMail(args),
};

const matches = BOUNDARIES[KILL_AT];
if (!matches) {
  process.stderr.write(`office-kill-hook: unknown TPS_KILL_AT=${JSON.stringify(KILL_AT)}\n`);
  process.exit(2);
}

let paused = false;
function block(kind, args) {
  if (paused) return;
  paused = true;
  if (MARKER) origWriteFileSync.call(fs, MARKER, `${kind}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    /* spin until the test kills this process */
  }
  process.exit(3);
}

const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function (...args) {
  if (matches("writeFileSync", args)) block("writeFileSync", args);
  return writeFileSync.apply(this, args);
};

const consoleLog = console.log;
console.log = function (...args) {
  if (matches("consoleLog", args)) block("consoleLog", args);
  return consoleLog.apply(console, args);
};
