#!/usr/bin/env node
/**
 * run-tests.mjs — the isolated launcher for the openclaw-github-review suite.
 *
 * Creates a throwaway root, points HOME at it, and runs `bun test` with bun's
 * JUnit reporter writing to test-reports/github-review.xml (the record the
 * repo-wide coverage guard reads). The suite's console output is kept beside it
 * as github-review.log. Both, and the seal, are deleted before the run and the
 * report is sealed when it exits — the same contract the other suites follow
 * (cli#411, cli#414).
 *
 * USAGE
 *   node scripts/run-tests.mjs [bun test args…]
 *   TPS_TEST_KEEP_ROOT=1 node scripts/run-tests.mjs   # keep the temp root
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUITE = "github-review";
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.env.TPS_TEST_KEEP_ROOT === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-github-review-test-")));

const env = { ...process.env };
delete env.TPS_TEST_ROOT;
Object.assign(env, { HOME: root, TPS_TEST_ROOT: root });

console.log(`openclaw-github-review tests: isolated root ${root}`);

// The gateway-boundary lane loads the BUILT plugin entry (dist/src/index.js)
// through OpenClaw's real registration machinery, so the build must reflect the
// current sources. Build first and refuse to run if it fails.
const tsc = join(pluginDir, "node_modules", "typescript", "bin", "tsc");
const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: pluginDir, stdio: "inherit" });
if (build.status !== 0) {
  console.error(`openclaw-github-review tests: build failed (exit ${build.status}); refusing to run the suite`);
  process.exit(1);
}

const repoRoot = resolve(pluginDir, "..", "..");
const reportDir = process.env.TPS_TEST_REPORT_DIR ? resolve(process.env.TPS_TEST_REPORT_DIR) : join(repoRoot, "test-reports");
mkdirSync(reportDir, { recursive: true });
const reportXml = join(reportDir, `${SUITE}.xml`);
const reportLog = join(reportDir, `${SUITE}.log`);
const reportSeal = join(reportDir, `${SUITE}.xml.sha256`);
rmSync(reportXml, { force: true });
rmSync(reportLog, { force: true });
rmSync(reportSeal, { force: true });

const passthrough = process.argv.slice(2);
const args = ["test", ...(passthrough.length ? passthrough : ["test/"])];
if (!args.some((a) => a.startsWith("--reporter"))) {
  args.push("--reporter=junit", `--reporter-outfile=${reportXml}`);
}
const child = spawn("bun", args, { cwd: pluginDir, env, stdio: ["inherit", "pipe", "pipe"] });

const logStream = createWriteStream(reportLog, { flags: "w" });
child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
});
child.on("error", (err) => {
  console.error(`openclaw-github-review tests: could not launch bun: ${err.message}`);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (keep) console.log(`openclaw-github-review tests: kept isolated root ${root}`);
  else {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  logStream.end(() => {
    try {
      if (existsSync(reportXml)) {
        const hash = createHash("sha256").update(readFileSync(reportXml)).digest("hex");
        const expected = `${hash}  ${SUITE}\n`;
        writeFileSync(reportSeal, expected);
        if (readFileSync(reportSeal, "utf8") !== expected) throw new Error("seal did not read back as written");
      }
    } catch (err) {
      console.error(`openclaw-github-review tests: could not seal the report: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = signal ? 1 : (code ?? 1);
  });
});
