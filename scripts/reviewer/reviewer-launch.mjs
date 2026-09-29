/**
 * reviewer-launch.mjs — the trusted launcher for a review build.
 *
 * review-build-ok is ADVISORY EVIDENCE for the reviewer, not a merge gate: CI
 * stays the gate on every PR. What the launcher must hold is the trust
 * boundary — no credential and no host access reachable from the review. How
 * closely a review build predicts CI is best effort, with its known limits
 * named in docker/reviewer/README.md.
 *
 * In the image it is /opt/reviewer/bin/reviewer-launch: an explicit command,
 * never the entrypoint (OpenClaw starts the sandbox as `<image> sleep infinity`
 * with a read-only root and tmpfs on /tmp, /var/tmp and /run). Build mode takes
 * no arguments and builds the worktree the host mounted at /workspace; only
 * `--self-check` is accepted besides.
 *
 * Before ANY repository code runs it:
 *   1. reads the trusted runtime table (/opt/reviewer/runtime-matrix.json — no
 *      override) and the image's baked identity (/opt/reviewer/image-id);
 *   2. reads the host's assignment — REVIEWER_CI_WORKFLOW, REVIEWER_CI_JOB and
 *      REVIEWER_CI_BASE — from the environment the HOST gave the sandbox when it
 *      created it (the container init's environment, /proc/1/environ), and
 *      refuses if its own caller supplied different values. That process runs
 *      as the same user as the sandbox; the assignment's integrity relies on the
 *      deployed sandbox denying same-user process-memory writes (ptrace), a
 *      host-integration check not yet in place (tpsdev-ai/cli#436);
 *   3. refuses symlinked lockfiles and symlinked directories in the worktree
 *      (outside node_modules/ and .git/) and hashes every lockfile;
 *   4. plans the named job and its `needs` closure (ci-job.mjs), refusing what it
 *      cannot honour, and reads the workspace's declarations (package.json
 *      packageManager/engines, .nvmrc, .node-version, .bun-version,
 *      .tool-versions — each bounded, contained in the worktree) plus every
 *      planned job's runtime pins and resolves them to one matrix image;
 *   5. refuses unless that image is THIS image;
 *   6. creates the hermetic HOME/TMPDIR/cache directories under /tmp/review and
 *      builds the child environment from an allowlist (hermetic values, a FIXED
 *      PATH, LANG, LC_ALL, TERM, TZ, CI=true) — nothing else is inherited;
 *   7. runs the image's own node and bun (fixed paths) and verifies their
 *      versions against the image entry and every resolved requirement.
 * Then, per job in dependency order: it removes what earlier jobs of this build
 * created, gives the job a fresh HOME/TMPDIR/cache root, refuses a worktree
 * whose effective git configuration leaves the safe baseline or whose
 * repository holds hooks, and refuses unless the worktree passes the
 * clean-clone check actions/checkout's skip relies on (checkFreshClone: HEAD and
 * remote URLs/refspecs unchanged since the build started, no assume-unchanged
 * or skip-worktree bits, git status clean, history shaped as fetch-depth asks —
 * not a byte comparison with a host-pinned commit; per-job isolation is
 * tpsdev-ai/cli#435). It runs each `run:` step as one script
 * under `/bin/bash --noprofile --norc -eo pipefail`, in its own process group,
 * after re-checking the step's effective environment and the RESOLVED working
 * directory (it must stay inside the worktree); it kills a `run:` step at its
 * timeout-minutes, and the job's steps at the job's (default 360), and kills
 * what the job left running when it ends. A job runs only if the jobs it needs
 * succeeded (or its `if:` is always()). After every job it refuses symlinked
 * lockfiles and symlinked directories and any lockfile change. It reports
 * review-build-ok only when every job in the closure ran and every step exited
 * 0.
 *
 * stdout carries exactly one JSON line (the verdict); step output and refusals
 * go to stderr. Exit 0 = review-build-ok, 1 = refused or failed, 2 = usage.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { BRANCH_RE, forbiddenEnvReason, JOB_ID_RE, MAX_WORKFLOW_BYTES, planJob, WORKFLOW_PATH_RE } from "./ci-job.mjs";
import { resolveRuntime, satisfiesRange } from "./resolve-runtime.mjs";

/** Where the image keeps the launcher's trusted inputs. Fixed: no flag moves it. */
export const TRUSTED_DIR = "/opt/reviewer";
/** The worktree the host mounts (OpenClaw's sandbox workdir). Fixed: no flag moves it. */
export const WORKSPACE = "/workspace";
/** The launcher-owned scratch root: a tmpfs in the OpenClaw run model. */
export const HERMETIC_ROOT = "/tmp/review";
/** The environment the host gave the sandbox at creation: the container init's. */
export const CREATION_ENV_PATH = "/proc/1/environ";
/** Fixed executables: never looked up on a caller's PATH. */
export const BASH = "/bin/bash";
export const GIT = "/usr/bin/git";
export const TRUSTED_BINARIES = Object.freeze({ node: "/usr/local/bin/node", bun: "/usr/local/bin/bun" });
/** The PATH every step gets (Debian's default); the caller's PATH is never used. */
export const STEP_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** The host assignment's variables. */
export const ASSIGNMENT_KEYS = Object.freeze({
  workflow: "REVIEWER_CI_WORKFLOW",
  job: "REVIEWER_CI_JOB",
  base: "REVIEWER_CI_BASE",
});

