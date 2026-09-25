/**
 * release-workflow-permissions.test.ts — the release workflow's least privilege.
 *
 * Slice S1b of the release auto-tag design (tpsdev-ai/flair#1890). release.yml
 * granted `contents: write` AND `id-token: write` to EVERY job from the top
 * level, so any job in the release could write to the repository and — the part
 * that matters — mint an OIDC token for the npm trusted publisher. Reading the
 * steps, only two jobs need anything beyond a read: the publishing job swaps an
 * OIDC token for a short-lived npm credential, and the release job creates the
 * GitHub release. Everything else is a checkout, a build and a smoke test.
 *
 * So the shape is `permissions: {}` at the top and an explicit block per job.
 * The assertions below read the workflow file itself. This is a detective, not a
 * boundary — a pull request can edit the workflow and this test together, and
 * the boundary is review of the diff. What it holds is that the widening cannot
 * return silently: a job added later gets no permissions without a line here, a
 * grant that appears on a second job fails, and each write has to sit on the job
 * whose steps actually use it.
 *
 * The two grants that buy something, and the step that needs each:
 *   - `id-token: write` — "Stage-publish all packages (OIDC trusted publishing)"
 *     runs `npm stage publish`, which exchanges the OIDC token for an npm publish
 *     credential. No other step in the release asks for an OIDC token.
 *   - `contents: write` — "Publish checksums to GitHub release" runs
 *     softprops/action-gh-release, which creates the release and attaches the
 *     binaries and their checksums.
 * Artifact upload/download need no grant of their own: they transfer within this
 * workflow run, which the artifact client scopes to that run without a
 * GITHUB_TOKEN scope (`actions: read`/`write` are needed only for artifacts from
 * OTHER runs or repositories).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}

interface Job {
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..", "..");
const WORKFLOW_PATH = join(REPO, ".github", "workflows", "release.yml");
const wf = yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as unknown as Workflow;

/** The call that consumes an id-token grant. */
const OIDC_CONSUMER = "npm stage publish";
/** The action that consumes a repository-write grant. */
const RELEASE_CREATOR = "softprops/action-gh-release@";

function job(name: string): Job {
  const found = wf.jobs?.[name];
  expect(found, `job ${name} exists`).toBeDefined();
  return found as Job;
}

function allSteps(): Array<{ job: string; step: Step }> {
  return Object.entries(wf.jobs ?? {}).flatMap(([name, j]) =>
    (j.steps ?? []).map((s) => ({ job: name, step: s })),
  );
}

function stepsUsing(predicate: (s: Step) => boolean): Array<{ job: string; step: Step }> {
  return allSteps().filter(({ step }) => predicate(step));
}

describe("release workflow — least privilege", () => {
  test("the top level grants nothing: every job opts in to its own grants", () => {
    // Before S1b this was `contents: write` + `id-token: write`, so every job in
    // the release held an OIDC-capable, repository-writing token.
    expect(wf.permissions).toEqual({});
    for (const [name, j] of Object.entries(wf.jobs ?? {})) {
      expect(j.permissions, `job ${name} declares its own permissions`).toBeDefined();
    }
  });

  test("the job set is exactly these five (a new job must be given its grants deliberately)", () => {
    // Positive control AND a tripwire: a job added without a decision about its
    // grants cannot pass this file unnoticed.
    expect(Object.keys(wf.jobs ?? {}).sort()).toEqual([
      "build-binaries",
      "github-release",
      "preflight",
      "publish-packages",
      "smoke-compiled-binary",
    ]);
  });

  test("the exact per-job grants — read everywhere, except the two jobs with a reason", () => {
    expect(job("preflight").permissions).toEqual({ contents: "read" });
    expect(job("build-binaries").permissions).toEqual({ contents: "read" });
    expect(job("smoke-compiled-binary").permissions).toEqual({ contents: "read" });
    expect(job("publish-packages").permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job("github-release").permissions).toEqual({ contents: "write" });
  });

  test("id-token: write belongs to the publishing job alone, and a step there uses it", () => {
    const holders = Object.entries(wf.jobs ?? {})
      .filter(([, j]) => j.permissions?.["id-token"] !== undefined)
      .map(([name]) => name);
    expect(holders).toEqual(["publish-packages"]);
    expect(job("publish-packages").permissions?.["id-token"]).toBe("write");
    // The grant is not decorative: the job runs the OIDC consumer, and no other
    // job does. An OIDC token minted anywhere else is a capability with no user.
    const consumers = stepsUsing((s) => (s.run ?? "").includes(OIDC_CONSUMER)).map(({ job: name }) => name);
    expect(consumers, `${OIDC_CONSUMER} lives in the OIDC-granted job`).toEqual(["publish-packages"]);
  });

  test("contents: write belongs to the job that creates the release — and it checks out nothing", () => {
    const writers = Object.entries(wf.jobs ?? {})
      .filter(([, j]) => j.permissions?.contents === "write")
      .map(([name]) => name);
    expect(writers).toEqual(["github-release"]);
    // Justified by the step that needs it …
    const creators = stepsUsing((s) => typeof s.uses === "string" && s.uses.startsWith(RELEASE_CREATOR)).map(
      ({ job: name }) => name,
    );
    expect(creators).toEqual(["github-release"]);
    // … wired to the token the grant applies to …
    const creator = (job("github-release").steps ?? []).find((s) => s.uses?.startsWith(RELEASE_CREATOR));
    expect(String(creator?.env?.GITHUB_TOKEN)).toBe("${{ secrets.GITHUB_TOKEN }}");
    // … and handed no checkout: a write token never persisted into a working
    // tree cannot be used to push from some later build step.
    const releaseJobChecksOut = (job("github-release").steps ?? []).some((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(releaseJobChecksOut).toBe(false);
  });

  test("the jobs that DO check out hold read, never write", () => {
    const checkouts = stepsUsing((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@")).map(
      ({ job: name }) => name,
    );
    expect(checkouts.length).toBeGreaterThan(0); // positive control: the search found checkouts
    expect([...new Set(checkouts)].sort()).toEqual([
      "build-binaries",
      "preflight",
      "publish-packages",
      "smoke-compiled-binary",
    ]);
    for (const name of checkouts) expect(job(name).permissions?.contents, `${name}'s checkout`).toBe("read");
  });

  test("no job holds a write of any scope without the step that needs it", () => {
    const writes = Object.entries(wf.jobs ?? {}).flatMap(([name, j]) =>
      Object.entries(j.permissions ?? {})
        .filter(([, grant]) => grant === "write")
        .map(([scope]) => ({ job: name, scope })),
    );
    expect(writes.sort((a, b) => `${a.job}:${a.scope}`.localeCompare(`${b.job}:${b.scope}`))).toEqual([
      { job: "github-release", scope: "contents" },
      { job: "publish-packages", scope: "id-token" },
    ]);
  });
});
