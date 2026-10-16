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
 *   - `real-flair.yml` — guarded (runs on `pull_request`, path-filtered).
 *   - `docker.yml` — NOT guarded: its only trigger is `workflow_dispatch`; it
 *     has no `pull_request` trigger.
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
const GUARDED = ["test.yml", "real-flair.yml"];

/** Workflows that run PR-controlled code but are not (yet) held to the rules. */
const PR_EXCLUDED: Record<string, string> = {
  "smoke.yml":
    "runs PR-controlled code (pull_request), but has not adopted cli#415's shape " +
    "(top-level `contents: read`, no per-job blocks, no `persist-credentials`); " +
    "hardening it is a separate change",
};

/** Workflows that do not run PR-controlled code, and why they are out of scope. */
const NOT_PR: Record<string, string> = {
  "docker.yml": "its only trigger is `workflow_dispatch`; no `pull_request` trigger",
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

/** The map key for one scope of one job; the workflow level gets its own job. */
function scopeKey(job: string | null, scope: string): string {
  return `${job ?? "\u0000workflow"}\u0000${scope}`;
}

/**
 * The `#`-comment on the raw line that declares each scope under a
 * `permissions:` key. YAML drops comments, so the text is read for the comment
 * alone; which scopes GRANT write is decided from the parsed workflow (see
 * scanPermissions). Block-style maps, a flow map on the `permissions:` line or
 * the line after it, a quoted key and an explicit `? key` / `: value` pair are
 * all read. The job a declaration sits under is the nearest preceding key under
 * `jobs:`.
 */
function declarationComments(text: string): Map<string, string> {
  const byKey = new Map<string, string>();
  let job: string | null = null;
  let inJobs = false;
  let inPermissions = false;
  let permissionsIndent = -1;
  let explicitScope: string | null = null;

  const record = (line: string): void => {
    const comment = commentOn(line);
    const code = line.indexOf("#") === -1 ? line : line.slice(0, line.indexOf("#"));
    const explicitKey = /^\s*\?\s*(?:"|')?([A-Za-z][A-Za-z0-9_-]*)(?:"|')?\s*$/.exec(code);
    if (explicitKey) {
      explicitScope = scopeKey(job, explicitKey[1]);
      byKey.set(explicitScope, comment);
      return;
    }
    if (/^\s*:\s*.*$/.test(code) && explicitScope !== null) {
      if (comment !== "" && byKey.get(explicitScope) === "") byKey.set(explicitScope, comment);
      explicitScope = null;
      return;
    }
    explicitScope = null;
    // A mapping key, optionally quoted: `key:`, `"key":` or `{key:`.
    const re = /(?:"|')?([A-Za-z][A-Za-z0-9_-]*)(?:"|')?\s*:/g;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      if (m[1] === "permissions") continue; // the key itself, not a scope
      byKey.set(scopeKey(job, m[1]), comment);
    }
  };

  for (const line of text.split("\n")) {
    // A top-level key (no indent). `jobs:` starts the job list; any other
    // top-level key ends it and clears the current job.
    if (/^[A-Za-z0-9_-]+:/.test(line)) {
      inJobs = /^jobs:\s*(#.*)?$/.test(line);
      job = null;
    }
    const jobMatch = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line) : null;
    if (jobMatch) job = jobMatch[1];

    const permMatch = /^(\s*)(?:"|')?permissions(?:"|')?\s*:\s*(.*)$/.exec(line);
    if (permMatch) {
      inPermissions = true;
      permissionsIndent = permMatch[1].length;
      explicitScope = null;
      record(line);
      continue;
    }
    if (!inPermissions) continue;
    if (line.trim() === "") continue;
    // A line at or above the `permissions:` line closes the block.
    const indent = line.length - line.trimStart().length;
    if (indent > permissionsIndent) {
      record(line);
      continue;
    }
    inPermissions = false;
    explicitScope = null;
  }
  return byKey;
}

/**
 * Every write grant in a parsed workflow: the workflow-level `permissions` map
 * and each job's map. A scope grants write when its value is `write` or
 * `write-all`, read from the parsed document, so the spelling in the text —
 * quoted key or value, flow map, anchor or alias, a `!!str` tag, an explicit
 * `? key` — does not decide whether the grant is found. A `permissions` value
 * that is not a map (a scalar such as `write-all`) has no scope to name a step,
 * so it is reported as unreadable and fails closed. The justification comment
 * comes from the raw text, the one thing YAML drops.
 */
function scanPermissions(wf: Workflow, text: string): PermScan {
  const comments = declarationComments(text);
  const writes: WriteScope[] = [];
  const unreadable: string[] = [];

  const maps: Array<[string | null, unknown]> = [[null, wf.permissions]];
  for (const [name, job] of Object.entries(wf.jobs ?? {})) maps.push([name, job.permissions]);

  for (const [job, permissions] of maps) {
    if (permissions === undefined || permissions === null) continue;
    if (typeof permissions !== "object" || Array.isArray(permissions)) {
      unreadable.push(`${where(job)} → permissions is not a map (${JSON.stringify(permissions)})`);
      continue;
    }
    for (const [scope, value] of Object.entries(permissions as Record<string, unknown>)) {
      if (value === "write" || value === "write-all") {
        writes.push({ job, scope, comment: comments.get(scopeKey(job, scope)) ?? "" });
      }
    }
  }
  return { writes, unreadable };
}

/** The scan over a workflow file: parsed grants, raw-text comments. */
function scanFile(file: string): PermScan {
  return scanPermissions(load(file), raw(file));
}

/** The scan over workflow text, so the rules can be checked on fixtures. */
function scanText(text: string): PermScan {
  return scanPermissions(yaml.load(text) as Workflow, text);
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

/**
 * A checkout is any `uses:` whose action name is `checkout`, whatever owner it
 * comes from: a fork such as `someone/checkout@v4` persists the token exactly
 * like `actions/checkout@…`, so it is held to the same rule (cli#418 review).
 */
function isCheckout(uses: unknown): boolean {
  return typeof uses === "string" && /(^|\/)checkout(@|$)/i.test(uses.split("@")[0] + (uses.includes("@") ? "@" : ""));
}

function checkoutsOf(wf: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(wf.jobs ?? {}).flatMap(([job, j]) =>
    (j.steps ?? []).filter((s) => isCheckout(s.uses)).map((step) => ({ job, step })),
  );
}

function checkouts(file: string): Array<{ job: string; step: Step }> {
  return checkoutsOf(load(file));
}

/** The write-scope rule over a parsed workflow and its permission scan. */
function writeScopeProblems(wf: Workflow, scan: PermScan): string[] {
  const problems = scan.unreadable.map((u) => `unreadable permissions declaration: ${u}`);
  for (const w of scan.writes) {
    const ids = w.job === null ? [] : stepIdentifiers(wf.jobs?.[w.job]);
    if (w.comment === "") {
      problems.push(`${where(w.job)} → ${w.scope}: write (no inline comment)`);
    } else if (ids.length === 0) {
      // A comment can only name a step the job exposes by `name:` or `uses:`. A
      // job whose steps have neither cannot satisfy the rule, so it fails closed
      // rather than letting any comment through (cli#418 review).
      problems.push(
        `${where(w.job)} → ${w.scope}: write (the job has no named or uses: step for the comment to name)`,
      );
    } else if (!ids.some((id) => w.comment.toLowerCase().includes(id.toLowerCase()))) {
      problems.push(`${where(w.job)} → ${w.scope}: write (comment names no step: "${w.comment}")`);
    }
  }
  return problems;
}

function stepLabel(step: Step): string {
  return step.name ?? step.uses ?? "<unnamed step>";
}

/**
 * Rule: the top level grants nothing. cli#415 put `permissions: {}` there.
 * Anything else — a `contents: read` at the top, or a `write` of any scope —
 * hands every job that omits its own block whatever the top level declares, one
 * edit from widening all of them at once.
 */
function topLevelProblems(wf: Workflow): string[] {
  if (wf.permissions === undefined || wf.permissions === null) {
    return ["no top-level permissions block (it must be `permissions: {}`)"];
  }
  const grants = Object.keys(wf.permissions);
  return grants.length === 0 ? [] : [`the top level grants ${grants.join(", ")}`];
}

/**
 * Rule: every job declares its own permissions map. A missing block inherits
 * the workflow default; a scalar (`write-all`) is a whole access class with no
 * step to name. Either way the job does not opt in to a scope it can be held to.
 */
function jobPermissionProblems(wf: Workflow): string[] {
  return Object.keys(wf.jobs ?? {}).filter((name) => {
    const p = wf.jobs?.[name].permissions as unknown;
    return p === undefined || p === null || typeof p !== "object" || Array.isArray(p);
  });
}

/** Rule: no checkout persists the token into `.git/config`. */
function checkoutCredentialProblems(wf: Workflow): string[] {
  return checkoutsOf(wf)
    .filter(({ step }) => step.with?.["persist-credentials"] !== false)
    .map(({ job, step }) => `${job} → ${stepLabel(step)}`);
}

describe("guarded workflows — least privilege (cli#416)", () => {
  // The four rules run on every entry in GUARDED, so putting a workflow in that
  // set actually holds it to them; the inventory test alone only records the
  // decision.
  for (const file of GUARDED) {
    const wf = load(file);

    test(`${file}: the top level grants nothing: every job opts in to its own scopes`, () => {
      const problems = topLevelProblems(wf);
      expect(problems, `top-level permissions in ${file}: ${problems.join("; ")}`).toEqual([]);
    });

    test(`${file}: every job declares its own permissions map`, () => {
      const jobNames = Object.keys(wf.jobs ?? {});
      expect(jobNames.length, `${file} has at least one job`).toBeGreaterThan(0);

      // A missing block inherits the workflow default; a scalar (`write-all`)
      // is a whole access class with no step to name. Either way the job does
      // not opt in to a scope it can be held to, so both fail here.
      const bad = jobPermissionProblems(wf);
      expect(
        bad,
        `jobs in ${file} without a permissions map of their own (they inherit the workflow default, or grant a whole access class): ${bad.join(", ")}`,
      ).toEqual([]);
    });

    test(`${file}: every write scope is readable and names the step that needs it`, () => {
      // The model is the CodeQL job's `security-events: write # CodeQL's upload
      // of SARIF results (the "Perform CodeQL Analysis" step)`. A bare `write`
      // says a scope is needed but not by what, so the next reader cannot tell
      // whether it is still needed at all; a `# TODO` says just as little.
      // real-flair.yml declares no write scope, so for it this rule passes
      // vacuously — the non-vacuous positive control is the test.yml case below.
      const { writes, unreadable } = scanFile(file);
      const problems = writeScopeProblems(wf, { writes, unreadable });
      expect(
        problems,
        `write scopes in ${file} with no comment naming the step that needs them: ${problems.join("; ")}`,
      ).toEqual([]);
    });

    test(`${file}: every checkout (any owner's checkout action) disables credential persistence`, () => {
      const found = checkouts(file);
      expect(found.length, `${file} checks out at least once`).toBeGreaterThan(0);

      const offending = checkoutCredentialProblems(wf);
      expect(
        offending,
        `checkouts in ${file} that persist the token into .git/config: ${offending.join("; ")}`,
      ).toEqual([]);
    });
  }

  test("test.yml declares at least one write scope (positive control)", () => {
    // Tied to test.yml: real-flair.yml needs no write grant, so it cannot prove
    // the write rule is non-vacuous.
    const { writes } = scanFile("test.yml");
    expect(writes.length, "test.yml declares at least one write scope").toBeGreaterThan(0);
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

  test("every recorded exclusion carries a reason, not an empty string", () => {
    // An empty reason would let a workflow be waved through by adding its name
    // to a list; the decision has to be written down (cli#418 review).
    for (const [file, why] of [...Object.entries(PR_EXCLUDED), ...Object.entries(NOT_PR)]) {
      expect(why.trim().length, `${file}: the recorded reason is a sentence`).toBeGreaterThanOrEqual(20);
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
// The rules on fixtures: each case is the shape the cli#418 review named, so a
// regression in the rule itself goes red here without editing test.yml.
describe("workflow permissions — the rules on fixtures (cli#418)", () => {
  const parse = (text: string): Workflow => yaml.load(text) as Workflow;

  test("a checkout from another owner is held to the persist-credentials rule", () => {
    const wf = parse(`
jobs:
  a:
    steps:
      - uses: someone/checkout@v4
      - uses: actions/checkout@abc
        with:
          persist-credentials: false
`);
    const offending = checkoutsOf(wf).filter(({ step }) => step.with?.["persist-credentials"] !== false);
    expect(offending.map(({ step }) => step.uses)).toEqual(["someone/checkout@v4"]);
    expect(isCheckout("actions/cache@v4")).toBe(false);
  });

  test("a write scope in a job whose steps carry no name or uses fails closed, whatever the comment", () => {
    const text = `
jobs:
  a:
    permissions:
      contents: write # release step
    steps:
      - run: echo hi
`;
    const problems = writeScopeProblems(parse(text), scanText(text));
    expect(problems.join("; ")).toContain("no named or uses: step");
  });

  test("a top-level scalar grant is attributed to the top level, not to a trigger key", () => {
    const text = `
on:
  pull_request:
    branches: [main]
permissions: write-all
jobs:
  a:
    steps:
      - run: echo hi
`;
    const { unreadable } = scanText(text);
    expect(unreadable.join("; ")).toContain("<workflow-level>");
    expect(unreadable.join("; ")).not.toContain("pull_request");
  });
});

// cli#651: the write rule reads each grant from the parsed workflow, so how the
// grant is spelled in the text does not decide whether the rule sees it. Each
// spelling below fails without a justification — the `#`-comment that names one
// of the job's steps — and passes once it carries one.
describe("workflow permissions — every spelling of a write grant (cli#651)", () => {
  const parse = (text: string): Workflow => yaml.load(text) as Workflow;
  const STEP = "Publish results";
  const c = (comment: string): string => (comment === "" ? "" : ` # ${comment}`);

  /** A whole workflow whose job `a` grants `contents: write` in one spelling. */
  const SPELLINGS: Array<{ name: string; text: (comment: string) => string }> = [
    {
      name: "plain block",
      text: (comment) => `
jobs:
  a:
    permissions:
      contents: write${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "quoted value",
      text: (comment) => `
jobs:
  a:
    permissions:
      contents: "write"${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "quoted key",
      text: (comment) => `
jobs:
  a:
    permissions:
      "contents": write${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "flow map on the permissions line",
      text: (comment) => `
jobs:
  a:
    permissions: { contents: write }${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "flow map on the line after permissions",
      text: (comment) => `
jobs:
  a:
    permissions:
      { contents: write }${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "quoted permissions key over a block",
      text: (comment) => `
jobs:
  a:
    "permissions":
      contents: write${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "anchor under another key, aliased into permissions",
      text: (comment) => `
jobs:
  a:
    env:
      MODE: &w write
    permissions:
      contents: *w${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "!!str tag on the value",
      text: (comment) => `
jobs:
  a:
    permissions:
      contents: !!str write${c(comment)}
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
    {
      name: "explicit ? key / : value pair",
      text: (comment) => `
jobs:
  a:
    permissions:
      ? contents${c(comment)}
      : write
    steps:
      - name: ${STEP}
        run: echo hi
`,
    },
  ];

  for (const spelling of SPELLINGS) {
    test(`${spelling.name}: a write grant with no justification fails`, () => {
      const text = spelling.text("");
      const problems = writeScopeProblems(parse(text), scanText(text));
      expect(
        problems.length,
        `${spelling.name} is rejected without a justification: ${problems.join("; ")}`,
      ).toBeGreaterThan(0);
    });

    test(`${spelling.name}: a write grant justified by naming the step passes`, () => {
      const text = spelling.text(STEP);
      const problems = writeScopeProblems(parse(text), scanText(text));
      expect(
        problems,
        `${spelling.name} is accepted when the comment names the step: ${problems.join("; ")}`,
      ).toEqual([]);
    });
  }
});

// The blind review found the permission rules hard-coded to test.yml while
// `GUARDED` claimed real-flair.yml was guarded. Each mutation the reviewer used
// is applied here to EVERY entry in GUARDED, so each rule is proven to bite on
// the workflow that names it, not on test.yml alone.
describe("workflow permissions — every mutation fails for every guarded workflow (cli#646)", () => {
  const parse = (text: string): Workflow => yaml.load(text) as Workflow;

  interface Mutation {
    /** Human name for the failure message. */
    name: string;
    /** The mutated workflow text. */
    text: (file: string) => string;
    /** The rule the mutation must trip. */
    problems: (wf: Workflow, text: string) => string[];
  }

  /** The line index of the first job-level `permissions:` key. */
  const firstJobPermissionsLine = (lines: string[]): number =>
    lines.findIndex((line) => /^\s+permissions:\s*(#.*)?$/.test(line));

  /**
   * The index just past the block map opened at `at`: its own line and every
   * following line that is blank or more deeply indented. The mutations below
   * edit only by indentation, so a line added inside a permissions block does
   * not stop them from applying.
   */
  const blockEnd = (lines: string[], at: number): number => {
    const indent = lines[at].length - lines[at].trimStart().length;
    let end = at + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
      end++;
    }
    return end;
  };

  const MUTATIONS: Mutation[] = [
    {
      name: "broader top-level grant",
      text: (file) => raw(file).replace(/^permissions: \{\}$/m, "permissions:\n  contents: read"),
      problems: (wf) => topLevelProblems(wf),
    },
    {
      name: "missing job permissions block",
      text: (file) => {
        const lines = raw(file).split("\n");
        const at = firstJobPermissionsLine(lines);
        if (at === -1) return raw(file);
        lines.splice(at, blockEnd(lines, at) - at);
        return lines.join("\n");
      },
      problems: (wf) => jobPermissionProblems(wf),
    },
    {
      name: "write grant with no named step",
      text: (file) => {
        const lines = raw(file).split("\n");
        const at = firstJobPermissionsLine(lines);
        if (at === -1) return raw(file);
        const indent = lines[at].length - lines[at].trimStart().length;
        lines.splice(at + 1, 0, `${" ".repeat(indent + 2)}security-events: write # TODO`);
        return lines.join("\n");
      },
      problems: (wf, text) => writeScopeProblems(wf, scanText(text)),
    },
    {
      name: "persisted checkout credential",
      text: (file) => raw(file).replace(/\n[ \t]*persist-credentials: false[^\n]*/, ""),
      problems: (wf) => checkoutCredentialProblems(wf),
    },
  ];

  for (const file of GUARDED) {
    for (const mutation of MUTATIONS) {
      test(`${file}: a ${mutation.name} trips the rule`, () => {
        const text = mutation.text(file);
        expect(text, `the ${mutation.name} mutation edited ${file}`).not.toBe(raw(file));
        const problems = mutation.problems(parse(text), text);
        expect(
          problems.length,
          `the ${mutation.name} mutation in ${file} is rejected: ${problems.join("; ")}`,
        ).toBeGreaterThan(0);
      });
    }
  }
});
