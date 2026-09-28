/**
 * ci-job.mjs — turn ONE named job of a reviewed commit's GitHub Actions workflow
 * into the review build's step plan, or refuse by name.
 *
 * The host names the job (REVIEWER_CI_WORKFLOW + REVIEWER_CI_JOB in the
 * reviewer's sandbox env); nothing about which job runs is inferred from the
 * workflow's text. The workflow is parsed as YAML (js-yaml, the version the
 * repository's bun.lock pins, with the YAML 1.2 core schema: no custom tags, no
 * code). Every `run:` step of the job runs, in order, as one script in its
 * working directory, the way the Actions runner runs it; the launcher executes
 * each under `bash --noprofile --norc -eo pipefail`.
 *
 * WHAT IS HONOURED
 *   - `run:` steps, with `working-directory`, `shell: bash`, plain `env:` values
 *     (workflow, job and step level) and `defaults.run` (shell/working-directory).
 *   - `if:` when it is absent, `true`, `success()` or `always()` (on the job or a
 *     step). An `always()` step still runs after an earlier failure; the build is
 *     reported failed either way.
 *   - `runs-on:` an x86_64 `ubuntu-latest` / `ubuntu-<version>` runner.
 *
 * WHAT IS SKIPPED (named in the plan, with the reason)
 *   - actions/checkout: the workspace IS the host-created worktree at the
 *     assigned head. Only inputs that do not change the tree are accepted.
 *   - oven-sh/setup-bun, actions/setup-node: the image provides the runtime; the
 *     version pin becomes a requirement the resolver and launcher verify.
 *   - socketdev/action: Socket Firewall wraps package downloads in CI. It is NOT
 *     reproduced: `sfw <cmd>` runs `<cmd>` unwrapped through a shim. A frozen
 *     install is still enforced (lockfile drift fails the build).
 *   - actions/cache (+/restore, /save), actions/upload-artifact: a cold,
 *     unpublished build can only be slower or stricter than CI, never greener.
 *   - Ignored job keys: name, needs (each job runs on a fresh runner; an output
 *     it passes needs a `${{ }}` expression, which is refused), permissions
 *     (scopes a token the sandbox never has), concurrency, outputs,
 *     timeout-minutes (a hung step never exits 0, so it can never pass).
 *
 * WHAT IS REFUSED (anything else): any other action (including local `./` and
 * `docker://` actions), a `${{ }}` expression in a script, env value or checked
 * input, any other `if:`, `continue-on-error: true`, a non-bash shell,
 * `strategy`, `container`, `services`, `environment`, reusable-workflow jobs, an
 * env key the launcher owns (HOME, PATH, ...), a working directory outside the
 * workspace, and a job with no `run:` step.
 */
import { CORE_SCHEMA, load } from "js-yaml";

export const WORKFLOW_PATH_RE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
export const JOB_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const refuse = (kind, message) => ({ ok: false, refusal: { kind, message } });
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasExpression = (v) => typeof v === "string" && v.includes("${{");

const JOB_KEYS_HONOURED = new Set(["runs-on", "if", "env", "defaults", "steps", "continue-on-error"]);
const JOB_KEYS_IGNORED = new Set(["name", "needs", "permissions", "concurrency", "outputs", "timeout-minutes"]);
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

/** Root files the resolver already reads: a *-version-file naming one adds nothing new. */
const NODE_VERSION_FILES = new Set([".nvmrc", ".node-version", ".tool-versions"]);
const BUN_VERSION_FILES = new Set([".bun-version", ".tool-versions", "package.json"]);

/**
 * The actions a review build skips. `inputs` is the accepted `with:` key set
 * (checked, expression-free); `inputs: null` means the step is skipped whole and
 * its inputs are not read. `pin` turns the inputs into runtime requirements.
 */
