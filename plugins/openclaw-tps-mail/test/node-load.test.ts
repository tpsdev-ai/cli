/**
 * cli#394 — NODE-LOAD reproduction.
 *
 * The OpenClaw gateway runs this plugin under NODE, not bun. The plugin's
 * module graph reaches `@tpsdev-ai/cli/utils/mail` → `utils/archive.js`, which
 * used to statically `import { Database } from "bun:sqlite"`. NODE's ESM loader
 * rejects the `bun:` URL scheme at module-graph load, so the plugin failed to
 * load entirely (gateway starts with the plugin missing; reviewer mail is dead).
 * Every test ran under `bun test`, where `bun:sqlite` resolves, so nothing saw it.
 *
 * This test spawns the REAL `node` binary against the BUILT plugin entry. It is
 * the assertion that reproduces the failure: on the pre-fix tree the child exits
 * 2 with ERR_UNSUPPORTED_ESM_URL_SCHEME; after the fix it prints LOADED and exits 0.
 *
 * Precondition: the workspace (packages/cli, packages/agent) and this plugin are
 * built, so `dist/src/index.js` and the CLI's `dist/src/utils/*.js` exist.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const entry = join(pluginRoot, "dist", "src", "index.js");

/** Hard deadline for the child: a hung loader must fail the test, not hang CI. */
const DEADLINE_MS = 30_000;

describe("node-load (cli#394): the built plugin must load under node", () => {
  test(
    "spawns node importing the built plugin entry; exits 0 and prints LOADED",
    () => {
      expect(existsSync(entry)).toBe(true);
      const script = `import(${JSON.stringify(entry)}).then(()=>console.log("LOADED")).catch(e=>{console.error(e.code);process.exit(2)})`;
      const res = spawnSync("node", ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: DEADLINE_MS,
        killSignal: "SIGKILL",
      });

      const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
      // Surface the real failure text if the loader rejects the graph.
      expect(combined).toContain("LOADED");
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
    },
    DEADLINE_MS + 5_000,
  );

  test(
    "spawns node REQUIRING the built plugin entry (the gateway loads plugins through a require-style path); exits 0 and prints REQUIRE_OK",
    () => {
      // Before this fix: ERR_REQUIRE_ASYNC_MODULE — a top-level await in archive.ts made the
      // whole graph un-requirable while import() still passed, and the gateway refused it.
      expect(existsSync(entry)).toBe(true);
      const script = `try{require(${JSON.stringify(entry)});console.log("REQUIRE_OK")}catch(e){console.error(e.code||"",String(e.message).split("\\n")[0]);process.exit(2)}`;
      const res = spawnSync("node", ["-e", script], {
        encoding: "utf8",
        timeout: DEADLINE_MS,
        killSignal: "SIGKILL",
      });

      const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
      expect(combined).toContain("REQUIRE_OK");
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
    },
    DEADLINE_MS + 5_000,
  );
});
