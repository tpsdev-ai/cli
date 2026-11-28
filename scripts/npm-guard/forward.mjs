#!/usr/bin/env node
// The npm/npx shim forwarder (cli#948): decide first; refuse before spawning the
// recorded npm or starting an installation; otherwise spawn the recorded npm
// with the decided argv.

import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { decide } from "./policy.mjs";
import { formatRefusal } from "./refusal.mjs";
import { recordedNpmPath, selectRoot } from "./paths.mjs";

const [tool, ...argv] = process.argv.slice(2);
const job = process.env.GITHUB_JOB;
const action = process.env.GITHUB_ACTION;

function stop(reason) {
  process.stderr.write(formatRefusal({ tool, argv, job, action, reason }));
  process.exit(1);
}

const decision = decide(tool, argv, job);
if (!decision.allow) stop(decision.reason);

const chosen = selectRoot();
if (!chosen.ok) stop(chosen.reason);

const recorded = recordedNpmPath(chosen.root);
let realNpm = "";
try {
  realNpm = readFileSync(recorded, "utf8").trim();
} catch {
  stop("the recorded npm file is missing");
}
if (!isAbsolute(realNpm)) stop("the recorded npm file does not hold an absolute path");
try {
  accessSync(realNpm, constants.X_OK);
} catch {
  stop("the recorded npm is not executable");
}

const result = spawnSync(realNpm, decision.argv, { stdio: "inherit" });
if (result.error) stop("the recorded npm could not be started");
process.exit(result.status === null ? 1 : result.status);