const SKIPPED_ACTIONS = {
  "actions/checkout": {
    reason: "the workspace is the host-created worktree at the assigned head",
    inputs: new Set(["persist-credentials", "fetch-depth", "clean", "show-progress"]),
  },
  "oven-sh/setup-bun": {
    reason: "the image provides bun; the pin is verified against the actual runtime",
    inputs: new Set(["bun-version", "bun-version-file", "no-cache"]),
    pin(withInputs, source) {
      if (withInputs["bun-version"] !== undefined) {
        return { ok: true, pins: [{ tool: "bun", range: String(withInputs["bun-version"]), source: `${source} bun-version` }] };
      }
      const file = withInputs["bun-version-file"];
      if (file !== undefined) {
        if (BUN_VERSION_FILES.has(String(file))) return { ok: true, pins: [] };
        return refuse("ci-unhonourable", `${source} reads bun-version-file "${file}", which the resolver does not read; pin bun-version`);
      }
      return refuse("ambiguous", `${source} sets no bun-version, so CI installs whatever bun is latest; pin bun-version`);
    },
  },
  "actions/setup-node": {
    reason: "the image provides node; the pin is verified against the actual runtime",
    inputs: new Set(["node-version", "node-version-file", "cache", "cache-dependency-path", "check-latest"]),
    pin(withInputs, source) {
      if (withInputs["check-latest"] !== undefined && String(withInputs["check-latest"]) !== "false") {
        return refuse("ambiguous", `${source} sets check-latest, so CI floats to the newest matching node`);
      }
      if (withInputs["node-version"] !== undefined) {
        return { ok: true, pins: [{ tool: "node", range: String(withInputs["node-version"]), source: `${source} node-version` }] };
      }
      const file = withInputs["node-version-file"];
      if (file !== undefined && !NODE_VERSION_FILES.has(String(file))) {
        return refuse("ci-unhonourable", `${source} reads node-version-file "${file}", which the resolver does not read; pin node-version`);
      }
      return { ok: true, pins: [] };
    },
  },
  "socketdev/action": {
    reason: "Socket Firewall is not reproduced in the sandbox; `sfw <cmd>` runs <cmd> unwrapped",
    inputs: new Set(["mode"]),
    shim: "sfw",
  },
  "actions/cache": { reason: "a cold build is never greener than a cached one", inputs: null },
  "actions/cache/restore": { reason: "a cold build is never greener than a cached one", inputs: null },
  "actions/cache/save": { reason: "saving a cache does not change the build", inputs: null },
  "actions/upload-artifact": { reason: "publishing an artifact does not change the build", inputs: null },
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

/** A working directory relative to the workspace root, or a refusal. */
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
function usesStep(step, where) {
  const ref = typeof step.uses === "string" ? step.uses.trim() : "";
  if (ref === "" || ref.startsWith("./") || ref.startsWith("docker://") || !ref.includes("@")) {
    return refuse("ci-unhonourable", `${where} uses ${JSON.stringify(step.uses)}, which the review launcher cannot reproduce`);
  }
  const name = ref.split("@")[0].toLowerCase();
  const action = SKIPPED_ACTIONS[name];
  if (!action) {
    return refuse(
      "ci-unhonourable",
      `${where} uses ${ref}, which the review launcher cannot reproduce (it runs run: steps and skips only ${Object.keys(SKIPPED_ACTIONS).join(", ")})`,
    );
  }
  let withInputs = {};
  if (action.inputs !== null) {
    if (step.with !== undefined && step.with !== null && !isPlainObject(step.with)) {
      return refuse("ci-unhonourable", `${where} with: is not a mapping`);
    }
    withInputs = step.with ?? {};
    for (const [key, value] of Object.entries(withInputs)) {
      if (!action.inputs.has(key)) return refuse("ci-unhonourable", `${where} passes ${name} the input "${key}", which the review launcher cannot reproduce`);
      if (value !== null && typeof value === "object") return refuse("ci-unhonourable", `${where} input ${key} is not a scalar`);
      if (hasExpression(String(value))) {
        return refuse("ci-unhonourable", `${where} input ${key} uses a \${{ }} expression, which only the Actions runner can evaluate`);
      }
    }
  }
  const pinned = action.pin ? action.pin(withInputs, where) : { ok: true, pins: [] };
  if (!pinned.ok) return pinned;
  return { ok: true, skipped: { uses: ref, reason: action.reason }, pins: pinned.pins, shim: action.shim ?? null };
}

/**
 * Plan the named job.
 * @param {{workflowText:string, workflowFile:string, jobId:string, reservedEnvKeys?:string[]}} input
 * @returns {{ok:true, workflow:string, job:string,
 *            steps:{index:number, name:string, script:string, workingDirectory:string, env:object, always:boolean}[],
 *            skipped:{index:number, uses:string, reason:string}[],
 *            pins:{tool:string, range:string, source:string}[], shims:string[]}
 *          | {ok:false, refusal:{kind:string, message:string}}}
 */
export function planJob({ workflowText, workflowFile, jobId, reservedEnvKeys = [] }) {
  const reserved = new Set(reservedEnvKeys);
  let doc;
  try {
    doc = load(String(workflowText), { schema: CORE_SCHEMA, filename: workflowFile });
  } catch (err) {
    return refuse("ci-unreadable", `${workflowFile} is not valid YAML: ${err?.reason ?? err?.message ?? "parse error"}`);
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.jobs)) return refuse("no-ci-job", `${workflowFile} declares no jobs`);
  if (!Object.hasOwn(doc.jobs, jobId)) {
    return refuse("no-ci-job", `${workflowFile} has no job "${jobId}" (jobs: ${Object.keys(doc.jobs).join(", ")})`);
  }
  const job = doc.jobs[jobId];
  const where = `${workflowFile} job "${jobId}"`;
  if (!isPlainObject(job)) return refuse("no-ci-job", `${where} is not a mapping`);

  for (const key of Object.keys(job)) {
    if (!JOB_KEYS_HONOURED.has(key) && !JOB_KEYS_IGNORED.has(key)) {
      return refuse("ci-unhonourable", `${where} uses "${key}", which the review launcher cannot reproduce`);
    }
  }
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string" || !/^ubuntu-(latest|\d+\.\d+)$/.test(runsOn)) {
    return refuse("ci-unhonourable", `${where} runs-on ${JSON.stringify(runsOn)} is not an x86_64 ubuntu runner the linux/amd64 image stands in for`);
  }
  if (condition(job.if) !== "success" && condition(job.if) !== "always") {
    return refuse("ci-unhonourable", `${where} if: ${JSON.stringify(job.if)} cannot be honoured (only absent, true, success() and always() can)`);
  }
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) {
    return refuse("ci-unhonourable", `${where} continue-on-error would count a failure as success`);
  }

  const wfEnv = readEnv(doc.env, `${workflowFile} workflow`, reserved);
  if (!wfEnv.ok) return wfEnv;
  const jobEnv = readEnv(job.env, where, reserved);
  if (!jobEnv.ok) return jobEnv;
  const wfDefaults = readDefaults(doc.defaults, `${workflowFile} workflow`);
  if (!wfDefaults.ok) return wfDefaults;
  const jobDefaults = readDefaults(job.defaults, where);
  if (!jobDefaults.ok) return jobDefaults;
  const defaultShell = jobDefaults.shell ?? wfDefaults.shell;
  const defaultDir = jobDefaults.workingDirectory ?? wfDefaults.workingDirectory;

  if (!Array.isArray(job.steps) || job.steps.length === 0) return refuse("no-ci-plan", `${where} has no steps`);

  const steps = [];
  const skipped = [];
  const pins = [];
  const shims = new Set();
  for (const [i, step] of job.steps.entries()) {
    const index = i + 1;
    const label = typeof step?.name === "string" ? step.name : null;
    const at = `${where} step ${index}${label ? ` (${label})` : ""}`;
    if (!isPlainObject(step)) return refuse("ci-unhonourable", `${at} is not a mapping`);
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) return refuse("ci-unhonourable", `${at} uses "${key}", which the review launcher cannot reproduce`);
    }
    const when = condition(step.if);
    if (when === null) {
      return refuse("ci-unhonourable", `${at} if: ${JSON.stringify(step.if)} cannot be honoured (only absent, true, success() and always() can)`);
    }
    if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) {
      return refuse("ci-unhonourable", `${at} continue-on-error would count a failure as success`);
    }
    const hasUses = step.uses !== undefined;
    const hasRun = step.run !== undefined;
    if (hasUses === hasRun) return refuse("ci-unhonourable", `${at} must have exactly one of uses: and run:`);

    if (hasUses) {
      const u = usesStep(step, at);
      if (!u.ok) return u;
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
      env: { ...wfEnv.env, ...jobEnv.env, ...stepEnv.env },
      always: when === "always",
    });
  }
  if (steps.length === 0) return refuse("no-ci-plan", `${where} has no run: steps; nothing would be built or tested`);
  return { ok: true, workflow: workflowFile, job: jobId, steps, skipped, pins, shims: [...shims] };
}