/** Bounds on what the launcher reads from the worktree. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_VERSION_FILE_BYTES = 64 * 1024;
export const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
export const MAX_SCAN_ENTRIES = 200_000;
export const MAX_SCAN_DEPTH = 64;

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
export const PASSTHROUGH_KEYS = ["LANG", "LC_ALL", "TERM", "TZ"];
/** Keys a workflow's env: may not set: the launcher owns them. */
export const RESERVED_ENV_KEYS = [...HERMETIC_KEYS, ...PASSTHROUGH_KEYS, "PATH", "CI"];

/**
 * Build the child environment from an ALLOWLIST: the hermetic values, the fixed
 * STEP_PATH, LANG, LC_ALL, TERM and TZ from the parent, and CI=true. Every other
 * parent variable — PATH, tokens, git/npm/bun config redirections — is absent.
 */
export function hermeticEnv(parentEnv = {}, root = HERMETIC_ROOT) {
  const env = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (typeof parentEnv[key] === "string") env[key] = parentEnv[key];
  }
  Object.assign(env, hermeticLayout(root));
  env.PATH = STEP_PATH;
  env.CI = "true";
  return env;
}

const refuse = (kind, message) => ({ ok: false, refusal: { kind, message } });
const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Check a step's EFFECTIVE environment immediately before it runs: every key the
 * launcher owns must carry the launcher's value, and no other key may be
 * credential-shaped or redirect configuration (ci-job.mjs forbiddenEnvReason).
 */
export function checkStepEnv(effective, launcherEnv) {
  for (const [key, value] of Object.entries(effective)) {
    if (Object.hasOwn(launcherEnv, key)) {
      if (value !== launcherEnv[key]) return refuse("step-env", `a step would run with ${key} changed from the launcher's value`);
      continue;
    }
    const reason = forbiddenEnvReason(key);
    if (reason) return refuse("step-env", `a step would run with ${key}: ${reason}`);
  }
  return { ok: true };
}

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

/** Parse a NUL-separated environ block (/proc/<pid>/environ), or null when unreadable. */
export function readCreationEnv(path = CREATION_ENV_PATH) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    return null;
  }
  const env = {};
  for (const entry of raw.toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0 && !Object.hasOwn(env, entry.slice(0, eq))) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The host's assignment: taken ONLY from the environment the host gave the
 * sandbox at creation. The launcher's own caller may repeat a value but never
 * change or add one. The init process holding that environment runs as the
 * sandbox's own user: the value is only as immutable as the deployed sandbox
 * makes same-user process memory (no ptrace capability, Yama ptrace_scope >= 1),
 * which PR 3's host-integration lane must check against the real run config.
 */
export function hostAssignment(creationEnv, processEnv = {}) {
  if (!creationEnv) {
    return refuse(
      "no-ci-job",
      `the sandbox's creation environment (${CREATION_ENV_PATH}) is unreadable, so the host's assignment cannot be established`,
    );
  }
  for (const key of Object.values(ASSIGNMENT_KEYS)) {
    if (processEnv[key] !== undefined && processEnv[key] !== creationEnv[key]) {
      return refuse(
        "assignment-override",
        `${key} in the launcher's environment differs from what the host set when it created the sandbox; the assignment comes only from the host`,
      );
    }
  }
  const workflow = creationEnv[ASSIGNMENT_KEYS.workflow];
  const job = creationEnv[ASSIGNMENT_KEYS.job];
  const base = creationEnv[ASSIGNMENT_KEYS.base];
  if (!workflow || !job || !base) {
    return refuse(
      "no-ci-job",
      "the host names no CI job: set REVIEWER_CI_WORKFLOW (e.g. .github/workflows/test.yml), REVIEWER_CI_JOB (e.g. test) and REVIEWER_CI_BASE (e.g. main) in the reviewer's sandbox env",
    );
  }
  if (!WORKFLOW_PATH_RE.test(workflow)) {
    return refuse("no-ci-job", `REVIEWER_CI_WORKFLOW "${workflow}" is not a .github/workflows/<name>.yml path`);
  }
  if (!JOB_ID_RE.test(job)) return refuse("no-ci-job", `REVIEWER_CI_JOB "${job}" is not a job id`);
  if (!BRANCH_RE.test(base)) return refuse("no-ci-job", `REVIEWER_CI_BASE "${base}" is not a branch name`);
  return { ok: true, workflow, job, base };
}

