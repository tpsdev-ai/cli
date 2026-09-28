/**
 * reviewer-launch.mjs — the trusted launcher for a review build.
 *
 * In the image it is /opt/reviewer/bin/reviewer-launch: an explicit command,
 * never the entrypoint (OpenClaw starts the sandbox as `<image> sleep infinity`
 * with a read-only root and tmpfs on /tmp, /var/tmp and /run).
 *
 * Before ANY repository code runs it:
 *   1. reads the trusted runtime table (/opt/reviewer/runtime-matrix.json — no
 *      override) and the image's baked identity (/opt/reviewer/image-id);
 *   2. reads the CI job the HOST names (REVIEWER_CI_WORKFLOW + REVIEWER_CI_JOB in
 *      the sandbox env) and plans it (ci-job.mjs), refusing what it cannot honour;
 *   3. reads the workspace's declarations (package.json packageManager/engines,
 *      .nvmrc, .node-version, .bun-version, .tool-versions) plus the job's
 *      runtime pins and resolves them to one matrix image (resolve-runtime.mjs);
 *   4. refuses unless that image is THIS image;
 *   5. creates the hermetic HOME/TMPDIR/cache directories under /tmp/review and
 *      builds the child environment from an allowlist (hermetic values, PATH,
 *      LANG, LC_ALL, TERM, TZ, CI=true) — nothing else is inherited;
 *   6. measures the actual node and bun a step would run and verifies them
 *      against the image entry and every resolved requirement.
 * Only then does it run each `run:` step of the job, in order, as one script in
 * its working directory under `bash --noprofile --norc -eo pipefail`. It reports
 * review-build-ok only when every step exited 0 and no lockfile changed.
 *
 * stdout carries exactly one JSON line (the verdict); step output and refusals
 * go to stderr. Exit 0 = review-build-ok, 1 = refused or failed, 2 = usage.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { JOB_ID_RE, planJob, WORKFLOW_PATH_RE } from "./ci-job.mjs";
import { resolveRuntime, satisfiesRange } from "./resolve-runtime.mjs";

/** Where the image keeps the launcher's trusted inputs. Fixed: no flag moves it. */
export const TRUSTED_DIR = "/opt/reviewer";
/** The launcher-owned scratch root: a tmpfs in the OpenClaw run model. */
export const HERMETIC_ROOT = "/tmp/review";

/** Hermetic HOME/tmp/cache locations under a root. */
export function hermeticLayout(root = HERMETIC_ROOT) {
  return {
    HOME: `${root}/home`,
    USERPROFILE: `${root}/home`,
    TMPDIR: `${root}/tmp`,
    TMP: `${root}/tmp`,
    TEMP: `${root}/tmp`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
    npm_config_cache: `${root}/cache/npm`,
    BUN_INSTALL_CACHE_DIR: `${root}/cache/bun`,
    BUN_TMPDIR: `${root}/tmp`,
    PIP_CACHE_DIR: `${root}/cache/pip`,
    GOCACHE: `${root}/cache/go`,
  };
}

/** The image's defaults (the Dockerfile ENV sets exactly these). */
export const HERMETIC = hermeticLayout();
export const HERMETIC_KEYS = Object.keys(HERMETIC);
/** The only values a child takes from the launcher's own environment. */
export const PASSTHROUGH_KEYS = ["PATH", "LANG", "LC_ALL", "TERM", "TZ"];
/** Keys a workflow's env: may not set: the launcher owns them. */
export const RESERVED_ENV_KEYS = [...HERMETIC_KEYS, ...PASSTHROUGH_KEYS, "CI"];

/**
 * Build the child environment from an ALLOWLIST: the hermetic values, PATH,
 * LANG, LC_ALL, TERM and TZ from the parent, and CI=true. Every other parent
 * variable — tokens, git/npm/bun config redirections, anything — is absent.
 */
export function hermeticEnv(parentEnv = {}, root = HERMETIC_ROOT) {
  const env = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (typeof parentEnv[key] === "string") env[key] = parentEnv[key];
  }
  Object.assign(env, hermeticLayout(root));
  env.CI = "true";
  return env;
}

const refuse = (kind, message) => ({ ok: false, refusal: { kind, message } });

