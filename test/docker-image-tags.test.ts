/**
 * cli#420 slice 1 — the Docker Image workflow's checks before any build. The
 * required version shape, whether npm has published that version of
 * @tpsdev-ai/agent, and the image tags to push are decided by
 * `.github/scripts/docker-image-tags.sh`. These tests RUN that script with a
 * stub `npm` first on PATH (no network, no real npm): the stub records each
 * call and answers from the case's STUB_* variables. The last group checks that
 * `docker.yml` runs the script before any build and pushes only its tags.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, ".github", "scripts", "docker-image-tags.sh");
const WORKFLOW = join(REPO, ".github", "workflows", "docker.yml");
const PKG = "@tpsdev-ai/agent";
const IMAGE = "ghcr.io/tpsdev-ai/tps-office";

const STUB_NPM = `#!/usr/bin/env bash
# stub npm: record the call, then answer one of the two lookups
# docker-image-tags.sh makes from STUB_<VERSION|LATEST>_<OUT|ERR|RC>.
{ printf '%q ' "$@"; echo; } >>"$STUB_NPM_LOG"
if [ "$#" -eq 3 ] && [ "$1" = view ] && [ "$3" = version ] && [ "\${2#${PKG}@}" != "$2" ]; then
  which=VERSION
elif [ "$#" -eq 3 ] && [ "$1" = view ] && [ "$2" = "${PKG}" ] && [ "$3" = dist-tags.latest ]; then
  which=LATEST
else
  echo "stub npm: unexpected call: $*" >&2
  exit 97
fi
out="STUB_\${which}_OUT"; err="STUB_\${which}_ERR"; rc="STUB_\${which}_RC"
printf '%s' "\${!out-}"
printf '%s' "\${!err-}" >&2
exit "\${!rc:-0}"
`;

const work = mkdtempSync(join(tmpdir(), "docker-image-tags-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const stubBin = join(work, "bin");
mkdirSync(stubBin);
writeFileSync(join(stubBin, "npm"), STUB_NPM, { mode: 0o755 });

/** What the stub npm prints and exits with for one lookup. */
interface Answer {
  out?: string;
  err?: string;
  rc?: number;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The step outputs the script appended to $GITHUB_OUTPUT. */
  outputs: Record<string, string>;
  /** Each npm call, its arguments joined by spaces. */
  npmCalls: string[];
  /** Files the script left in its TMPDIR. */
  leftovers: string[];
}

/** Read a $GITHUB_OUTPUT file: `name=value` lines and `name<<DELIM` blocks. */
function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const block = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(lines[i]);
    if (block) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== block[2]; i++) body.push(lines[i]);
      if (i >= lines.length) throw new Error(`unterminated output block ${block[1]}`);
      out[block[1]] = body.join("\n");
      continue;
    }
    const eq = lines[i].indexOf("=");
    if (eq <= 0) throw new Error(`unreadable output line: ${JSON.stringify(lines[i])}`);
    out[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
  }
  return out;
}

let caseNo = 0;
function run(version: string, answers: { version?: Answer; latest?: Answer } = {}): Run {
  const dir = join(work, `case-${++caseNo}`);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const outFile = join(dir, "github-output");
  const log = join(dir, "npm-calls");
  writeFileSync(outFile, "");
  writeFileSync(log, "");
  const env: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    TMPDIR: tmp,
    INPUT_VERSION: version,
    GITHUB_OUTPUT: outFile,
    STUB_NPM_LOG: log,
  };
  for (const [which, a] of [
    ["VERSION", answers.version],
    ["LATEST", answers.latest],
  ] as const) {
    if (!a) continue;
    env[`STUB_${which}_OUT`] = a.out ?? "";
    env[`STUB_${which}_ERR`] = a.err ?? "";
    env[`STUB_${which}_RC`] = String(a.rc ?? 0);
  }
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 30_000 });
  if (r.error) throw r.error;
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    outputs: parseOutputs(readFileSync(outFile, "utf8")),
    npmCalls: readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.trimEnd()),
    leftovers: readdirSync(tmp),
  };
}

const published = (v: string): Answer => ({ out: `${v}\n` });
const latestIs = (v: string): Answer => ({ out: `${v}\n` });
/** npm 11's answer for a version the registry does not have (recorded 2026-10-01). */
const e404 = (v: string): Answer => ({
  rc: 1,
  err: [
    "npm error code E404",
    `npm error 404 No match found for version ${v}`,
    "npm error 404",
    `npm error 404  The requested resource '${PKG}@${v}' could not be found or you do not have permission to access it.`,
    "",
  ].join("\n"),
});
const e503: Answer = {
  rc: 1,
  err: "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/@tpsdev-ai%2fagent\n",
};
const tagsOf = (r: Run) => (r.outputs.tags ?? "").split("\n");
const what = (v: string, r: Run) => `${JSON.stringify(v)} → exit ${r.status}\n${r.stdout}${r.stderr}`;