/**
 * Read a worktree file with bounds: a regular file of at most `maxBytes`, whose
 * resolved path stays inside the worktree. `exact` also refuses a symlink
 * anywhere on the path. Returns { ok, text } (text null when absent).
 */
export function readBoundedFile(workspace, rel, maxBytes, { exact = false } = {}) {
  const path = join(workspace, rel);
  try {
    lstatSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, text: null };
    return refuse("invalid-declaration", `${rel} cannot be inspected (${err?.code ?? "error"})`);
  }
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return refuse("invalid-declaration", `${rel} is a dangling symlink`);
  }
  const root = realpathSync(workspace);
  if (!inside(root, real)) return refuse("invalid-declaration", `${rel} resolves outside the worktree`);
  if (exact && real !== join(root, rel)) return refuse("invalid-declaration", `${rel} is reached through a symlink`);
  const st = statSync(real);
  if (!st.isFile()) return refuse("invalid-declaration", `${rel} is not a regular file`);
  if (st.size > maxBytes) return refuse("invalid-declaration", `${rel} is larger than ${maxBytes} bytes`);
  const buf = Buffer.alloc(maxBytes + 1);
  const fd = openSync(real, "r");
  let n;
  try {
    n = readSync(fd, buf, 0, maxBytes + 1, 0);
  } finally {
    closeSync(fd);
  }
  if (n > maxBytes) return refuse("invalid-declaration", `${rel} is larger than ${maxBytes} bytes`);
  return { ok: true, text: buf.subarray(0, n).toString("utf8") };
}

const RUNTIME_FILES = [".nvmrc", ".node-version", ".bun-version", ".tool-versions"];

