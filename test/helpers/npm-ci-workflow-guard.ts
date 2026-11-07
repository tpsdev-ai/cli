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

/**
 * Inspect npm ci written directly in workflow run text, plus the tracked-lock
 * helper. Script files and composite actions are not inspected. Accept raw npm
 * ci without --prefix, using the step/default directory and at most one leading
 * literal cd, or the helper with a literal relative fixture. Refuse other shapes.
 * Helper steps allow set -euo pipefail, allowlisted quoted assignments with lowercase names, a literal node
 * scripts/<file>.mjs substitution, helper calls and GITHUB_ENV echoes only.
 * The helper requires sfw and committed manifest/lock bytes, then compares the installed lock.
 */
export function npmCiLockDirs(run: string, workdir: string, label: string): string[] {
  const lines = run.split("\n").map((line) => line.replace(/("[^"]*"|'[^']*')|\s+#.*$/g, (_whole, quoted: string | undefined) => quoted ?? "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const isInstall = (line: string) => /\bnpm\b.*\bci\b|npm-ci-tracked-lock\.sh/.test(line);
  const refuse = (reason: string): never => {
    throw new Error(`${label}: cannot establish the npm ci directory: ${reason}`);
  };
  if (!lines.some(isInstall)) {
    if (/\bnpm\b.*\bci\b/.test(run.replace(/\\\n\s*/g, " "))) refuse("unsupported multiline npm ci shape");
    return [];
  }
  if (!/^(?!\/)[A-Za-z0-9_./-]*$/.test(workdir)) refuse("non-literal working-directory");
  if (lines.some((line) => line.includes("npm-ci-tracked-lock.sh"))) {
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
        if (!quotedValue(value) && !/^"\$\(node scripts\/[A-Za-z0-9_-]+\.mjs(?: [A-Za-z0-9_./=-]+)*\)"$/.test(value)) {
          refuse(`unsupported helper-step line: ${line}`);
        }
        assigned.add(name);
        continue;
      }
      const helper = line.match(/^bash (?:\.\/)?scripts\/npm-ci-tracked-lock\.sh ([A-Za-z0-9_./-]+) ("[^"\r\n]*"|'[^'\r\n]*')(?: ((?:--ignore-scripts|--no-audit|--no-fund)(?: (?:--ignore-scripts|--no-audit|--no-fund))*))?$/);
      if (helper !== null && !helper[1].startsWith("/") && helper[1] !== "-" && quotedValue(helper[2]) &&
          resolveRepoDir(workdir, "scripts/npm-ci-tracked-lock.sh", label) === "scripts/npm-ci-tracked-lock.sh") {
        dirs.push(resolveRepoDir(workdir, helper[1], label));
        continue;
      }
      const echo = line.match(/^echo ("[A-Z_][A-Z0-9_]*=[^"\r\n]*") >> "\$GITHUB_ENV"$/);
      if (echo !== null && quotedValue(echo[1].replace(/^"[A-Z_][A-Z0-9_]*=/, '"'))) continue;
      refuse(`unsupported helper-step line (helper requires a literal relative fixture directory and repository-root invocation): ${line}`);
    }
    return dirs;
  }
  if (lines.some((line) => /(?:\b(?:cp|mv|ln|install|tee)\b.*|>{1,2}.*)(?:package-lock|npm-shrinkwrap)\.json/.test(line))) {
    refuse("lockfile write in the install step");
  }
  const dirs: string[] = [];
  let changedDirectory = false;
  let uninspectedCommand = false;
  for (const line of lines) {
    if (!isInstall(line)) {
      if (line === "set -euo pipefail") continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[A-Za-z0-9_./${}-]*"|'[A-Za-z0-9_./-]*'|[A-Za-z0-9_./-]+)$/.test(line) ||
          line === 'pin="$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)"') {
        uninspectedCommand = true;
        continue;
      }
      if (/^(?:npm|bun) run [A-Za-z0-9_:. -]+$/.test(line) || /^test -f [A-Za-z0-9_./-]+$/.test(line)) {
        uninspectedCommand = true;
        continue;
      }
      refuse("unsupported command in the install step");
    }
    if (changedDirectory) refuse("a prior install changed directory");
    if (uninspectedCommand) refuse("uninspected command before raw npm ci");
    const match = line.match(/^(?:cd\s+([A-Za-z0-9_./-]+)\s+&&\s+)?(?:sfw\s+)?npm\s+ci(?:\s+([^;&|`\\(){}<>]*))?$/);
    if (match === null || match[1]?.startsWith("/") || match[1] === "-") refuse("unsupported raw npm ci shape");
    if (/(?:^|\s)["']?--prefix(?:[=\s"']|$)/.test(match[2] ?? "")) refuse("raw npm ci --prefix is refused; use the tracked-lock helper");
    if (/[$]/.test(match[2] ?? "")) refuse("non-literal npm ci arguments");
    if ((match[2] ?? "").split(/\s+/).filter(Boolean).some((arg) => !["--ignore-scripts", "--no-audit", "--no-fund"].includes(arg))) {
      refuse("unsupported raw npm ci argument");
    }
    changedDirectory = match[1] !== undefined;
    try {
      dirs.push(resolveRepoDir(workdir, match[1] ?? ".", label));
    } catch {
      refuse("directory leaves the repository root");
    }
  }
  return dirs;
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