describe("docker-image-tags.sh — the required version shape (cli#420)", () => {
  const GOOD = ["0.7.0", "10.20.30", "0.7.0-rc.1", "0.7.0-beta"];
  const BAD = [
    "1.2.3\nINVALID",
    "1.2.3\n",
    "\n1.2.3",
    "1.2",
    "1.2.3; x",
    "v0.7.0",
    "0.7.0.1",
    "0.7.0-",
    " 0.7.0",
    "0.7.0-garbage!",
    "",
  ];

  test("MAJOR.MINOR.PATCH with an optional -prerelease is accepted", () => {
    for (const v of GOOD) {
      const r = run(v, { version: published(v), latest: latestIs(v) });
      expect(r.status, what(v, r)).toBe(0);
      expect(r.outputs.tps_version, what(v, r)).toBe(v);
    }
  });

  test("any other input is refused before npm is called, including a newline anywhere in it", () => {
    for (const v of BAD) {
      // The stub answers as if the input were published and npm's latest, so
      // only the shape check can refuse it.
      const r = run(v, { version: published(v), latest: latestIs(v) });
      expect(r.status, what(v, r)).toBe(1);
      expect(r.stdout, what(v, r)).toContain("::error::invalid version ");
      expect(r.npmCalls, what(v, r)).toEqual([]);
      expect(r.outputs, what(v, r)).toEqual({});
    }
  });

  test("the refusal prints the input on one line", () => {
    const r = run("1.2.3\nINVALID");
    expect(r.stdout).toBe(
      "::error::invalid version $'1.2.3\\nINVALID': expected MAJOR.MINOR.PATCH with an optional -prerelease\n",
    );
  });
});