/** Normalize requirements to [{tool, range, source}]; accepts {node, bun} too. */
function requirementList(requirements) {
  if (Array.isArray(requirements)) return requirements;
  return Object.entries(requirements ?? {})
    .filter(([, range]) => typeof range === "string")
    .map(([tool, range]) => ({ tool, range, source: "requirement" }));
}

/**
 * Verify the ACTUAL runtime versions against the selected image entry and every
 * requirement.
 * @returns {{ok:true, receipt:object} | {ok:false, refusal:{kind:string, message:string}}}
 */
export function verifyRuntime({ image, actual, requirements = [] }) {
  if (!image || typeof image.node !== "string" || typeof image.bun !== "string") {
    return refuse("no-image", "no selected runtime entry was supplied");
  }
  if (actual?.node !== image.node) {
    return refuse(
      "version-mismatch",
      `actual node ${actual?.node ?? "(not found)"} does not match the selected image entry node ${image.node}; stopping the review build`,
    );
  }
  if (actual?.bun !== image.bun) {
    return refuse(
      "version-mismatch",
      `actual bun ${actual?.bun ?? "(not found)"} does not match the selected image entry bun ${image.bun}; stopping the review build`,
    );
  }
  const list = requirementList(requirements);
  for (const req of list) {
    const got = req.tool === "node" ? actual.node : req.tool === "bun" ? actual.bun : undefined;
    if (got === undefined) {
      return refuse("unsupported", `no runtime in this image provides ${req.tool} (required by ${req.source})`);
    }
    if (!satisfiesRange(got, req.range)) {
      return refuse(
        "unsupported",
        `actual ${req.tool} ${got} does not satisfy ${req.range} (required by ${req.source}); stopping the review build`,
      );
    }
  }
  return {
    ok: true,
    receipt: { image_id: image.id, node: actual.node, bun: actual.bun, requirements_verified: list.length },
  };
}

/** Verify a downloaded artifact's checksum against the trusted entry. */
export function verifyArtifact(entry, actualSha256) {
  if (!entry || typeof entry.sha256 !== "string") {
    return { ok: false, refusal: { kind: "no-entry", message: "no trusted artifact entry was supplied" } };
  }
  if (entry.sha256 !== actualSha256) {
    return {
      ok: false,
      refusal: {
        kind: "checksum-failure",
        message: `artifact checksum mismatch: expected ${entry.sha256}, got ${actualSha256}`,
      },
    };
  }
  return { ok: true };
}

/** The trusted table and this image's baked identity. */
export function readIdentity(trustedDir, parentEnv = {}) {
  let table;
  try {
    table = JSON.parse(readFileSync(join(trustedDir, "runtime-matrix.json"), "utf8"));
  } catch {
    return refuse("image-identity", `the trusted runtime table ${join(trustedDir, "runtime-matrix.json")} is missing or unreadable; this is not a reviewer image`);
  }
  let imageId;
  try {
    imageId = readFileSync(join(trustedDir, "image-id"), "utf8").trim();
  } catch {
    imageId = "";
  }
  if (imageId === "") {
    return refuse("image-identity", `this sandbox carries no baked image identity (${join(trustedDir, "image-id")}); it is not a reviewer image`);
  }
  if (parentEnv.REVIEWER_IMAGE_ID !== undefined && parentEnv.REVIEWER_IMAGE_ID !== imageId) {
    return refuse(
      "image-identity",
      `REVIEWER_IMAGE_ID=${parentEnv.REVIEWER_IMAGE_ID} disagrees with the image's baked identity ${imageId}`,
    );
  }
  const entry = (Array.isArray(table.images) ? table.images : []).find((i) => i.id === imageId);
  if (!entry) return refuse("image-identity", `the baked identity ${imageId} is not an image in the trusted table`);
  return { ok: true, table, imageId, entry };
}

/** The CI job the host names in the sandbox env. */
export function hostJob(parentEnv = {}) {
  const workflow = parentEnv.REVIEWER_CI_WORKFLOW;
  const job = parentEnv.REVIEWER_CI_JOB;
  if (!workflow || !job) {
    return refuse(
      "no-ci-job",
      "the host names no CI job: set REVIEWER_CI_WORKFLOW (e.g. .github/workflows/test.yml) and REVIEWER_CI_JOB (e.g. test) in the reviewer's sandbox env",
    );
  }
  if (!WORKFLOW_PATH_RE.test(workflow)) {
    return refuse("no-ci-job", `REVIEWER_CI_WORKFLOW "${workflow}" is not a .github/workflows/<name>.yml path`);
  }
  if (!JOB_ID_RE.test(job)) return refuse("no-ci-job", `REVIEWER_CI_JOB "${job}" is not a job id`);
  return { ok: true, workflow, job };
}

