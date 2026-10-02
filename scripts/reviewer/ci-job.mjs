/**
 * ci-job.mjs — turn ONE host-named job of a reviewed commit's GitHub Actions
 * workflow, with the jobs it `needs`, into the review build's plan, or refuse by
 * name.
 *
 * The plan feeds the review build, run one sandbox container per job by
 * scripts/reviewer/run-review-jobs.mjs; its verdict (review-build-ok) is
 * advisory evidence for the reviewer, not a merge gate (CI stays the gate).
 * Where a workflow feature cannot be
 * reproduced faithfully and cheaply, it is refused rather than approximated;
 * the fidelity limits that remain are named in docker/reviewer/README.md.
 *
 * The host names the workflow, the job and the pull request's base branch (see
 * reviewer-launch.mjs); nothing about which job runs is inferred from the
 * workflow's text. The workflow is bounded before and after parsing (bytes,
 * nodes visited, depth) and parsed as YAML (js-yaml, the version the
 * repository's bun.lock pins, with the YAML 1.2 core schema: no custom tags, no
 * code). Every mapping key must be printable ASCII, so a lookalike of `on`,
 * `jobs`, `needs` or `if` is refused rather than ignored.
 *
 * TRIGGER. CI runs the workflow for this review only if it runs on
 * `pull_request` into the host-named base branch: `on` must name
 * `pull_request`; a `branches` filter must list the base exactly
 * (`branches-ignore` must not); `types`, if given, must include `opened` and
 * `synchronize`. Glob or negated branch patterns and `paths` filters cannot be
 * evaluated here and are refused. A workflow CI runs only on push, on a
 * schedule or by hand is refused.
 *
 * JOBS. The named job and its `needs` closure are planned, dependencies first.
 * Every job must begin with actions/checkout (a CI runner starts empty) and
 * run on a verified runner label (RUNNER_LABELS). A job runs only if every job
 * it needs succeeded (or its `if:` is `always()`); the build passes only if
 * every job in the closure ran and succeeded.
 *
 * WHAT IS HONOURED in a job: `run:` steps, with `working-directory`,
 * `shell: bash`, plain `env:` values (workflow, job and step level) and
 * `defaults.run` (shell/working-directory); `if:` when it is absent, `true`,
 * `success()` or `always()`; `needs`; `timeout-minutes` on the job (default
 * 360) and on planned `run:` steps, which the launcher enforces (on a skipped
 * `uses:` step it is refused). Each planned `run:` step carries `node`:
 * `default`, or the version the most recent preceding setup-node pins.
 *
 * WHAT IS SKIPPED (named in the plan, with the reason): the actions in
 * SKIPPED_ACTIONS, each only at a reviewed immutable ref (a full commit SHA whose
 * release tag and action.yml inputs were checked), only with every input the
 * real action needs, and only with input values whose skip is equivalent.
 * checkout only as a job's first step, on a worktree that passes the
 * launcher's clean-clone check (see checkFreshClone). No input of a skipped
 * action may carry `${{ }}`. Any other ref of those actions is refused. Ignored job keys: name, permissions (scopes a token the sandbox
 * never has), concurrency and outputs (consumed only through `${{ }}`, which is
 * refused).
 *
 * WHAT IS REFUSED (anything else): any other action or ref (including local
 * `./` and `docker://` actions), a `${{ }}` expression anywhere the launcher
 * would have to evaluate it (a script, an env value, a working directory, a
 * runner label, a timeout, any input of a skipped action — the only expressions
 * accepted are `if:` conditions that are exactly `success()` or `always()`),
 * any other `if:`, `continue-on-error: true`, a non-bash shell,
 * `strategy`, `container`, `services`, `environment`, reusable-workflow jobs, an
 * env key the launcher owns (HOME, PATH, ...) or that is credential-shaped or
 * redirects configuration (see forbiddenEnvReason), a working directory that is
 * lexically outside the workspace (the launcher re-checks the RESOLVED path
 * before each step), and a job with no `run:` step.
 */
import { CORE_SCHEMA, load } from "js-yaml";

export const WORKFLOW_PATH_RE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
export const JOB_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A branch name the host may name: no glob characters, no `..`, no leading/trailing `/`. */
export const BRANCH_RE = /^(?!\/)(?!.*\/$)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Bounds on untrusted workflow input, checked before (bytes) and after (nodes, depth) parsing. */
export const MAX_WORKFLOW_BYTES = 256 * 1024;
export const MAX_YAML_NODES = 50_000;
export const MAX_YAML_DEPTH = 32;
/** GitHub-hosted runners stop a job at 360 minutes; it is also the default job timeout. */
export const MAX_JOB_MINUTES = 360;
/**
 * The runner labels the image stands in for: GitHub-hosted x86_64 Ubuntu 24.04.
 * ubuntu-latest is what tpsdev-ai/cli and tpsdev-ai/flair use; the cli CI log
 * of 2026-09-27 shows it resolving to "Image: ubuntu-24.04".
 */