/** The workspace's runtime declarations, each bounded and contained. */
export function readDeclarations(workspace) {
  const runtimeFiles = {};
  for (const name of RUNTIME_FILES) {
    const r = readBoundedFile(workspace, name, MAX_VERSION_FILE_BYTES);
    if (!r.ok) return r;
    if (r.text !== null) runtimeFiles[name] = r.text;
  }
  const pkg = readBoundedFile(workspace, "package.json", MAX_MANIFEST_BYTES);
  if (!pkg.ok) return pkg;
  let manifest = {};
  if (pkg.text !== null) {
    try {
      manifest = JSON.parse(pkg.text);
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

/**
 * One bounded walk of the worktree (node_modules/ and .git/ are entries, not
 * descended into; symlinks are never followed). Returns every path, the SHA-256
 * of every lockfile, and the symlinked lockfiles and symlinked directories
 * (directory aliases) it found.
 */
export function scanWorkspace(workspace, { maxEntries = MAX_SCAN_ENTRIES, maxDepth = MAX_SCAN_DEPTH } = {}) {
  const paths = new Set();
  const lockfiles = new Map();
  const symlinkedLockfiles = [];
  const directoryAliases = [];
  let problem = null;
  const walk = (dir, depth) => {
    if (problem) return;
    if (depth > maxDepth) {
      problem = refuse("workspace-unverifiable", `the worktree nests deeper than ${maxDepth} directories; its lockfiles cannot be verified`);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      problem = refuse("workspace-unverifiable", `${relative(workspace, dir) || "."} cannot be listed (${err?.code ?? "error"})`);
      return;
    }
    for (const e of entries) {
      if (problem) return;
      const p = join(dir, e.name);
      const rel = relative(workspace, p);
      paths.add(rel);
      if (paths.size > maxEntries) {
        problem = refuse("workspace-unverifiable", `the worktree has more than ${maxEntries} entries outside node_modules/ and .git/; its lockfiles cannot be verified`);
        return;
      }
      if (e.isSymbolicLink()) {
        if (LOCKFILES.has(e.name)) symlinkedLockfiles.push(rel);
        else {
          let target = null;
          try {
            target = statSync(p);
          } catch {
            target = null; // dangling: not a directory alias
          }
          if (target?.isDirectory()) directoryAliases.push(rel);
        }
        continue;
      }
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".git") walk(p, depth + 1);
        continue;
      }
      if (LOCKFILES.has(e.name)) {
        if (!e.isFile()) {
          problem = refuse("workspace-unverifiable", `${rel} is not a regular file`);
          return;
        }
        const size = statSync(p).size;
        if (size > MAX_LOCKFILE_BYTES) {
          problem = refuse("workspace-unverifiable", `${rel} is larger than ${MAX_LOCKFILE_BYTES} bytes`);
          return;
        }
        lockfiles.set(rel, createHash("sha256").update(readFileSync(p)).digest("hex"));
      }
    }
  };
  walk(workspace, 0);
  if (problem) return problem;
  return { ok: true, paths, lockfiles, symlinkedLockfiles, directoryAliases };
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

/** Remove the top-most paths that exist now but did not when the build started. */
export function removeCreatedPaths(workspace, beforePaths, nowPaths) {
  const removed = [];
  for (const rel of nowPaths) {
    if (beforePaths.has(rel)) continue;
    const parent = dirname(rel);
    if (parent !== "." && !beforePaths.has(parent)) continue; // inside a created directory: removed with it
    rmSync(join(workspace, rel), { recursive: true, force: true });
    removed.push(rel);
  }
  return removed;
}

/**
 * The SAFE BASELINE of git configuration: what a plain `git clone` (and a
 * user identity) writes, and nothing that runs a program, changes a transport
 * or carries a credential. Every other key — core.fsmonitor, core.hooksPath,
 * core.pager, core.editor, core.sshCommand, core.askPass, protocol.*,
 * uploadpack.*, url.*.insteadOf/pushInsteadOf, credential.*, http.*, include*,
 * filter.*, diff.*, alias.*, remote.*.uploadpack/receivepack/proxy, ... — is
 * refused wherever it comes from (system, global or the worktree's own config).
 */
const GIT_BASELINE_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "extensions.objectformat",
  "user.name",
  "user.email",
  "init.defaultbranch",
]);
const GIT_BASELINE_PATTERNS = [/^remote\.[^\s=]+\.(url|fetch|tagopt|promisor|partialclonefilter)$/, /^branch\.[^\s=]+\.(remote|merge)$/];
const USERINFO_RE = /:\/\/[^/@\s]+@/;

/**
 * Git configuration outside the safe baseline, or a baseline key whose value
 * carries credentials in a URL or picks a transport helper, from `git config --list
 * --show-origin` output — by key and origin only (a value is never repeated;
 * userinfo in a key is masked).
 */
export function gitConfigFindings(listing) {
  const findings = new Set();
  for (const line of String(listing).split("\n")) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    const origin = tab >= 0 ? line.slice(0, tab) : "";
    const entry = tab >= 0 ? line.slice(tab + 1) : line;
    if (origin === "command line:") continue; // the launcher's own -c options
    const eq = entry.indexOf("=");
    const key = (eq >= 0 ? entry.slice(0, eq) : entry).toLowerCase();
    const value = eq >= 0 ? entry.slice(eq + 1) : "";
    const baseline = GIT_BASELINE_KEYS.has(key) || GIT_BASELINE_PATTERNS.some((re) => re.test(key));
    const unsafeValue =
      USERINFO_RE.test(key) ||
      USERINFO_RE.test(value) ||
      (/^remote\..+\.url$/.test(key) && (value.includes("::") || value.startsWith("-")));
    if (!baseline || unsafeValue) findings.add(`${key.replace(/:\/\/[^/@\s]+@/g, "://***@")} (${origin.replace(/:$/, "")})`);
  }
  return [...findings];
}