const RUNTIME_FILES = [".nvmrc", ".node-version", ".bun-version", ".tool-versions"];

/** The workspace's runtime declarations. */
export function readDeclarations(workspace) {
  const runtimeFiles = {};
  for (const name of RUNTIME_FILES) {
    let text;
    try {
      text = readFileSync(join(workspace, name), "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      return refuse("invalid-declaration", `${name} exists but cannot be read as a file (${err?.code ?? "error"})`);
    }
    runtimeFiles[name] = text;
  }
  let manifest = {};
  let raw = null;
  try {
    raw = readFileSync(join(workspace, "package.json"), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") return refuse("invalid-declaration", `package.json exists but cannot be read (${err?.code ?? "error"})`);
  }
  if (raw !== null) {
    try {
      manifest = JSON.parse(raw);
    } catch {
      return refuse("invalid-declaration", "package.json is not valid JSON");
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      return refuse("invalid-declaration", "package.json is not a JSON object");
    }
  }
  return { ok: true, manifest, runtimeFiles };
}

const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);

/** SHA-256 of every lockfile in the workspace (node_modules and .git excluded, symlinks not followed). */
export function snapshotLockfiles(workspace) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && LOCKFILES.has(e.name)) {
        out.set(relative(workspace, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
      }
    }
  };
  walk(workspace);
  return out;
}

/** Lockfiles that changed, appeared or disappeared between two snapshots. */
export function lockfileDrift(before, after) {
  const drift = [];
  for (const path of before.keys()) {
    if (!after.has(path)) drift.push(`${path} (deleted)`);
    else if (after.get(path) !== before.get(path)) drift.push(`${path} (changed)`);
  }
  for (const path of after.keys()) if (!before.has(path)) drift.push(`${path} (created)`);
  return drift;
}

/** Recreate the hermetic root and every directory the layout names (mode 0700). */
export function prepareHermeticRoot(root) {
  rmSync(root, { recursive: true, force: true });
  const dirs = new Set([root, join(root, "steps"), ...Object.values(hermeticLayout(root))]);
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The node and bun a step would run: looked up on the CHILD's PATH. */
export function probeActualVersions(env) {
  const options = { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  const read = (run) => {
    try {
      return run().trim().replace(/^v/, "");
    } catch {
      return null;
    }
  };
  return {
    node: read(() => execFileSync("node", ["--version"], options)),
    bun: read(() => execFileSync("bun", ["--version"], options)),
  };
}

/** Run one step as a script file under bash, the way the Actions runner does. */
export function bashStep({ step, workspace, scriptDir, env }) {
  const script = join(scriptDir, `step-${String(step.index).padStart(2, "0")}.sh`);
  writeFileSync(script, step.script, { mode: 0o600 });
  return new Promise((resolveCode) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: join(workspace, step.workingDirectory),
      env: { ...env, ...step.env },
      // stdout of a step goes to stderr: the launcher's stdout is its verdict.
      stdio: ["ignore", 2, 2],
    });
    child.on("error", () => resolveCode(127));
    child.on("close", (code) => resolveCode(code ?? 1));
  });
}

/** Run the steps in order. After a failure only `always()` steps still run. */
export async function runSteps(steps, runStep) {
  const results = [];
  let failed = null;
  for (const step of steps) {
    if (failed && !step.always) {
      results.push({ step: step.index, name: step.name, skipped: "an earlier step failed" });
      continue;
    }
    const code = await runStep(step);
    results.push({ step: step.index, name: step.name, code });
    if (code !== 0 && !failed) failed = { step: step.index, name: step.name, code };
  }
  return failed ? { ok: false, results, failed } : { ok: true, results };
}

/**
 * The review build. Every input that decides WHAT runs is read here, in order,
 * before anything is spawned; `trustedDir`, `hermeticRoot`, `probe` and
 * `runStep` are injectable for host tests only (the CLI passes the constants).
 */
