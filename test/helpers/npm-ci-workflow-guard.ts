import { load } from "js-yaml";

type WorkflowStep = { name?: string; run?: string; uses?: string; "working-directory"?: string };
type WorkflowJob = {
  steps: WorkflowStep[];
  defaults?: { run?: { "working-directory"?: string } };
};

export function parseWorkflow(source: string) {
  return load(source) as { jobs: Record<string, WorkflowJob>; defaults?: WorkflowJob["defaults"] };
}

export function scanQuotedValue(value: string): string[] | null {
  if (/^'[^'\r\n]*'$/.test(value)) return [];
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return null;
  const names: string[] = [];
  const end = value.length - 1;
  for (let index = 1; index < end;) {
    const char = value[index++];
    if (/[A-Za-z0-9_./ :+-]/.test(char)) continue;
    if (char !== "$") return null;
    const braced = value[index] === "{";
    if (braced) index++;
    const start = index;
    if (index >= end || !/[A-Za-z_]/.test(value[index])) return null;
    index++;
    while (index < end && /[A-Za-z0-9_]/.test(value[index])) index++;
    names.push(value.slice(start, index));
    if (braced && value[index++] !== "}") return null;
  }
  return names;
}

function resolveRepoDir(base: string, target: string, label: string): string {
  const parts = base.split("/").filter((segment) => segment !== "" && segment !== ".");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) throw new Error(`${label}: ${target} leaves the repository root`);
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

/** Inspect literal npm ci command words and helper calls in workflow run text.
 * Escaped or quoted spellings are not classified (#836); scripts and composite actions are outside this guard. */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const lines = run.split("\n").map((line) => line.replace(/("[^"]*"|'[^']*')|\s+#.*$/g, (_whole, quoted: string | undefined) => quoted ?? "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const isInstall = (line: string) => /\bnpm\b.*\bci\b|npm-ci-tracked-lock\.sh/.test(line);
  const refuse = (reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}`);
  };
  if (!lines.some(isInstall)) {
    if (/\bnpm\b(?!-).*\bci\b/.test(run.replace(/\\\n\s*/g, " "))) refuse("unsupported multiline npm ci shape");
    return [];
  }
  const raw = lines.find((line) => /\bnpm\b(?!-).*\bci\b/.test(line));
  if (raw !== undefined) refuse(`raw npm ci is refused; use the tracked-lock helper: ${raw}`);
  if (!/^(?!\/)[A-Za-z0-9_./-]*$/.test(workdir)) refuse("non-literal working-directory");
  if (lines.some((line) => line.includes("npm-ci-tracked-lock.sh"))) {
    const allowedSubstitutions = new Set(['"$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)"']);
    const assigned = new Set<string>(["RUNNER_TEMP"]);
    const quotedValue = (value: string): boolean => {
      const names = scanQuotedValue(value);
      return names !== null && names.every((name) => assigned.has(name));
    };
    const dirs: string[] = [];
    for (const line of lines) {
      if (line === "set -euo pipefail") continue;
      const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (assignment !== null) {
        const [, name, value] = assignment;
        if (!/^[a-z][a-z0-9_]*$/.test(name) || /^(?:PATH|NODE_.*|NPM_.*|GIT_.*|BASH.*|ENV|SHELLOPTS|SHELL|CDPATH|IFS|HOME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_.*|XDG_.*|SFW_.*|SOCKET_.*|LD_.*|DYLD_.*|SSL_.*|OPENSSL_.*|.*_PROXY|COREPACK_.*|GITHUB_.*|RUNNER_.*)$/i.test(name)) {
          refuse(`tool environment assignment is refused: ${line}`);
        }
        if (!quotedValue(value) && !allowedSubstitutions.has(value)) {
          refuse(`unsupported helper-step line: ${line}`);
        }
        assigned.add(name);
        continue;
      }
      const helper = line.match(/^bash (?:\.\/)?scripts\/npm-ci-tracked-lock\.sh --via (npm|sfw) (?:(--in-place) )?([A-Za-z0-9_./-]+)(?: ("[^"\r\n]*"|'[^'\r\n]*'))?(?: ((?:--ignore-scripts|--no-audit|--no-fund)(?: (?:--ignore-scripts|--no-audit|--no-fund))*))?$/);
      if (helper !== null && !helper[3].startsWith("/") && helper[3] !== "-" &&
          (helper[2] === "--in-place" ? helper[4] === undefined : helper[4] !== undefined && quotedValue(helper[4])) &&
          resolveRepoDir(workdir, "scripts/npm-ci-tracked-lock.sh", label) === "scripts/npm-ci-tracked-lock.sh") {
        dirs.push(resolveRepoDir(workdir, helper[3], label));
        continue;
      }
      const echo = line.match(/^echo ("[A-Z_][A-Z0-9_]*=[^"\r\n]*") >> "\$GITHUB_ENV"$/);
      if (echo !== null && quotedValue(echo[1].replace(/^"[A-Z_][A-Z0-9_]*=/, '"'))) continue;
      refuse(`unsupported helper-step line (helper requires a literal relative fixture directory and repository-root invocation): ${line}`);
    }
    return dirs;
  }
  refuse(`raw npm ci is refused; use the tracked-lock helper: ${lines.find(isInstall)}`);
}

export function assertNpmCiLockfilesRead(source: string, tracked: Set<string>): number {
  const workflow = parseWorkflow(source);
  let installs = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const defaultWorkdir = job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"] ?? "";
    for (const [index, step] of job.steps.entries()) {
      if (step.run === undefined) continue;
      const label = `job ${jobName} step ${index + 1}${step.name ? ` (${step.name})` : ""}`;
      for (const dir of npmCiLockDirs(step.run, step["working-directory"] ?? defaultWorkdir, label)) {
        installs++;
        const lockfile = dir === "" ? "package-lock.json" : `${dir}/package-lock.json`;
        if (!tracked.has(lockfile)) throw new Error(`${label}: ${lockfile} is not a tracked lockfile the gate reads`);
      }
    }
  }
  return installs;
}