// --no-replace-objects: compare against the objects the refs really name, never a refs/replace/ substitute.
const gitArgs = (root, args) => ["-c", `safe.directory=${root}`, "-c", "core.fsmonitor=false", "--no-optional-locks", "--no-replace-objects", ...args];
function runGit(git, root, env, args) {
  return spawnSync(git, gitArgs(root, args), {
    cwd: root,
    env: { ...env, GIT_CEILING_DIRECTORIES: dirname(root) },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}
const unreachable = (r) => /not a git repository/.test(r.stderr ?? "");

/**
 * What git would see in the worktree before a job runs: `git config --list
 * --show-origin` with the step environment (fresh HOME), never climbing above
 * the worktree, must stay inside the safe baseline; and the repository's hooks
 * directory may hold only git's *.sample files (a fresh clone's).
 */
export function inspectGitConfig({ workspace, env, git = GIT }) {
  const root = realpathSync(workspace);
  const r = runGit(git, root, env, ["config", "--list", "--show-origin"]);
  if (r.error) return refuse("git-config-unreadable", `git could not be run to inspect the worktree's configuration (${r.error.code ?? "error"})`);
  if (r.status !== 0) {
    // A worktree whose git metadata lives outside the sandbox: git in a step cannot read it either.
    if (unreachable(r)) return { ok: true, note: "the worktree's git metadata is not reachable in the sandbox" };
    return refuse("git-config-unreadable", `git could not read the worktree's configuration: ${(r.stderr ?? "").split("\n")[0]}`);
  }
  const findings = gitConfigFindings(r.stdout);
  if (findings.length > 0) {
    return refuse(
      "git-config",
      `the worktree's git configuration has settings outside the safe baseline (a credential, a program git would run, or a transport change): ${findings.join(", ")}; no step runs with them`,
    );
  }
  const gitDir = runGit(git, root, env, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.status === 0) {
    const hooks = join(gitDir.stdout.trim(), "hooks");
    let names = [];
    try {
      names = readdirSync(hooks);
    } catch {
      names = [];
    }
    const live = names.filter((n) => !n.endsWith(".sample"));
    if (live.length > 0) {
      return refuse("git-config", `the worktree's repository has git hooks a fresh clone does not (${live.join(", ")}); no step runs with them`);
    }
  }
  return { ok: true };
}

/** The git state a build pins before its first job: HEAD and every remote URL and fetch refspec. */
function readPins(git, root, env, head) {
  const r = runGit(git, root, env, ["config", "--get-regexp", "^remote\\..+\\.(url|fetch)$"]);
  if (r.error || (r.status !== 0 && r.status !== 1)) return null; // 1 = no remote configured
  const remotes = (r.stdout ?? "")
    .split("\n")
    .filter((l) => l !== "")
    .sort();
  return { head, remotes };
}

/** What changed between two pin sets, by name only (HEAD, or a remote key). */
export function pinDrift(before, now) {
  const drift = [];
  if (before.head !== now.head) drift.push("HEAD");
  const keyOf = (line) => line.split(" ")[0];
  const group = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(keyOf(l), [...(m.get(keyOf(l)) ?? []), l].sort());
    return m;
  };
  const a = group(before.remotes);
  const b = group(now.remotes);
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (JSON.stringify(a.get(key) ?? []) !== JSON.stringify(b.get(key) ?? [])) drift.push(key);
  }
  return drift.sort();
}

/**
 * The clean-clone check that actions/checkout's skip relies on. It is what the
 * launcher can check, not a byte-for-byte comparison with a host-pinned commit
 * (per-job isolation is tpsdev-ai/cli#435):
 *   - a commit is checked out, and — for every job after the first — HEAD and
 *     every remote.<name>.url / .fetch are what they were before the first job;
 *   - no tracked file carries the assume-unchanged or skip-worktree index bit
 *     (either would hide an edit from git status);
 *   - `git status` (replace objects ignored) reports no modified, untracked or
 *     ignored path;
 *   - history is shaped as `fetch-depth` asks (1: a shallow one-commit clone
 *     without tags, as checkout's default fetch makes; 0: a full clone).
 * Returns { ok, pins } so the caller can pin the first job's state.
 */