export async function reviewBuild({
  workspace,
  trustedDir = TRUSTED_DIR,
  hermeticRoot = HERMETIC_ROOT,
  parentEnv = {},
  probe = probeActualVersions,
  runStep = bashStep,
}) {
  const identity = readIdentity(trustedDir, parentEnv);
  if (!identity.ok) return identity;

  const named = hostJob(parentEnv);
  if (!named.ok) return named;
  let workflowText;
  try {
    workflowText = readFileSync(join(workspace, named.workflow), "utf8");
  } catch {
    return refuse("no-ci-job", `the reviewed commit has no ${named.workflow}`);
  }
  const plan = planJob({ workflowText, workflowFile: named.workflow, jobId: named.job, reservedEnvKeys: RESERVED_ENV_KEYS });
  if (!plan.ok) return plan;

  const declarations = readDeclarations(workspace);
  if (!declarations.ok) return declarations;
  const resolved = resolveRuntime({
    table: identity.table,
    manifest: declarations.manifest,
    runtimeFiles: declarations.runtimeFiles,
    ciConstraints: plan.pins,
  });
  if (!resolved.ok) return resolved;
  if (resolved.image.id !== identity.imageId) {
    return refuse(
      "wrong-image",
      `the reviewed commit resolves to ${resolved.image.id} (node ${resolved.node}, bun ${resolved.bun}) but this sandbox is ${identity.imageId}; run the review in ${resolved.image.id}`,
    );
  }

  prepareHermeticRoot(hermeticRoot);
  const env = hermeticEnv(parentEnv, hermeticRoot);
  if (plan.shims.length > 0) env.PATH = `${join(trustedDir, "shims")}${env.PATH ? `:${env.PATH}` : ""}`;

  const verified = verifyRuntime({ image: identity.entry, actual: probe(env), requirements: resolved.requirements });
  if (!verified.ok) return verified;

  const before = snapshotLockfiles(workspace);
  const scriptDir = join(hermeticRoot, "steps");
  const outcome = await runSteps(plan.steps, (step) => runStep({ step, workspace, scriptDir, env }));
  if (!outcome.ok) {
    return {
      ...refuse("stage-failed", `step ${outcome.failed.step} (${outcome.failed.name}) exited ${outcome.failed.code}`),
      steps: outcome.results,
    };
  }
  const drift = lockfileDrift(before, snapshotLockfiles(workspace));
  if (drift.length > 0) {
    return {
      ...refuse("unfrozen-install", `the build changed lockfiles (${drift.join(", ")}); a review build requires a frozen install`),
      steps: outcome.results,
    };
  }
  return {
    ok: true,
    status: "review-build-ok",
    image: identity.imageId,
    node: verified.receipt.node,
    bun: verified.receipt.bun,
    workflow: plan.workflow,
    job: plan.job,
    steps: outcome.results,
    skipped: plan.skipped,
  };
}

/** Verify the image's own runtimes against its baked entry (no workspace). */
export function selfCheck({ trustedDir = TRUSTED_DIR, parentEnv = {}, probe = probeActualVersions }) {
  const identity = readIdentity(trustedDir, parentEnv);
  if (!identity.ok) return identity;
  const result = verifyRuntime({ image: identity.entry, actual: probe({ PATH: parentEnv.PATH ?? "" }) });
  if (!result.ok) return result;
  return { ok: true, status: "self-check-ok", ...result.receipt };
}

// ─── Container entry ─────────────────────────────────────────────────────────

function emit(result) {
  if (result.ok) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  process.stderr.write(`refused: ${result.refusal.kind}: ${result.refusal.message}\n`);
  process.stdout.write(`${JSON.stringify({ status: "refused", ...result.refusal, steps: result.steps })}\n`);
  return 1;
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--self-check") return emit(selfCheck({ parentEnv: process.env }));
  let workspace = "/workspace";
  if (args.length === 2 && args[0] === "--workspace") workspace = args[1];
  else if (args.length !== 0) {
    process.stderr.write("usage: reviewer-launch [--workspace <dir>] | reviewer-launch --self-check\n");
    return 2;
  }
  return emit(await reviewBuild({ workspace, parentEnv: process.env }));
}

// Only act as an entry point when executed directly.
if (process.argv[1]?.endsWith("reviewer-launch.mjs")) {
  main(process.argv).then((code) => process.exit(code));
}
