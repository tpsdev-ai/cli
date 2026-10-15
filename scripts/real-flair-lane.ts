#!/usr/bin/env bun
/**
 * real-flair-lane.ts — the runner for the real-Flair lane (cli#520).
 *
 * It starts ONE scratch Flair (the helper in
 * `packages/cli/test/helpers/scratch-flair.ts`), runs every test file that carries
 * the `TPS_TEST_REAL_FLAIR=1` opt-in through the HOME-isolated suite launcher
 * (`scripts/test-suite.mjs`), and stops the instance in a `finally` so the job
 * leaves no process and no tree behind. The tests read the instance's loopback
 * ports from the environment, so no path crosses into the sandboxed child.
 *
 * Run it with bun (it imports TypeScript):
 *   bun scripts/real-flair-lane.ts
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startScratchFlair, stopScratchFlair } from "../packages/cli/test/helpers/scratch-flair.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = join(REPO, "packages", "cli");
const TEST_DIR = join(CLI_DIR, "test");

/** Every `.test.ts` under `packages/cli/test` that opts into the real-Flair cases. */
function markedFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/[._]test\.ts$/.test(entry.name) && readFileSync(path, "utf8").includes("TPS_TEST_REAL_FLAIR")) {
        found.push(relative(CLI_DIR, path).replaceAll("\\", "/"));
      }
    }
  };
  walk(TEST_DIR);
  return found.sort();
}

const files = markedFiles();
if (files.length === 0) {
  console.error("real-flair lane: no test file under packages/cli/test carries TPS_TEST_REAL_FLAIR");
  process.exit(1);
}
console.log(`real-flair lane: ${files.length} marked file(s): ${files.join(", ")}`);

const flair = await startScratchFlair();
console.log(`real-flair lane: scratch Flair on http://127.0.0.1:${flair.httpPort} (ops :${flair.opsPort})`);
let code = 1;
try {
  const run = spawnSync("node", [join(REPO, "scripts", "test-suite.mjs"), "real-flair", ...files], {
    cwd: CLI_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      TPS_TEST_REAL_FLAIR: "1",
      TPS_TEST_FLAIR_HTTP_PORT: String(flair.httpPort),
      TPS_TEST_FLAIR_OPS_PORT: String(flair.opsPort),
    },
  });
  code = run.status ?? 1;
} finally {
  await stopScratchFlair(flair);
  console.log(`real-flair lane: stopped the scratch Flair and removed ${flair.root}`);
}
process.exit(code);