export function checkFreshClone({ workspace, env, fetchDepth, pinned = null, git = GIT }) {
  const root = realpathSync(workspace);
  const head = runGit(git, root, env, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.error || head.status !== 0) {
    return refuse(
      "not-fresh",
      unreachable(head)
        ? "the worktree's git metadata is not reachable in the sandbox, so the clean checkout that actions/checkout gives CI cannot be verified"
        : "the worktree has no checked-out commit, so the clean checkout that actions/checkout gives CI cannot be verified",
    );
  }
  const pins = readPins(git, root, env, head.stdout.trim());
  if (!pins) return refuse("not-fresh", "the worktree's remote configuration could not be read");
  if (pinned) {
    const drift = pinDrift(pinned, pins);
    if (drift.length > 0) {
      return refuse("not-fresh", `the worktree's ${drift.join(", ")} changed since the build started; an earlier job rewrote what checkout gave it`);
    }
  }
  const bits = runGit(git, root, env, ["ls-files", "-v", "-z"]);
  if (bits.status !== 0) return refuse("not-fresh", `git ls-files failed in the worktree: ${(bits.stderr ?? "").split("\n")[0]}`);
  const hidden = bits.stdout
    .split("\0")
    .filter((e) => e.length > 2 && (e[0] === "S" || (e[0] >= "a" && e[0] <= "z")))
    .map((e) => e.slice(2));
  if (hidden.length > 0) {
    return refuse(
      "not-fresh",
      `${hidden.length} tracked path(s) carry the assume-unchanged or skip-worktree bit, which hides edits from git status (e.g. ${hidden.slice(0, 5).join(", ")})`,
    );
  }
  const status = runGit(git, root, env, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"]);
  if (status.status !== 0) return refuse("not-fresh", `git status failed in the worktree: ${(status.stderr ?? "").split("\n")[0]}`);
  const entries = status.stdout.split("\0").filter((e) => e !== "");
  if (entries.length > 0) {
    const shown = entries.slice(0, 5).map((e) => e.slice(3));
    return refuse(
      "not-fresh",
      `the worktree is not the clean clone actions/checkout gives CI: ${entries.length} modified, untracked or ignored path(s), e.g. ${shown.join(", ")}`,
    );
  }
  const shallow = runGit(git, root, env, ["rev-parse", "--is-shallow-repository"]).stdout?.trim();
  if (fetchDepth === 0) {
    if (shallow !== "false") return refuse("not-fresh", "the job checks out full history (fetch-depth: 0) but the worktree is a shallow clone");
    return { ok: true, pins };
  }
  const count = runGit(git, root, env, ["rev-list", "--count", "HEAD"]).stdout?.trim();
  const tags = runGit(git, root, env, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/tags"]).stdout?.trim();
  if (shallow !== "true" || count !== "1" || tags) {
    return refuse(
      "not-fresh",
      `the job uses checkout's default one-commit fetch, but the worktree ${shallow !== "true" ? "is not a shallow clone" : count !== "1" ? `reaches ${count} commits` : "has tags"}; mount a depth-1 clone of the assigned head`,
    );
  }
  return { ok: true, pins };
}

/** Recreate the hermetic root and every directory the layout names (mode 0700). */
export function prepareHermeticRoot(root) {
  rmSync(root, { recursive: true, force: true });
  const dirs = new Set([root, join(root, "steps"), ...Object.values(hermeticLayout(root))]);
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The image's own node and bun, at fixed paths, run with the child env. */
export function probeActualVersions(env, bins = TRUSTED_BINARIES) {
  const options = { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  const read = (run) => {
    try {
      return run().trim().replace(/^v/, "");
    } catch {
      return null;
    }
  };
  return {
    node: read(() => execFileSync(bins.node, ["--version"], options)),
    bun: read(() => execFileSync(bins.bun, ["--version"], options)),
  };
}

/** The resolved working directory of a step, which must stay inside the worktree. */
export function containedDirectory(workspace, workingDirectory) {
  const root = realpathSync(workspace);
  let real;
  try {
    real = realpathSync(join(workspace, workingDirectory));
  } catch {
    return refuse("working-directory", `the working directory "${workingDirectory}" does not exist`);
  }
  if (!inside(root, real)) {
    return refuse("working-directory", `the working directory "${workingDirectory}" resolves outside the worktree`);
  }
  if (!statSync(real).isDirectory()) return refuse("working-directory", `the working directory "${workingDirectory}" is not a directory`);
  return { ok: true, dir: real };
}

/**
 * Immediately before a step runs: its effective environment must pass
 * checkStepEnv, and its working directory must RESOLVE inside the worktree. The
 * step then starts in the resolved directory.
 */
export function guardStep(step, env, workspace) {
  const effective = { ...env, ...step.env };
  const envCheck = checkStepEnv(effective, env);
  if (!envCheck.ok) return envCheck;
  const cwd = containedDirectory(workspace, step.workingDirectory);
  if (!cwd.ok) return cwd;
  return { ok: true, env: effective, cwd: cwd.dir };
}

/** The exit code a timed-out step is given (as timeout(1) does). */
export const TIMEOUT_CODE = 124;

/** Kill a step's whole process group; a group already gone is fine. */
export function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already exited
  }
}

/**
 * Run one step as a script file under /bin/bash, the way the Actions runner
 * does, in its own process group. At `timeoutMs` the whole group is killed and
 * the step fails as timed out. The group is added to `groups` so the job can
 * kill what the step left running when the job ends, as the runner does.
 */
export function bashStep({ step, scriptDir, env, timeoutMs = null, groups = null }) {
  const script = join(scriptDir, `step-${step.job}-${String(step.index).padStart(2, "0")}.sh`);
  writeFileSync(script, step.script, { mode: 0o600 });
  return new Promise((resolveResult) => {
    const child = spawn(BASH, ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: step.cwd,
      env,
      detached: true,
      // stdout of a step goes to stderr: the launcher's stdout is its verdict.
      stdio: ["ignore", 2, 2],
    });
    if (child.pid) groups?.add(child.pid);
    let timedOut = false;
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            if (child.pid) killGroup(child.pid);
          }, Math.max(0, timeoutMs));
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolveResult({ code: 127 });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveResult(timedOut ? { code: TIMEOUT_CODE, timedOut: true } : { code: code ?? 1 });
    });
  });
}