export const RUNNER_LABELS = new Set(["ubuntu-latest", "ubuntu-24.04"]);

const refuse = (kind, message) => ({ ok: false, refusal: { kind, message } });
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasExpression = (v) => typeof v === "string" && v.includes("${{");
const PRINTABLE_ASCII_KEY_RE = /^[\x20-\x7e]+$/;

const TOP_KEYS = new Set(["name", "run-name", "on", "permissions", "env", "defaults", "concurrency", "jobs"]);
const JOB_KEYS_HONOURED = new Set(["runs-on", "if", "env", "defaults", "steps", "continue-on-error", "needs", "timeout-minutes"]);
const JOB_KEYS_IGNORED = new Set(["name", "permissions", "concurrency", "outputs"]);
const STEP_KEYS = new Set([
  "name",
  "id",
  "if",
  "uses",
  "with",
  "run",
  "env",
  "working-directory",
  "shell",
  "continue-on-error",
  "timeout-minutes",
]);

// ─── credential-shaped and config-redirecting environment ────────────────────

const FORBIDDEN_ENV_EXACT = new Set([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NETRC",
  "CURL_HOME",
  "WGETRC",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "KUBECONFIG",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
]);
const FORBIDDEN_ENV_PREFIXES = [
  "GIT_",
  "GH_",
  "GITHUB_",
  "SSH_",
  "NPM_CONFIG_",
  "YARN_",
  "BUN_",
  "PNPM_",
  "LD_",
  "DYLD_",
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "XDG_",
];
/** Git identity values tests commonly set; they carry no credential. */
const ALLOWED_GIT_IDENTITY = new Set(["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]);
const CREDENTIAL_SEGMENTS = new Set([
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "CREDENTIAL",
  "CREDENTIALS",
  "KEY",
  "KEYS",
  "APIKEY",
  "AUTH",
  "PAT",
]);

/**
 * Why a workflow may not set this environment variable for a step, or null.
 * Credential-shaped names (a TOKEN/SECRET/KEY/PASSWORD/AUTH/... segment) and
 * variables that redirect a tool's configuration, trust, loader or network
 * (GIT_*, GH_*, GITHUB_*, SSH_*, NPM_CONFIG_*, BUN_*, LD_*, NODE_OPTIONS,
 * BASH_ENV, proxies, CA bundles, ...) are refused.
 */
export function forbiddenEnvReason(key) {
  const k = String(key).toUpperCase();
  if (ALLOWED_GIT_IDENTITY.has(k)) return null;
  if (FORBIDDEN_ENV_EXACT.has(k)) return "it redirects a tool's startup, trust or network configuration";
  const prefix = FORBIDDEN_ENV_PREFIXES.find((p) => k.startsWith(p));
  if (prefix) return `${prefix}* variables configure credentials or redirect tool configuration`;
  if (k.split("_").some((seg) => CREDENTIAL_SEGMENTS.has(seg))) return "the name is credential-shaped";
  return null;
}

// ─── the actions a review build skips ────────────────────────────────────────

// Input rules. A rule returns null when the value's skip is equivalent to what
// the real action does with it, or the reason it is not. No input of a skipped
// action may carry `${{ }}`: the skipped step never evaluates it, so neither
// its value nor the real action's reaction to that value can be checked (usesStep
// refuses it before any rule runs).
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const digits = (text) => (/^\d+$/.test(text) ? null : `is ${JSON.stringify(text)}; the action accepts only an integer`);
const oneOf =
  (...allowed) =>
  (text) =>
    allowed.includes(text) ? null : `is ${JSON.stringify(text)}; a skipped step reproduces only ${allowed.join(" or ")}`;
const intBetween = (lo, hi) => (text) =>
  /^\d+$/.test(text) && Number(text) >= lo && Number(text) <= hi ? null : `is ${JSON.stringify(text)}; the action accepts only an integer from ${lo} to ${hi}`;
const exactVersion = (text) =>
  EXACT_VERSION_RE.test(text)
    ? null
    : `is ${JSON.stringify(text)}; CI resolves a range or alias at run time, so only an exact version (X.Y.Z) is reproduced`;
const nonEmpty = (text) => (text.trim() === "" ? "is empty; the action requires it" : null);
/** actions/cache rejects a key (primary or restore) longer than 512 characters or containing a comma. */
const badCacheKey = (key) => key.length > 512 || key.includes(",");
const cacheKey = (text) => {
  if (text.trim() === "") return "is empty; the action requires it";
  return badCacheKey(text) ? "is a key actions/cache rejects (longer than 512 characters or containing a comma)" : null;
};
/** restore-keys: one key per line, each held to the same rule as the primary key. */
const restoreKeys = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .some(badCacheKey)
    ? "has a key actions/cache rejects (longer than 512 characters or containing a comma)"
    : null;
/** upload-artifact v4 rejects these characters in an artifact name. */
const artifactName = (text) =>
  /[":<>|*?\r\n\\/]/.test(text) || text.trim() === "" ? `is ${JSON.stringify(text)}, a name upload-artifact rejects` : null;

/**
 * Each skipped action is accepted ONLY at a reviewed immutable ref: a full
 * commit SHA whose release tag (noted beside it) and action.yml inputs were
 * checked. `inputs` maps every accepted `with:` key to its rule; `required`
 * lists the inputs without which the real action fails; `pin` turns inputs into
 * runtime requirements; `shim` names a wrapper the image provides in the
 * action's place. An input not listed is refused.
 */
export const SKIPPED_ACTIONS = {
  "actions/checkout": {
    refs: {
      "11bd71901bbe5b1630ceea73d27597364c9af683": "v4.2.2",
      "34e114876b0b11c390a56381ad16ebd13914f8d5": "v4.3.1",
    },
    reason: "the workspace is the host-created clone at the assigned head, checked before the job",
    // Accepted only as a job's first step; the launcher then requires the
    // worktree to pass its clean-clone check (reviewer-launch.mjs
    // checkFreshClone), with history shaped as the fetch-depth asks (1: a
    // one-commit shallow clone; 0: a full clone).
    // persist-credentials only decides whether CI writes a token into
    // .git/config (the review never has one); clean is what a fresh clone
    // already is; show-progress is logging.
    inputs: {
      "persist-credentials": oneOf("true", "false"),
      "fetch-depth": oneOf("0", "1"),
      clean: oneOf("true", "false"),
      "show-progress": oneOf("true", "false"),
    },
  },
  "oven-sh/setup-bun": {
    refs: {
      "735343b667d3e6f658f44d0eca948eb6282f2b76": "v2.0.2",
      "0c5077e51419868618aeaa5fe8019c62421857d6": "v2.2.0",
    },
    reason: "the image provides bun; the exact pin is verified against the actual runtime",
    inputs: { "bun-version": exactVersion, "no-cache": oneOf("true", "false") },
    required: ["bun-version"],
    pin: (withInputs, source) => [{ tool: "bun", range: String(withInputs["bun-version"]), source: `${source} bun-version` }],
  },
  "actions/setup-node": {
    refs: { "49933ea5288caeca8642d1e84afbd3f7d6820020": "v4.4.0" },
    reason: "the image provides node; the exact pin is verified against the actual runtime",
    inputs: { "node-version": exactVersion, "check-latest": oneOf("false") },
    required: ["node-version"],
    pin: (withInputs, source) => [{ tool: "node", range: String(withInputs["node-version"]), source: `${source} node-version` }],
  },
  "socketdev/action": {
    refs: { ba6de6cc0565af1f42295590380973573297e31f: "v1.3.2" },
    reason: "Socket Firewall is not reproduced in the sandbox; `sfw <cmd>` runs <cmd> unwrapped",
    // firewall-free installs the `sfw` wrapper and nothing else; `patch` mode
    // rewrites dependencies and cannot be skipped.
    inputs: { mode: oneOf("firewall-free") },
    required: ["mode"],
    shim: "sfw",
  },
  "actions/cache": {
    refs: {
      "1bd1e32a3bdc45362d1e726936510720a7c30a57": "v4.2.0",
      "0057852bfaa89a56745cba8c7296529d2fc39830": "v4.3.0",
    },
    reason: "a cold build is never greener than a cached one",
    // path and key are required (the action fails without them); a miss must
    // not fail the job, since a skipped cache always misses.
    inputs: {
      path: nonEmpty,
      key: cacheKey,
      "restore-keys": restoreKeys,
      enableCrossOsArchive: oneOf("true", "false"),
      "lookup-only": oneOf("true", "false"),
      "fail-on-cache-miss": oneOf("false"),
      "upload-chunk-size": digits,
    },
    required: ["path", "key"],
  },
  "actions/upload-artifact": {
    refs: { ea165f8d65b6e75b540449e92b4886f43607fa02: "v4.6.2" },
    reason: "publishing an artifact does not change the build",
    // path is required; a missing file must not fail the job; the name must be
    // valid and unique in the workflow run (v4 fails a second upload of a name).
    inputs: {
      name: artifactName,
      path: nonEmpty,
      "if-no-files-found": oneOf("warn", "ignore"),
      "retention-days": intBetween(1, 90),
      "compression-level": intBetween(0, 9),
      overwrite: oneOf("true", "false"),
      "include-hidden-files": oneOf("true", "false"),
    },
    required: ["path"],
  },
};

/** Normalize an `if:` to "success" | "always", or null when it cannot be honoured. */
export function condition(value) {
  if (value === undefined || value === true) return "success";
  if (typeof value !== "string") return null;
  let text = value.trim();
  const wrapped = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  if (text === "true" || text === "success()") return "success";
  if (text === "always()") return "always";
  return null;
}

/** Validate an env block; returns { ok, env } with string values. */
function readEnv(block, where, reserved) {
  if (block === undefined || block === null) return { ok: true, env: {} };
  if (!isPlainObject(block)) return refuse("ci-unhonourable", `${where} env: is not a mapping`);
  const env = {};
  for (const [key, value] of Object.entries(block)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return refuse("ci-unhonourable", `${where} env key "${key}" is not a variable name`);
    if (reserved.has(key)) {
      return refuse("ci-unhonourable", `${where} sets ${key}, which the review launcher owns (hermetic isolation)`);
    }
    const forbidden = forbiddenEnvReason(key);
    if (forbidden) return refuse("ci-unhonourable", `${where} sets ${key}: ${forbidden}; a review build never passes it to a step`);
    if (value !== null && typeof value === "object") return refuse("ci-unhonourable", `${where} env ${key} is not a scalar`);
    const text = value === null ? "" : String(value);
    if (hasExpression(text)) {
      return refuse("ci-unhonourable", `${where} env ${key} uses a \${{ }} expression, which only the Actions runner can evaluate`);
    }
    env[key] = text;
  }
  return { ok: true, env };
}

/** Validate a `defaults:` block; returns { ok, shell, workingDirectory }. */
function readDefaults(block, where) {
  if (block === undefined || block === null) return { ok: true };
  if (!isPlainObject(block)) return refuse("ci-unhonourable", `${where} defaults: is not a mapping`);
  for (const key of Object.keys(block)) {
    if (key !== "run") return refuse("ci-unhonourable", `${where} defaults.${key} cannot be reproduced`);
  }
  const run = block.run ?? {};
  if (!isPlainObject(run)) return refuse("ci-unhonourable", `${where} defaults.run is not a mapping`);
  for (const key of Object.keys(run)) {
    if (key !== "shell" && key !== "working-directory") return refuse("ci-unhonourable", `${where} defaults.run.${key} cannot be reproduced`);
  }
  return { ok: true, shell: run.shell, workingDirectory: run["working-directory"] };
}

/** A working directory relative to the workspace root, or a refusal (lexical; the launcher re-checks the resolved path). */
function workingDirectory(value, where) {
  if (value === undefined || value === null) return { ok: true, dir: "." };
  if (typeof value !== "string" || value.trim() === "" || hasExpression(value)) {
    return refuse("ci-unhonourable", `${where} working-directory ${JSON.stringify(value)} cannot be reproduced`);
  }
  const segments = value.split("/").filter((s) => s !== "" && s !== ".");
  if (value.startsWith("/") || segments.includes("..")) {
    return refuse("ci-unhonourable", `${where} working-directory "${value}" leaves the workspace`);
  }
  return { ok: true, dir: segments.length === 0 ? "." : segments.join("/") };
}

/** Classify one `uses:` step: skipped (with any pins/shim) or a refusal. */
function usesStep(step, where, ctx) {
  const ref = typeof step.uses === "string" ? step.uses.trim() : "";
  const at = ref.lastIndexOf("@");
  if (ref === "" || ref.startsWith("./") || ref.startsWith("docker://") || at <= 0) {
    return refuse("ci-unhonourable", `${where} uses ${JSON.stringify(step.uses)}, which the review launcher cannot reproduce`);
  }
  const name = ref.slice(0, at).toLowerCase();
  const sha = ref.slice(at + 1);
  const action = Object.hasOwn(SKIPPED_ACTIONS, name) ? SKIPPED_ACTIONS[name] : null;
  if (!action) {
    return refuse(
      "ci-unhonourable",
      `${where} uses ${ref}, which the review launcher cannot reproduce (it runs run: steps and skips only ${Object.keys(SKIPPED_ACTIONS).join(", ")})`,
    );
  }
  if (!Object.hasOwn(action.refs, sha)) {
    return refuse(
      "ci-unhonourable",
      `${where} uses ${name} at "${sha}", which is not a reviewed immutable ref; the launcher skips ${name} only at ${Object.entries(action.refs)
        .map(([s, tag]) => `${s} (${tag})`)
        .join(", ")}`,
    );
  }
  if (step.with !== undefined && step.with !== null && !isPlainObject(step.with)) {
    return refuse("ci-unhonourable", `${where} with: is not a mapping`);
  }
  const withInputs = {};
  for (const [key, value] of Object.entries(step.with ?? {})) {
    if (!Object.hasOwn(action.inputs, key)) {
      return refuse("ci-unhonourable", `${where} passes ${name} the input "${key}", which the review launcher cannot reproduce`);
    }
    if (value !== null && typeof value === "object") return refuse("ci-unhonourable", `${where} input ${key} is not a scalar`);
    const text = value === null ? "" : String(value);
    if (hasExpression(text)) {
      return refuse(
        "ci-unhonourable",
        `${where} ${name} input ${key} uses a \${{ }} expression; a skipped action never evaluates it, so its value and the real action's reaction to it cannot be checked`,
      );
    }
    const problem = action.inputs[key](text);
    if (problem) return refuse("ci-unhonourable", `${where} ${name} input ${key} ${problem}`);
    withInputs[key] = text;
  }
  for (const key of action.required ?? []) {
    if (withInputs[key] === undefined) {
      return refuse("ci-unhonourable", `${where} gives ${name} no ${key}; the real action fails or floats without it, so skipping it is not equivalent`);
    }
  }
  if (name === "actions/upload-artifact") {
    const artifact = withInputs.name ?? "artifact";
    if ((ctx.uploadNames.get(artifact) ?? 0) > 1) {
      return refuse("ci-unhonourable", `${where} uploads "${artifact}", a name the workflow uploads more than once; upload-artifact v4 fails the second upload`);
    }
  }
  return {
    ok: true,
    name,
    skipped: { uses: ref, tag: action.refs[sha], reason: action.reason },
    pins: action.pin ? action.pin(withInputs, where) : [],
    shim: action.shim ?? null,
    fetchDepth: name === "actions/checkout" ? Number(withInputs["fetch-depth"] ?? "1") : null,
  };
}

/** Artifact names every upload-artifact step in the workflow uses, counted (literal names; default "artifact"). */
function uploadNameCounts(doc) {
  const counts = new Map();
  for (const job of Object.values(doc.jobs)) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (!isPlainObject(step) || typeof step.uses !== "string" || !step.uses.trim().toLowerCase().startsWith("actions/upload-artifact@")) continue;
      const n = isPlainObject(step.with) && step.with.name !== undefined && step.with.name !== null ? String(step.with.name) : "artifact";
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return counts;
}

/** A timeout-minutes value: a positive number of minutes, capped at GitHub-hosted runners' 360. */
function readTimeout(value, where) {
  if (value === undefined) return { ok: true, minutes: null };
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return refuse("ci-unhonourable", `${where} timeout-minutes ${JSON.stringify(value)} is not a positive number of minutes the launcher can enforce`);
  }
  return { ok: true, minutes: Math.min(n, MAX_JOB_MINUTES) };
}

// ─── the document ────────────────────────────────────────────────────────────

/** Bounded walk: printable-ASCII keys, at most MAX_YAML_NODES visits (aliases count each time) and MAX_YAML_DEPTH levels. */
function checkShape(doc, workflowFile) {
  let nodes = 0;
  let problem = null;
  const walk = (value, depth, path) => {
    if (problem) return;
    nodes += 1;
    if (nodes > MAX_YAML_NODES) {
      problem = refuse("ci-unreadable", `${workflowFile} expands to more than ${MAX_YAML_NODES} YAML nodes (anchors and aliases count at every use)`);
      return;
    }
    if (depth > MAX_YAML_DEPTH) {
      problem = refuse("ci-unreadable", `${workflowFile} nests deeper than ${MAX_YAML_DEPTH} levels`);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, path);
    } else if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (!PRINTABLE_ASCII_KEY_RE.test(key)) {
          problem = refuse(
            "ci-unhonourable",
            `${workflowFile} has a key under ${path || "the top level"} that is not printable ASCII (${JSON.stringify(key)}); a lookalike key is never read as the key it resembles`,
          );
          return;
        }
        walk(item, depth + 1, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(doc, 0, "");
  return problem ?? { ok: true };
}

const asList = (v) => (typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);

/** Does CI run this workflow for a pull request into `base`? */
export function checkTrigger(on, base, workflowFile) {
  const PR = "pull_request";
  const notPr = refuse(
    "ci-not-triggered",
    `${workflowFile} does not run on pull_request, so CI would not run it for this review (only a pull_request trigger is reproduced)`,
  );
  if (on === undefined || on === null) return refuse("ci-not-triggered", `${workflowFile} declares no trigger (on:), so CI never runs it`);
  if (typeof on === "string") return on === PR ? { ok: true } : notPr;
  if (Array.isArray(on)) return on.includes(PR) ? { ok: true } : notPr;
  if (!isPlainObject(on)) return notPr;
  if (!Object.hasOwn(on, PR)) return notPr;
  const filter = on[PR];
  if (filter === null || filter === undefined) return { ok: true };
  if (!isPlainObject(filter)) return refuse("ci-unhonourable", `${workflowFile} on.pull_request is not a mapping`);
  for (const key of Object.keys(filter)) {
    if (key === "paths" || key === "paths-ignore") {
      return refuse("ci-unhonourable", `${workflowFile} filters pull_request by ${key}, which depends on the pull request's changed files; the launcher cannot evaluate it`);
    }
    if (key !== "branches" && key !== "branches-ignore" && key !== "types") {
      return refuse("ci-unhonourable", `${workflowFile} on.pull_request.${key} cannot be evaluated`);
    }
  }
  for (const key of ["branches", "branches-ignore"]) {
    if (filter[key] === undefined) continue;
    const list = asList(filter[key]);
    if (!list) return refuse("ci-unhonourable", `${workflowFile} on.pull_request.${key} is not a list of branch names`);
    const pattern = list.find((b) => /[*?[\]!+]/.test(b));
    if (pattern) {
      return refuse("ci-unhonourable", `${workflowFile} on.pull_request.${key} uses the pattern "${pattern}"; only exact branch names can be evaluated`);
    }
  }
  if (filter.branches !== undefined && filter["branches-ignore"] !== undefined) {
    return refuse("ci-unhonourable", `${workflowFile} sets both branches and branches-ignore for pull_request`);
  }
  if (filter.branches !== undefined && !asList(filter.branches).includes(base)) {
    return refuse("ci-not-triggered", `${workflowFile} runs on pull_request only into ${asList(filter.branches).join(", ")}, not into ${base}`);
  }
  if (filter["branches-ignore"] !== undefined && asList(filter["branches-ignore"]).includes(base)) {
    return refuse("ci-not-triggered", `${workflowFile} ignores pull requests into ${base}`);
  }
  if (filter.types !== undefined) {
    const types = asList(filter.types);
    if (!types || !types.includes("opened") || !types.includes("synchronize")) {
      return refuse(
        "ci-not-triggered",
        `${workflowFile} runs on pull_request only for ${JSON.stringify(filter.types)}; CI must run on opened and synchronize to cover every head`,
      );
    }
  }
  return { ok: true };
}

/** The job's needs as a list of job ids, or a refusal. */
function needsOf(job, where) {
  if (job.needs === undefined) return { ok: true, needs: [] };
  const list = asList(job.needs);
  if (!list || list.some((n) => !JOB_ID_RE.test(n))) return refuse("ci-unhonourable", `${where} needs: is not a list of job ids`);
  return { ok: true, needs: list };
}

/** Plan one job's own steps (not its needs). */
function planOneJob(doc, jobId, workflowFile, reserved, wfEnv, wfDefaults, ctx) {
  const job = doc.jobs[jobId];
  const where = `${workflowFile} job "${jobId}"`;
  if (!isPlainObject(job)) return refuse("no-ci-job", `${where} is not a mapping`);
  for (const key of Object.keys(job)) {
    if (!JOB_KEYS_HONOURED.has(key) && !JOB_KEYS_IGNORED.has(key)) {
      return refuse("ci-unhonourable", `${where} uses "${key}", which the review launcher cannot reproduce`);
    }
  }
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string" || !RUNNER_LABELS.has(runsOn)) {
    return refuse(
      "ci-unhonourable",
      `${where} runs-on ${JSON.stringify(runsOn)} is not a runner label the image stands in for (${[...RUNNER_LABELS].join(", ")})`,
    );
  }
  const jobTimeout = readTimeout(job["timeout-minutes"], where);
  if (!jobTimeout.ok) return jobTimeout;
  const when = condition(job.if);
  if (when === null) {
    return refuse("ci-unhonourable", `${where} if: ${JSON.stringify(job.if)} cannot be honoured (only absent, true, success() and always() can)`);
  }
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) {
    return refuse("ci-unhonourable", `${where} continue-on-error would count a failure as success`);
  }
  const needs = needsOf(job, where);
  if (!needs.ok) return needs;
  const jobEnv = readEnv(job.env, where, reserved);
  if (!jobEnv.ok) return jobEnv;
  const jobDefaults = readDefaults(job.defaults, where);
  if (!jobDefaults.ok) return jobDefaults;
  const defaultShell = jobDefaults.shell ?? wfDefaults.shell;
  const defaultDir = jobDefaults.workingDirectory ?? wfDefaults.workingDirectory;

  if (!Array.isArray(job.steps) || job.steps.length === 0) return refuse("no-ci-plan", `${where} has no steps`);

  const steps = [];
  const skipped = [];
  const pins = [];
  const shims = new Set();
  let fetchDepth = null;
  let stepNode = "default";
  for (const [i, step] of job.steps.entries()) {
    const index = i + 1;
    const label = typeof step?.name === "string" ? step.name : null;
    const at = `${where} step ${index}${label ? ` (${label})` : ""}`;
    if (!isPlainObject(step)) return refuse("ci-unhonourable", `${at} is not a mapping`);
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) return refuse("ci-unhonourable", `${at} uses "${key}", which the review launcher cannot reproduce`);
    }
    const stepWhen = condition(step.if);
    if (stepWhen === null) {
      return refuse("ci-unhonourable", `${at} if: ${JSON.stringify(step.if)} cannot be honoured (only absent, true, success() and always() can)`);
    }
    if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) {
      return refuse("ci-unhonourable", `${at} continue-on-error would count a failure as success`);
    }
    const hasUses = step.uses !== undefined;
    const hasRun = step.run !== undefined;
    if (hasUses === hasRun) return refuse("ci-unhonourable", `${at} must have exactly one of uses: and run:`);

    if (hasUses && step["timeout-minutes"] !== undefined) {
      return refuse("ci-unhonourable", `${at} sets timeout-minutes on a skipped action; how the real action behaves at that limit cannot be reproduced`);
    }
    const stepTimeout = readTimeout(step["timeout-minutes"], at);
    if (!stepTimeout.ok) return stepTimeout;
    const isCheckout = hasUses && typeof step.uses === "string" && step.uses.trim().toLowerCase().startsWith("actions/checkout@");
    if (index === 1 && !isCheckout) {
      return refuse("ci-unhonourable", `${where} does not begin with actions/checkout; on a CI runner its steps would run in an empty workspace`);
    }
    if (index > 1 && isCheckout) {
      return refuse("ci-unhonourable", `${at} checks out again after earlier steps; the launcher skips checkout only as a job's first step`);
    }

    if (hasUses) {
      const u = usesStep(step, at, ctx);
      if (!u.ok) return u;
      if (u.name === "actions/checkout") fetchDepth = u.fetchDepth;
      const nodePin = u.pins.find((p) => p.tool === "node");
      if (nodePin) stepNode = nodePin.range;
      skipped.push({ index, ...u.skipped });
      pins.push(...u.pins);
      if (u.shim) shims.add(u.shim);
      continue;
    }

    // Actions reads every scalar as text: `run: true` runs the command `true`.
    const script = ["string", "number", "boolean"].includes(typeof step.run) ? String(step.run) : "";
    if (script.trim() === "") return refuse("ci-unhonourable", `${at} run: is not a script`);
    if (hasExpression(script)) {
      return refuse("ci-unhonourable", `${at} run: contains a \${{ }} expression, which only the Actions runner can evaluate`);
    }
    const shell = step.shell ?? defaultShell;
    if (shell !== undefined && shell !== "bash") {
      return refuse("ci-unhonourable", `${at} shell ${JSON.stringify(shell)} cannot be reproduced (only bash)`);
    }
    const dir = workingDirectory(step["working-directory"] ?? defaultDir, at);
    if (!dir.ok) return dir;
    const stepEnv = readEnv(step.env, at, reserved);
    if (!stepEnv.ok) return stepEnv;
    steps.push({
      index,
      name: label ?? `run ${index}`,
      script,
      workingDirectory: dir.dir,
      env: { ...wfEnv, ...jobEnv.env, ...stepEnv.env },
      always: stepWhen === "always",
      timeoutMinutes: stepTimeout.minutes,
      node: stepNode,
    });
  }
  if (steps.length === 0) return refuse("no-ci-plan", `${where} has no run: steps; nothing would be built or tested`);
  return {
    ok: true,
    job: { id: jobId, needs: needs.needs, when, steps, skipped, fetchDepth, timeoutMinutes: jobTimeout.minutes ?? MAX_JOB_MINUTES },
    pins,
    shims: [...shims],
  };
}

