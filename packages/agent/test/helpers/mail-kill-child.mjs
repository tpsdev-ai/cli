// mail-kill-child.mjs — test helper for cli#600.
//
// Runs a REAL MailClient.checkNewMail() in a child process that a test can
// SIGKILL at an injected pause point BEFORE a named filesystem operation, so an
// interrupted first delivery is simulated with a KILLED process (never an
// injected error).
//
// The pause point is injected by wrapping node:fs BEFORE the mail module is
// loaded, so the mail module's `import { … } from "node:fs"` bindings resolve to
// the wrappers.
//
// argv:  <mailDir> <agentId>
// env:   TPS_MAIL_MODULE  file:// URL of the mail module
//        TPS_DRIVE        "checkNewMail" (default) or "deliverNext"
//        TPS_KILL_AT      symbolic step boundary (see BOUNDARIES below), or
//                         "after-delivery": no filesystem boundary; with
//                         TPS_DRIVE=deliverNext the child blocks, ALIVE, after
//                         deliverNext() hands a message over and before it is
//                         completed or released (a held local token)
//        TPS_KILL_AFTER   "1" pauses AFTER the matched op completes
//        TPS_KILL_MARKER  marker file written just before blocking
//        TPS_MAIL_ROOT    the mailbox root (<mailDir>/<agentId>)
//        TPS_SRC, TPS_CUR the new/<file> source and its cur/<file> sibling
//        TPS_FROM         the sender id the verifier resolves
//        TPS_SEED         base64 Ed25519 seed for the sender
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const origWrite = fs.writeFileSync;

const KILL_AT = process.env.TPS_KILL_AT ?? "";
const KILL_AFTER = process.env.TPS_KILL_AFTER === "1";
const MARKER = process.env.TPS_KILL_MARKER;
const ROOT = process.env.TPS_MAIL_ROOT ?? "";
const SRC = process.env.TPS_SRC ?? "";
const CUR = process.env.TPS_CUR ?? "";
const LEDGER = join(ROOT, "consumed.jsonl");

const isIntent = (p) => typeof p === "string" && basename(p).startsWith(".placement-") && p.endsWith(".json");
// The phase transition writes the intent via a `.phase.tmp` scratch file.
const isPhaseScratch = (p) => typeof p === "string" && p.endsWith(".phase.tmp");

// fn -> predicate over the call's arguments: true means "pause HERE".
const BOUNDARIES = {
  "intent-write": (name, args) => name === "renameSync" && isIntent(args[1]),
  "link-to-cur": (name, args) => name === "linkSync" && args[1] === CUR,
  "source-removal": (name, args) => name === "unlinkSync" && args[0] === SRC,
  "ledger-commit": (name, args) => name === "appendFileSync" && args[0] === LEDGER,
  "intent-finish": (name, args) => name === "unlinkSync" && isIntent(args[0]),
  // cli#617 slice (b): the `in_progress` phase write (placing -> in_progress).
  "phase-write": (name, args) => name === "renameSync" && isIntent(args[1]) && isPhaseScratch(args[0]),
};
const HOLD_AFTER_DELIVERY = KILL_AT === "after-delivery";
const matches = HOLD_AFTER_DELIVERY ? () => false : BOUNDARIES[KILL_AT];
if (!matches) {
  process.stderr.write(`mail-kill-child: unknown TPS_KILL_AT=${JSON.stringify(KILL_AT)}\n`);
  process.exit(2);
}

let paused = false;
function pause() {
  paused = true;
  if (MARKER) origWrite.call(fs, MARKER, "paused");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    /* spin until killed */
  }
  process.exit(3);
}
for (const name of ["writeFileSync", "openSync", "linkSync", "appendFileSync", "rmSync", "unlinkSync", "renameSync"]) {
  const orig = fs[name];
  fs[name] = function (...args) {
    if (KILL_AFTER) {
      const result = orig.apply(this, args);
      if (!paused && matches(name, args)) pause();
      return result;
    }
    if (!paused && matches(name, args)) pause();
    return orig.apply(this, args);
  };
}

const [mailDir, agentId] = process.argv.slice(2);
const ed = await import("@noble/ed25519");
const seed = Buffer.from(process.env.TPS_SEED, "base64");
const from = process.env.TPS_FROM;
const mod = await import(process.env.TPS_MAIL_MODULE);
const client = new mod.MailClient(mailDir, undefined, agentId, {
  async getAgent(name) {
    return name === from ? { publicKey: Buffer.from(ed.getPublicKey(seed)) } : null;
  },
});
let count;
if ((process.env.TPS_DRIVE ?? "checkNewMail") === "deliverNext") {
  const result = await client.deliverNext();
  count = result.status === "delivered" ? 1 : 0;
  if (HOLD_AFTER_DELIVERY && result.status === "delivered") pause();
} else {
  count = (await client.checkNewMail()).length;
}
process.stdout.write(JSON.stringify({ count }));
process.exit(0);