/**
 * workflow-permissions.test.ts — the CI workflow's least privilege, and every
 * checkout's credentials.
 *
 * Follow-up to cli#415. That change gave `.github/workflows/test.yml` a
 * workflow-level `permissions: {}`, a per-job `contents: read` (and
 * `security-events: write` on the CodeQL job alone, with the comment naming the
 * upload step that needs it), and `persist-credentials: false` on every
 * `actions/checkout`. Nothing kept that true: a job added without a
 * `permissions` block inherits whatever the top level grants — empty today, but
 * a later edit to the top-level block widens every such job at once — and a
 * checkout added without `persist-credentials: false` puts the token back into
 * `.git/config`, where the PR-controlled steps that follow can read it.
 *
 * This is a detective, not a boundary: a pull request can edit the workflow and
 * this test together, and the boundary is review of the diff. What it holds is
 * that the widening cannot return silently. A job that appears without a
 * `permissions` block fails, a grant that grows a `write` without a comment
 * fails, a checkout that keeps its credentials fails, and the top level going
 * back to a real grant fails — each naming the job or step responsible.
 *
 * SCOPE. The four rules are enforced on the workflows that RUN PR-CONTROLLED
 * CODE and have adopted the shape cli#415 gave `test.yml`:
 *
 *   - `test.yml` — guarded (runs on `pull_request`).
 *   - `docker.yml` — NOT guarded: triggered by `workflow_run` (a completed
 *     Release) and `workflow_dispatch` only, so it never checks out a pull
 *     request; the ref it builds is a released tag, not PR-controlled code.
 *   - `release.yml` — NOT guarded: triggered by a `push` of `v*` tags, not by a
 *     pull request, and it already has its own guard
 *     (`release-workflow-permissions.test.ts`).
 *   - `smoke.yml` — runs PR-controlled code (`pull_request`), so it is IN the
 *     set this file inventories — but it has not yet adopted cli#415's shape
 *     (a single top-level `contents: read`, no per-job blocks, and a checkout
 *     with no `persist-credentials`), so holding it to the four rules here would
 *     fail a tree that is otherwise green. Hardening `smoke.yml` is a separate
 *     change; it is listed in `PR_EXCLUDED` so the exclusion is explicit and the
 *     workflow stays visible rather than silently uncovered. When it is
 *     hardened, move it into `GUARDED`.
 *
 * The inventory test below derives the set of `pull_request`-triggered
 * workflows from the files themselves and pins it, so a NEW workflow that runs
 * PR-controlled code cannot appear without a decision recorded here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface Job {
  name?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..", "..");
const WORKFLOW_DIR = join(REPO, ".github", "workflows");

/** Workflows the four rules are enforced on. */
const GUARDED = ["test.yml"];

/** Workflows that run PR-controlled code but are not (yet) held to the rules. */
const PR_EXCLUDED: Record<string, string> = {
  "smoke.yml":
    "runs PR-controlled code (pull_request), but has not adopted cli#415's shape " +
    "(top-level `contents: read`, no per-job blocks, no `persist-credentials`); " +
    "hardening it is a separate change",
};

/** Workflows that do not run PR-controlled code, and why they are out of scope. */
const NOT_PR: Record<string, string> = {
  "docker.yml": "triggered by `workflow_run` and `workflow_dispatch`, never `pull_request`",
  "release.yml": "triggered by a `push` of `v*` tags, never `pull_request`",
};

function raw(file: string): string {
  return readFileSync(join(WORKFLOW_DIR, file), "utf8");
}

