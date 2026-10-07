// promote-kill-child.mjs — test helper for cli#515.
//
// Runs a REAL promote() in a child process that a test can SIGKILL at an
// injected pause point BEFORE a named filesystem operation, so an interrupted
// first delivery is simulated with a KILLED process (never an injected error).
//
// The pause point is injected by wrapping node:fs BEFORE the mail module is
// loaded, so the mail module's `import { … } from "node:fs"` bindings resolve to
// the wrappers. When the wrapped call at the named boundary fires, the child
// writes a marker file and then spins until the parent SIGKILLs it — the paused
// operation never runs, so the on-disk state is exactly "everything before it".
//
// argv:  <agent> <sourcePath>
// env:   TPS_PROMOTE_MODULE  file:// URL of the built mail module
//        TPS_KILL_AT         symbolic step boundary (see the table below)
//        TPS_KILL_MARKER     marker file written just before blocking
//        TPS_MAIL_ROOT       the mailbox root (<maildir>/<agent>)
//        TPS_SRC, TPS_CUR    the source new/<file> and its cur/<file> sibling
import { createRequire } from "node:module";
import { basename, join, sep } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const origWrite = fs.writeFileSync;

const KILL_AT = process.env.TPS_KILL_AT ?? "";
const MARKER = process.env.TPS_KILL_MARKER;
const ROOT = process.env.TPS_MAIL_ROOT ?? "";
const SRC = process.env.TPS_SRC ?? "";
const CUR = process.env.TPS_CUR ?? "";
const LEDGER = join(ROOT, "consumed.jsonl");
const TMP = join(ROOT, "tmp") + sep;

const isScratch = (p) => typeof p === "string" && p.startsWith(TMP) && p.endsWith(".promote");
const isIntentTmp = (p) => typeof p === "string" && basename(p).startsWith(".placement-") && p.endsWith(".tmp");
const isIntent = (p) => typeof p === "string" && basename(p).startsWith(".placement-") && p.endsWith(".json");

// fn -> predicate over the call's arguments: true means "pause HERE".
const BOUNDARIES = {
  "scratch-write": (name, args) => name === "writeFileSync" && isScratch(args[0]),
  "intent-write": (name, args) => name === "openSync" && isIntentTmp(args[0]),
  "link-to-cur": (name, args) => name === "linkSync" && args[1] === CUR,
  "scratch-removal": (name, args) => name === "rmSync" && isScratch(args[0]),
  "ledger-commit": (name, args) => name === "appendFileSync" && args[0] === LEDGER,
  "source-removal": (name, args) => name === "rmSync" && args[0] === SRC,
  "intent-finish": (name, args) => name === "unlinkSync" && isIntent(args[0]),
};
const matches = BOUNDARIES[KILL_AT];
if (!matches) {
  process.stderr.write(`promote-kill-child: unknown TPS_KILL_AT=${JSON.stringify(KILL_AT)}\n`);
  process.exit(2);
}

let paused = false;
for (const name of ["writeFileSync", "openSync", "linkSync", "appendFileSync", "rmSync", "unlinkSync", "renameSync"]) {
  const orig = fs[name];
  fs[name] = function (...args) {
    if (!paused && matches(name, args)) {
      paused = true;
      if (MARKER) origWrite.call(fs, MARKER, "paused");
      // Hard upper bound: spin no longer than 60s, then fail loudly. The parent
      // SIGKILLs within a few tens of ms; a timeout means the boundary was never
      // reached, which the parent reports as a test failure.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        /* spin until killed */
      }
      process.exit(3);
    }
    return orig.apply(this, args);
  };
}

const [agent, source] = process.argv.slice(2);
const mod = await import(process.env.TPS_PROMOTE_MODULE);
const result = await mod.promote(agent, source);
process.stdout.write(JSON.stringify({ ok: result.ok, class: result.ok ? null : result.class }));
process.exit(0);