/**
 * Run the steps in order. After a failure only `always()` steps still run. A
 * runner that returns { refusal } stops the build at once.
 */
export async function runSteps(steps, runStep) {
  const results = [];
  let failed = null;
  for (const step of steps) {
    if (failed && !step.always) {
      results.push({ step: step.index, name: step.name, skipped: "an earlier step failed" });
      continue;
    }
    const r = await runStep(step);
    if (r !== null && typeof r === "object" && r.refusal) return { ok: false, refusal: r.refusal, results };
    const { code, timedOut } = r !== null && typeof r === "object" ? r : { code: r };
    results.push(timedOut ? { step: step.index, name: step.name, code, timedOut } : { step: step.index, name: step.name, code });
    if (code !== 0 && !failed) failed = timedOut ? { step: step.index, name: step.name, code, timedOut } : { step: step.index, name: step.name, code };
  }
  return failed ? { ok: false, results, failed } : { ok: true, results };
}

/**
 * The review build. Every input that decides WHAT runs is read here, in order,
 * before anything is spawned. `workspace`, `trustedDir`, `hermeticRoot`,
 * `creationEnv`, `probe`, `inspectGit`, `checkFresh` and `runStep` are
 * injectable for host tests only; the CLI passes none of them.
 */
export async function reviewBuild({
  workspace = WORKSPACE,
  trustedDir = TRUSTED_DIR,
  hermeticRoot = HERMETIC_ROOT,
  parentEnv = {},
  creationEnv = readCreationEnv(),
  probe = probeActualVersions,
  inspectGit = inspectGitConfig,
  checkFresh = checkFreshClone,
  runStep = bashStep,
}) {
  const identity = readIdentity(trustedDir, parentEnv);
  if (!identity.ok) return identity;
  const assignment = hostAssignment(creationEnv, parentEnv);
  if (!assignment.ok) return assignment;

  const before = scanWorkspace(workspace);
  if (!before.ok) return before;
  if (before.symlinkedLockfiles.length > 0 || before.directoryAliases.length > 0) {
    return refuse(
      "symlinked-path",
      `the worktree has ${[
        ...before.symlinkedLockfiles.map((p) => `a symlinked lockfile ${p}`),
        ...before.directoryAliases.map((p) => `a symlinked directory ${p}`),
      ].join(", ")}; lockfile drift cannot be verified through a symlink`,
    );
  }

  const workflowFile = readBoundedFile(workspace, assignment.workflow, MAX_WORKFLOW_BYTES, { exact: true });
  if (!workflowFile.ok) return workflowFile;
  if (workflowFile.text === null) return refuse("no-ci-job", `the reviewed commit has no ${assignment.workflow}`);
  const plan = planJob({
    workflowText: workflowFile.text,
    workflowFile: assignment.workflow,
    jobId: assignment.job,
    baseBranch: assignment.base,
    reservedEnvKeys: RESERVED_ENV_KEYS,
  });
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
  if (plan.shims.length > 0) env.PATH = `${join(trustedDir, "shims")}:${env.PATH}`;

  const verified = verifyRuntime({ image: identity.entry, actual: probe(env), requirements: resolved.requirements });
  if (!verified.ok) return verified;

  const scriptDir = join(hermeticRoot, "steps");
  let pinned = null;
  const status = new Map();
  const jobs = [];
  const stop = (refusal) => ({ ok: false, refusal, jobs });
  for (const [i, job] of plan.jobs.entries()) {
    const blocked = job.needs.filter((n) => status.get(n) !== "ok");
    if (blocked.length > 0 && job.when !== "always") {
      status.set(job.id, "skipped");
      jobs.push({ job: job.id, skipped: `needs ${blocked.join(", ")}, which did not succeed` });
      continue;
    }
    if (i > 0) {
      // Remove what earlier jobs created; the clean-clone check below then
      // refuses what it can see of anything else they left behind.
      const now = scanWorkspace(workspace);
      if (!now.ok) return stop(now.refusal);
      removeCreatedPaths(workspace, before.paths, now.paths);
    }
    // Each job gets a fresh HOME/TMPDIR/caches, as on a fresh runner.
    prepareHermeticRoot(hermeticRoot);
    const git = inspectGit({ workspace, env });
    if (!git.ok) return stop(git.refusal);
    const fresh = checkFresh({ workspace, env, fetchDepth: job.fetchDepth, pinned });
    if (!fresh.ok) return stop(fresh.refusal);
    // HEAD and the remotes' URLs and refspecs are pinned before the first job.
    pinned ??= fresh.pins;

    // timeout-minutes: the job's (default 360) bounds every step; a step's own bounds it further.
    const deadline = Date.now() + job.timeoutMinutes * 60_000;
    const groups = new Set();
    let outcome;
    try {
      outcome = await runSteps(
        job.steps.map((s) => ({ ...s, job: job.id })),
        (step) => {
          const guard = guardStep(step, env, workspace);
          if (!guard.ok) return guard;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { code: TIMEOUT_CODE, timedOut: true };
          const timeoutMs = step.timeoutMinutes === null ? remaining : Math.min(step.timeoutMinutes * 60_000, remaining);
          return runStep({ step: { ...step, cwd: guard.cwd }, workspace, scriptDir, env: guard.env, timeoutMs, groups });
        },
      );
    } finally {
      // What the job's steps left running ends with the job, as on the runner.
      for (const pid of groups) killGroup(pid);
    }
    jobs.push({ job: job.id, steps: outcome.results, skipped: job.skipped });
    if (outcome.refusal) return stop(outcome.refusal);

    const after = scanWorkspace(workspace);
    if (!after.ok) return stop(after.refusal);
    if (after.symlinkedLockfiles.length > 0) {
      return stop({ kind: "unfrozen-install", message: `job ${job.id} left symlinked lockfiles (${after.symlinkedLockfiles.join(", ")})` });
    }
    if (after.directoryAliases.length > 0) {
      return stop({
        kind: "symlinked-path",
        message: `job ${job.id} left symlinked directories (${after.directoryAliases.join(", ")}); lockfile drift cannot be verified through a symlink`,
      });
    }
    const drift = lockfileDrift(before.lockfiles, after.lockfiles);
    if (drift.length > 0) {
      return stop({
        kind: "unfrozen-install",
        message: `job ${job.id} changed lockfiles (${drift.join(", ")}); a review build requires a frozen install`,
      });
    }
    status.set(job.id, outcome.ok ? "ok" : "failed");
    if (!outcome.ok) jobs[jobs.length - 1].failed = outcome.failed;
  }

  const notOk = plan.jobs.find((j) => status.get(j.id) !== "ok");
  if (notOk) {
    const entry = jobs.find((j) => j.job === notOk.id);
    const why = entry?.failed
      ? entry.failed.timedOut
        ? `step ${entry.failed.step} (${entry.failed.name}) timed out (timeout-minutes)`
        : `step ${entry.failed.step} (${entry.failed.name}) exited ${entry.failed.code}`
      : entry?.skipped ?? "it did not run";
    return stop({ kind: "stage-failed", message: `job ${notOk.id}: ${why}` });
  }
  return {
    ok: true,
    status: "review-build-ok",
    image: identity.imageId,
    node: verified.receipt.node,
    bun: verified.receipt.bun,
    workflow: plan.workflow,
    job: plan.job,
    base: assignment.base,
    jobs,
  };
}

/** Verify the image's own runtimes against its baked entry (no workspace). */
export function selfCheck({ trustedDir = TRUSTED_DIR, parentEnv = {}, probe = probeActualVersions }) {
  const identity = readIdentity(trustedDir, parentEnv);
  if (!identity.ok) return identity;
  const result = verifyRuntime({ image: identity.entry, actual: probe(hermeticEnv(parentEnv, HERMETIC_ROOT)) });
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
  process.stdout.write(`${JSON.stringify({ status: "refused", ...result.refusal, jobs: result.jobs })}\n`);
  return 1;
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--self-check") return emit(selfCheck({ parentEnv: process.env }));
  if (args.length !== 0) {
    process.stderr.write("usage: reviewer-launch | reviewer-launch --self-check  (the worktree is always /workspace)\n");
    return 2;
  }
  return emit(await reviewBuild({ parentEnv: process.env }));
}

// Only act as an entry point when executed directly.
if (process.argv[1]?.endsWith("reviewer-launch.mjs")) {
  main(process.argv).then((code) => process.exit(code));
}