function load(file: string): Workflow {
  return yaml.load(raw(file)) as Workflow;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

/** The trigger names a workflow declares under `on:` (string, list or mapping). */
function triggers(file: string): string[] {
  const wf = load(file) as unknown as Record<string, unknown>;
  // js-yaml keeps the `on` key as the string "on"; fall back to a boolean key
  // in case a schema ever resolves it to `true`.
  const on = wf.on ?? wf["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on as Record<string, unknown>);
  return [];
}

function runsPRCode(file: string): boolean {
  return triggers(file).some((t) => t === "pull_request" || t === "pull_request_target");
}

interface WriteScope {
  /** The job the declaration belongs to, or null for the workflow-level block. */
  job: string | null;
  scope: string;
  /** The text after `#` on the declaring line ("" when there is no comment). */
  comment: string;
}

interface PermScan {
  writes: WriteScope[];
  /** Declarations whose form the scanner cannot read — fail closed on these. */
  unreadable: string[];
}

function where(job: string | null): string {
  return job ?? "<workflow-level>";
}

/** The `#`-comment text on a line, or "" when the line carries none. */
function commentOn(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? "" : line.slice(hash + 1).trim();
}

/**
 * Every `<scope>: write` declaration under a `permissions:` key, workflow-level
 * or per-job, read from the RAW text because YAML drops comments. Block-style
 * maps are read line by line; a single-line flow-style map
 * (`permissions: {a: read, b: write}`) is read from its own line. A scalar grant
 * (`permissions: write-all`) or a flow map that does not close on its line is
 * reported as unreadable, so an unread form cannot slip past the comment check.
 * The job a declaration sits under is the nearest preceding two-space-indented
 * `name:` line.
 */
function scanPermissions(file: string): PermScan {
  const lines = raw(file).split("\n");
  const writes: WriteScope[] = [];
  const unreadable: string[] = [];
  let job: string | null = null;
  let inBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (jobMatch) job = jobMatch[1];

    const permMatch = /^(\s*)permissions:\s*(.*)$/.exec(line);
    if (permMatch) {
      const value = permMatch[2].trim();
      if (value === "") {
        inBlock = true;
        blockIndent = permMatch[1].length;
      } else if (value === "{}") {
        // Grants nothing — the shape cli#415 uses at the top level.
      } else if (value.startsWith("{")) {
        if (!value.endsWith("}")) {
          unreadable.push(`${where(job)} → flow-style map not closed on one line`);
        } else {
          const re = /([A-Za-z0-9_-]+)\s*:\s*["']?([A-Za-z-]+)["']?/g;
          for (let m = re.exec(value); m !== null; m = re.exec(value)) {
            if (m[2] === "write") writes.push({ job, scope: m[1], comment: commentOn(line) });
          }
        }
      } else {
        unreadable.push(`${where(job)} → scalar permissions "${value}"`);
      }
      continue;
    }

    if (!inBlock) continue;
    if (line.trim() === "") continue;
    // A line at or above the `permissions:` line closes the block.
    const indent = line.length - line.trimStart().length;
    if (indent <= blockIndent) {
      inBlock = false;
      continue;
    }

    const entry = /^\s*([A-Za-z0-9_-]+):\s*(\S+)(.*)$/.exec(line);
    if (entry && entry[2] === "write") {
      writes.push({ job, scope: entry[1], comment: commentOn(entry[3]) });
    }
  }

  return { writes, unreadable };
}

/**
 * The names and actions a job's steps expose, for checking that a write's
 * comment names the step that needs the grant rather than merely carrying a `#`.
 */
function stepIdentifiers(job: Job | undefined): string[] {
  const ids: string[] = [];
  for (const step of job?.steps ?? []) {
    if (step.name) ids.push(step.name);
    if (step.uses) {
      ids.push(step.uses);
      ids.push(step.uses.split("@")[0]);
    }
  }
  return ids;
}

function checkouts(file: string): Array<{ job: string; step: Step }> {
  const wf = load(file);
  return Object.entries(wf.jobs ?? {}).flatMap(([job, j]) =>
    (j.steps ?? [])
      .filter((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"))
      .map((step) => ({ job, step })),
  );
}

function stepLabel(step: Step): string {
  return step.name ?? step.uses ?? "<unnamed step>";
}

describe("test workflow — least privilege (cli#416)", () => {
  const wf = load("test.yml");

  test("the top level grants nothing: every job opts in to its own scopes", () => {
    // cli#415 put `permissions: {}` at the top level. Anything else here — a
    // `contents: read` at the top, or a `write` of any scope — hands every job
    // that omits its own block whatever the top level declares, one edit from
    // widening all of them at once.
    expect(wf.permissions).toEqual({});
  });

  test("every job declares its own permissions map", () => {
    const jobNames = Object.keys(wf.jobs ?? {});
    expect(jobNames.length, "test.yml has at least one job").toBeGreaterThan(0);

    // A missing block inherits the workflow default; a scalar (`write-all`) is a
    // whole access class with no step to name. Either way the job does not opt
    // in to a scope it can be held to, so both fail here.
    const bad = jobNames.filter((name) => {
      const p = wf.jobs?.[name].permissions as unknown;
      return p === undefined || p === null || typeof p !== "object" || Array.isArray(p);
    });
    expect(
      bad,
      `jobs without a permissions map of their own (they inherit the workflow default, or grant a whole access class): ${bad.join(", ")}`,
    ).toEqual([]);
  });

  test("every write scope is readable and names the step that needs it", () => {
    // The model is the CodeQL job's `security-events: write # CodeQL's upload of
    // SARIF results (the "Perform CodeQL Analysis" step)`. A bare `write` says a
    // scope is needed but not by what, so the next reader cannot tell whether it
    // is still needed at all; a `# TODO` says just as little.
    const { writes, unreadable } = scanPermissions("test.yml");
    expect(writes.length, "test.yml declares at least one write scope (positive control)").toBeGreaterThan(
      0,
    );

    const problems = unreadable.map((u) => `unreadable permissions declaration: ${u}`);
    for (const w of writes) {
      const ids = w.job === null ? [] : stepIdentifiers(wf.jobs?.[w.job]);
      if (w.comment === "") {
        problems.push(`${where(w.job)} → ${w.scope}: write (no inline comment)`);
      } else if (ids.length > 0 && !ids.some((id) => w.comment.toLowerCase().includes(id.toLowerCase()))) {
        problems.push(`${where(w.job)} → ${w.scope}: write (comment names no step: "${w.comment}")`);
      }
    }
    expect(
      problems,
      `write scopes with no comment naming the step that needs them: ${problems.join("; ")}`,
    ).toEqual([]);
  });

  test("every actions/checkout disables credential persistence", () => {
    const found = checkouts("test.yml");
    expect(found.length, "test.yml checks out at least once").toBeGreaterThan(0);

    const offending = found
      .filter(({ step }) => step.with?.["persist-credentials"] !== false)
      .map(({ job, step }) => `${job} → ${stepLabel(step)}`);
    expect(
      offending,
      `checkouts that persist the token into .git/config: ${offending.join("; ")}`,
    ).toEqual([]);
  });
});

describe("workflow permissions — inventory (cli#416)", () => {
  test("the workflows that run PR-controlled code are exactly the ones recorded here", () => {
    // Positive control AND tripwire: a new `pull_request`-triggered workflow
    // cannot appear without being either guarded or explicitly excluded.
    const discovered = workflowFiles().filter(runsPRCode);
    const recorded = [...GUARDED, ...Object.keys(PR_EXCLUDED)].sort();
    expect(
      discovered,
      `workflows triggered by a pull request: ${discovered.join(", ")}`,
    ).toEqual(recorded);
  });

  test("every workflow excluded as not PR-controlled really is not", () => {
    expect(workflowFiles(), "the exclusions name existing workflows").toEqual(
      expect.arrayContaining(Object.keys(NOT_PR)),
    );
    for (const [file, why] of Object.entries(NOT_PR)) {
      expect(triggers(file), `${file} is not triggered by a pull request (${why})`).not.toContain(
        "pull_request",
      );
      expect(triggers(file), `${file} is not triggered by pull_request_target (${why})`).not.toContain(
        "pull_request_target",
      );
    }
  });

  test("every workflow is either guarded or accounted for", () => {
    const classified = new Set([...GUARDED, ...Object.keys(PR_EXCLUDED), ...Object.keys(NOT_PR)]);
    const unclassified = workflowFiles().filter((f) => !classified.has(f));
    expect(
      unclassified,
      `workflows with no decision recorded in this file: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });
});