/**
 * Plan the named job and its `needs` closure, dependencies first.
 * @param {{workflowText:string, workflowFile:string, jobId:string, baseBranch:string, reservedEnvKeys?:string[]}} input
 * @returns {{ok:true, workflow:string, job:string,
 *            jobs:{id:string, needs:string[], when:string,
 *                  steps:{index:number, name:string, script:string, workingDirectory:string, env:object, always:boolean, node:string}[],
 *                  skipped:{index:number, uses:string, tag:string, reason:string}[]}[],
 *            pins:{tool:string, range:string, source:string}[], shims:string[]}
 *          | {ok:false, refusal:{kind:string, message:string}}}
 */
export function planJob({ workflowText, workflowFile, jobId, baseBranch, reservedEnvKeys = [] }) {
  const reserved = new Set(reservedEnvKeys);
  const text = String(workflowText);
  if (Buffer.byteLength(text, "utf8") > MAX_WORKFLOW_BYTES) {
    return refuse("ci-unreadable", `${workflowFile} is larger than ${MAX_WORKFLOW_BYTES} bytes`);
  }
  if (typeof baseBranch !== "string" || !BRANCH_RE.test(baseBranch)) {
    return refuse("no-ci-job", `the base branch ${JSON.stringify(baseBranch)} is not a branch name`);
  }
  let doc;
  try {
    doc = load(text, { schema: CORE_SCHEMA, filename: workflowFile });
  } catch (err) {
    return refuse("ci-unreadable", `${workflowFile} is not valid YAML: ${err?.reason ?? err?.message ?? "parse error"}`);
  }
  const shape = checkShape(doc, workflowFile);
  if (!shape.ok) return shape;
  if (!isPlainObject(doc) || !isPlainObject(doc.jobs)) return refuse("no-ci-job", `${workflowFile} declares no jobs`);
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) return refuse("ci-unhonourable", `${workflowFile} has the top-level key "${key}", which the review launcher does not know`);
  }
  const trigger = checkTrigger(doc.on, baseBranch, workflowFile);
  if (!trigger.ok) return trigger;
  if (!Object.hasOwn(doc.jobs, jobId)) {
    return refuse("no-ci-job", `${workflowFile} has no job "${jobId}" (jobs: ${Object.keys(doc.jobs).join(", ")})`);
  }

  const wfEnv = readEnv(doc.env, `${workflowFile} workflow`, reserved);
  if (!wfEnv.ok) return wfEnv;
  const wfDefaults = readDefaults(doc.defaults, `${workflowFile} workflow`);
  if (!wfDefaults.ok) return wfDefaults;
  const ctx = { uploadNames: uploadNameCounts(doc) };

  // The needs closure, dependencies first (depth-first post-order).
  const ordered = [];
  const state = new Map(); // id -> "visiting" | "done"
  const pins = [];
  const shims = new Set();
  const visit = (id, from) => {
    if (state.get(id) === "done") return { ok: true };
    if (state.get(id) === "visiting") return refuse("ci-unhonourable", `${workflowFile} job "${id}" is part of a needs cycle`);
    if (!Object.hasOwn(doc.jobs, id)) return refuse("no-ci-job", `${workflowFile} job "${from}" needs "${id}", which the workflow does not define`);
    state.set(id, "visiting");
    const planned = planOneJob(doc, id, workflowFile, reserved, wfEnv.env, wfDefaults, ctx);
    if (!planned.ok) return planned;
    for (const need of planned.job.needs) {
      const r = visit(need, id);
      if (!r.ok) return r;
    }
    state.set(id, "done");
    ordered.push(planned.job);
    pins.push(...planned.pins);
    for (const s of planned.shims) shims.add(s);
    return { ok: true };
  };
  const closure = visit(jobId, jobId);
  if (!closure.ok) return closure;
  return { ok: true, workflow: workflowFile, job: jobId, jobs: ordered, pins, shims: [...shims] };
}
