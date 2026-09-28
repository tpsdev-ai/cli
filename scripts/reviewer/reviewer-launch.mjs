/**
 * reviewer-launch.mjs — the trusted launcher for a review build.
 *
 * Before ANY repository code runs it:
 *   1. records the actual Bun and Node versions and verifies them against the
 *      selected runtime entry AND the repository's declared requirements;
 *   2. sets hermetic, container-local HOME/tmp/cache locations (host values are
 *      never inherited);
 *   3. derives the repository's CI-equivalent frozen install, build and test
 *      commands from its own CI lanes and runs them in order.
 * Any mismatch, missing stage or unfrozen install stops the build.
 *
 * The pure decision functions are exported so the host can unit-test them; the
 * container runs `main()`.
 */

const HERMETIC = {
  HOME: "/home/reviewer",
  USERPROFILE: "/home/reviewer",
  TMPDIR: "/tmp/review",
  TMP: "/tmp/review",
  TEMP: "/tmp/review",
  XDG_CACHE_HOME: "/tmp/review/.cache",
  XDG_CONFIG_HOME: "/tmp/review/.config",
  XDG_DATA_HOME: "/tmp/review/.local/share",
  npm_config_cache: "/tmp/review/npm-cache",
  BUN_INSTALL_CACHE_DIR: "/tmp/review/bun-cache",
  BUN_TMPDIR: "/tmp/review/bun-tmp",
  PIP_CACHE_DIR: "/tmp/review/pip-cache",
  GOCACHE: "/tmp/review/go-cache",
};

/** The isolation keys a host environment must never contribute. */
export const HERMETIC_KEYS = Object.keys(HERMETIC);

/** Credential-shaped variables that must never reach a child process. */
export const CREDENTIAL_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
];

/**
 * Build the child environment: every hermetic key is forced to its
 * container-local value, and any host value for those keys is dropped first.
 * Credential-shaped variables are dropped too, so the child never inherits a
 * sandbox or host credential. Other keys pass through untouched.
 */
export function hermeticEnv(baseEnv = {}) {
  const out = { ...baseEnv };
  for (const key of [...HERMETIC_KEYS, ...CREDENTIAL_KEYS]) delete out[key];
  return { ...out, ...HERMETIC };
}

/** Does `version` satisfy `range`? Delegates to the shared resolver's matcher
 *  so selection and verification cannot disagree. */
import { satisfiesRange } from "./resolve-runtime.mjs";

/**
 * Verify the ACTUAL runtime versions against the selected image entry and the
 * repository's requirements.
 * @returns {{ok:true, receipt:object} | {ok:false, refusal:{kind:string, message:string}}}
 */