describe("docker-image-tags.sh — the npm checks and the tags (cli#420)", () => {
  test("published and npm's latest: the version tag and :latest", () => {
    const r = run("0.7.0", { version: published("0.7.0"), latest: latestIs("0.7.0") });
    expect(r.status, what("0.7.0", r)).toBe(0);
    expect(tagsOf(r)).toEqual([`${IMAGE}:0.7.0`, `${IMAGE}:latest`]);
    expect(r.outputs.tps_version).toBe("0.7.0");
    expect(r.stdout).toContain(`npm's latest for ${PKG} is 0.7.0: :0.7.0 and :latest selected for push`);
    expect(r.npmCalls).toEqual([`view ${PKG}@0.7.0 version`, `view ${PKG} dist-tags.latest`]);
    expect(r.leftovers, "the temp file is removed").toEqual([]);
  });

  test("published but not npm's latest: the version tag only", () => {
    for (const [v, latest] of [
      ["0.6.0", "0.7.0"],
      ["0.8.0-rc.1", "0.7.0"],
    ]) {
      const r = run(v, { version: published(v), latest: latestIs(latest) });
      expect(r.status, what(v, r)).toBe(0);
      expect(tagsOf(r), what(v, r)).toEqual([`${IMAGE}:${v}`]);
      expect(r.stdout).toContain(`npm's latest for ${PKG} is ${latest}, not ${v}: :${v} selected for push`);
    }
  });

  test("E404 for the version: refused with the staged-release remedy, and no outputs", () => {
    // npm 11 prefixes its error lines "npm error"; older npm used "npm ERR!".
    const npmError = e404("0.7.0");
    const npmErr: Answer = { rc: 1, err: "npm ERR! code E404\nnpm ERR! 404 No match found for version 0.7.0\n" };
    for (const answer of [npmError, npmErr]) {
      const r = run("0.7.0", { version: answer, latest: latestIs("0.7.0") });
      expect(r.status, what("0.7.0", r)).toBe(1);
      expect(r.stdout).toContain(
        `::error::${PKG}@0.7.0 is not public on npm (E404): approve the staged release, then re-run this workflow with version=0.7.0`,
      );
      expect(r.stdout).not.toContain("could not verify");
      expect(r.outputs).toEqual({});
      expect(r.npmCalls).toEqual([`view ${PKG}@0.7.0 version`]);
      expect(r.leftovers, "the temp file is removed").toEqual([]);
    }
  });

  test("any other lookup failure is 'could not verify', not 'not public', and gives no outputs", () => {
    const cases: [string, Answer, string][] = [
      ["registry 5xx", e503, "npm error code E503"],
      [
        "network error",
        { rc: 1, err: "npm error code ECONNRESET\nnpm error network aborted\n" },
        "npm error code ECONNRESET",
      ],
      [
        "E404 for the package, not for this version",
        { rc: 1, err: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@tpsdev-ai%2fagent - Not found\n" },
        "npm error code E404",
      ],
      ["E404 naming another version", e404("0.7.0-rc.1"), "npm error code E404"],
      ["a failure with no error output", { rc: 1 }, "npm exited 1 with no error output"],
      ["exit 0 with nothing printed", { out: "" }, "npm exited 0 and printed ''"],
      ["exit 0 with another version printed", { out: "0.7.1\n" }, "npm exited 0 and printed 0.7.1"],
    ];
    for (const [label, answer, line] of cases) {
      const r = run("0.7.0", { version: answer, latest: latestIs("0.7.0") });
      expect(r.status, `${label}: ${what("0.7.0", r)}`).toBe(1);
      expect(r.stdout, label).toContain(`::error::could not verify ${PKG}@0.7.0 on npm: ${line}; re-run the workflow`);
      expect(r.stdout, label).not.toContain("approve the staged release");
      expect(r.outputs, label).toEqual({});
      expect(r.npmCalls, label).toEqual([`view ${PKG}@0.7.0 version`]);
    }
  });

  test("the latest lookup fails: refused with 'could not verify', and no tags are output", () => {
    const r = run("0.7.0", { version: published("0.7.0"), latest: e503 });
    expect(r.status, what("0.7.0", r)).toBe(1);
    expect(r.stdout).toContain(
      `::error::could not verify npm's latest for ${PKG}: npm error code E503; re-run the workflow`,
    );
    expect(r.stdout).not.toContain("selected for push");
    expect(r.outputs).toEqual({});
    expect(r.npmCalls).toEqual([`view ${PKG}@0.7.0 version`, `view ${PKG} dist-tags.latest`]);
  });
});

describe("docker.yml runs docker-image-tags.sh before any build and pushes only its tags (cli#420)", () => {
  interface Step {
    name?: string;
    id?: string;
    uses?: string;
    run?: string;
    if?: unknown;
    "continue-on-error"?: unknown;
    env?: Record<string, unknown>;
    with?: Record<string, unknown>;
  }
  const yml = readFileSync(WORKFLOW, "utf8");
  const wf = yaml.load(yml) as Record<string, unknown> & {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = wf.jobs["build-and-push"].steps;
  const scriptSteps = steps.filter((s) => s.run?.includes(".github/scripts/docker-image-tags.sh"));

  test("workflow_dispatch is the only trigger, with a required version input", () => {
    // js-yaml keeps `on` as a string key; fall back in case a schema reads it as `true`.
    const on = wf.on ?? wf["true"];
    const triggers =
      typeof on === "string"
        ? [on]
        : Array.isArray(on)
          ? on.map(String)
          : Object.keys((on ?? {}) as Record<string, unknown>);
    expect(triggers).toEqual(["workflow_dispatch"]);
    const dispatch = (on as { workflow_dispatch: { inputs: { version: { required: unknown } } } }).workflow_dispatch;
    expect(dispatch.inputs.version.required).toBe(true);
  });

  test("the script step runs on the dispatch input, unconditionally, before every docker step", () => {
    expect(scriptSteps.length, "exactly one step runs the script").toBe(1);
    const step = scriptSteps[0];
    expect(step.run?.trim()).toBe("bash .github/scripts/docker-image-tags.sh");
    expect(step.id).toBe("image");
    expect(step.env?.INPUT_VERSION).toBe("${{ inputs.version }}");
    expect(step.if, "no if: on the script step").toBeUndefined();
    expect(step["continue-on-error"], "no continue-on-error on the script step").toBeUndefined();
    const firstDocker = steps.findIndex((s) => s.uses?.startsWith("docker/"));
    expect(firstDocker, "the workflow has docker steps").toBeGreaterThan(-1);
    expect(steps.indexOf(step)).toBeLessThan(firstDocker);
  });

  test("every build takes the checked version, and the one push takes only the computed tags", () => {
    const builds = steps.filter((s) => s.uses?.includes("docker/build-push-action"));
    expect(builds.length).toBe(2);
    for (const b of builds) {
      expect(String(b.with?.["build-args"]).trim()).toBe("TPS_VERSION=${{ steps.image.outputs.tps_version }}");
    }
    const pushes = steps.filter((s) => s.with?.push === true);
    expect(pushes.length, "one step pushes").toBe(1);
    expect(pushes[0].with?.tags).toBe("${{ steps.image.outputs.tags }}");
  });

  test("values reach run: through env, and the dispatch input is read in one place", () => {
    for (const s of steps) {
      if (s.run) expect(s.run, `step ${s.name ?? s.id}`).not.toContain("${{");
    }
    expect(yml.split("inputs.version").length - 1, "inputs.version appears once").toBe(1);
  });
});