export function verifyRuntime({ image, actual, requirements = {} }) {
  if (!image || typeof image.node !== "string" || typeof image.bun !== "string") {
    return { ok: false, refusal: { kind: "no-image", message: "no selected runtime entry was supplied" } };
  }
  if (actual?.node !== image.node) {
    return {
      ok: false,
      refusal: {
        kind: "version-mismatch",
        message: `actual node ${actual?.node ?? "(unknown)"} does not match the selected image entry node ${image.node}; stopping the review build`,
      },
    };
  }
  if (actual?.bun !== image.bun) {
    return {
      ok: false,
      refusal: {
        kind: "version-mismatch",
        message: `actual bun ${actual?.bun ?? "(unknown)"} does not match the selected image entry bun ${image.bun}; stopping the review build`,
      },
    };
  }
  if (requirements.node && !satisfiesRange(actual.node, requirements.node)) {
    return {
      ok: false,
      refusal: {
        kind: "unsupported",
        message: `actual node ${actual.node} does not satisfy the repository's requirement ${requirements.node}`,
      },
    };
  }
  if (requirements.bun && !satisfiesRange(actual.bun, requirements.bun)) {
    return {
      ok: false,
      refusal: {
        kind: "unsupported",
        message: `actual bun ${actual.bun} does not satisfy the repository's requirement ${requirements.bun}`,
      },
    };
  }
  return {
    ok: true,
    receipt: {
      image_id: image.id,
      node: actual.node,
      bun: actual.bun,
      requirements_verified: true,
    },
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

const INSTALL_RE = /\b(?:bun|npm|yarn|pnpm)\b[^\n]*\b(?:install|ci)\b/;
const FROZEN_RE = /frozen-lockfile|npm\s+ci\b|--frozen\b|--immutable\b/;
const BUILD_RE = /\b(?:bun|npm|yarn|pnpm)\b[^\n]*\brun\s+build\b|(?:^|\s)build\b/;
const TEST_RE = /\b(?:bun|npm|yarn|pnpm)\b[^\n]*\b(?:run\s+)?test\b/;

/** Extract the `run:` command text of each step in a workflow lane,
 *  normalizing the CI-only `sfw` supply-chain wrapper away (it is not part of
 *  the build) and collapsing multi-line steps to one string per line. */
export function extractRunSteps(laneText) {
  const lines = String(laneText).split(/\r?\n/);
  const steps = [];
  let current = null;
  for (const line of lines) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (m) {
      if (current) steps.push(current);
      current = { indent: m[1].length, text: m[2] };
      continue;
    }
    if (current) {
      // A deeper-indented line continues the script block.
      if (line.trim() !== "" && line.match(/^\s+/)?.[0].length > current.indent) {
        current.text += `\n${line.trim()}`;
      } else if (line.trim() === "") {
        // keep the block open on blank lines
      } else {
        steps.push(current);
        current = null;
      }
    }
  }
  if (current) steps.push(current);
  return steps
    .flatMap((s) => s.text.split(/\n/))
    .map((s) => s.replace(/^\s*sfw\s+/, "").trim())
    .filter((s) => s !== "");
}

/**
 * Derive the CI-equivalent command plan from the repository's CI lanes. The
 * plan is exactly the repository's own install/build/test commands — a repo
 * launcher is preserved, never replaced by a blanket command.
 */
export function deriveCiPlan(lanes) {
  for (const lane of lanes ?? []) {
    const file = typeof lane === "string" ? "lane" : lane?.file ?? "lane";
    const text = typeof lane === "string" ? lane : lane?.text ?? "";
    const commands = extractRunSteps(text);
    const install = commands.find((c) => INSTALL_RE.test(c));
    const build = commands.find((c) => BUILD_RE.test(c) && !INSTALL_RE.test(c));
    const test = commands.find((c) => TEST_RE.test(c) && !INSTALL_RE.test(c) && !BUILD_RE.test(c));
    if (!install || !build || !test) continue;
    if (!FROZEN_RE.test(install)) {
      return {
        ok: false,
        refusal: {
          kind: "unfrozen-install",
          message: `the CI lane ${file} installs without a frozen lockfile ("${install}"); a review build requires a frozen install`,
        },
      };
    }
    return { ok: true, file, steps: [install, build, test] };
  }
  return {
    ok: false,
    refusal: {
      kind: "no-ci-plan",
      message: "no CI lane declares a frozen install, a build and a test stage; refusing to substitute a blanket test command",
    },
  };
}

/** Run the plan, stopping at the first non-zero exit. */
export async function runPlan(steps, run, env) {
  const results = [];
  for (const step of steps) {
    const code = await run(step, env);
    results.push({ command: step, code });
    if (code !== 0) return { ok: false, results, failed: step, code };
  }
  return { ok: true, results };
}

// ─── Container entry ─────────────────────────────────────────────────────────

async function main(argv) {
  const { spawn, execFileSync } = await import("node:child_process");
  const { readFileSync, existsSync } = await import("node:fs");
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const imageId = flag("--image") ?? process.env.REVIEWER_IMAGE_ID;

  if (args.includes("--self-check")) {
    const matrixPath = flag("--matrix") ?? "/opt/reviewer/runtime-matrix.json";
    const table = JSON.parse(readFileSync(matrixPath, "utf8"));
    const image = (table.images ?? []).find((i) => i.id === imageId);
    const requirements = {};
    if (flag("--require-node")) requirements.node = flag("--require-node");
    if (flag("--require-bun")) requirements.bun = flag("--require-bun");
    // The launcher runs under node, so bun's version is read from the bun
    // binary itself — never assumed.
    let bunVersion = null;
    try {
      bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      bunVersion = null;
    }
    const result = verifyRuntime({
      image,
      actual: { node: process.versions.node, bun: bunVersion },
      requirements,
    });
    if (!result.ok) {
      process.stderr.write(`${result.refusal.kind}: ${result.refusal.message}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(result.receipt)}\n`);
    return 0;
  }

  const workspace = flag("--workspace") ?? "/workspace";
  const lanes = [];
  for (const wf of ["test.yml", "test.yaml", "ci.yml", "ci.yaml"]) {
    const p = `${workspace}/.github/workflows/${wf}`;
    if (existsSync(p)) lanes.push({ file: `.github/workflows/${wf}`, text: readFileSync(p, "utf8") });
  }
  const plan = deriveCiPlan(lanes);
  if (!plan.ok) {
    process.stderr.write(`${plan.refusal.kind}: ${plan.refusal.message}\n`);
    return 1;
  }
  const env = hermeticEnv(process.env);
  const run = (command, childEnv) =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-lc", command], { cwd: workspace, env: childEnv, stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 1));
    });
  const outcome = await runPlan(plan.steps, run, env);
  if (!outcome.ok) {
    process.stderr.write(`stage failed (exit ${outcome.code}): ${outcome.failed}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ status: "review-build-ok", steps: outcome.results })}\n`);
  return 0;
}

// Only act as an entry point when executed directly.
if (process.argv[1] && process.argv[1].endsWith("reviewer-launch.mjs")) {
  main(process.argv).then((code) => process.exit(code));
}
