import { load } from "js-yaml";

type WorkflowStep = { name?: string; run?: string; uses?: string; "working-directory"?: string };
type WorkflowJob = {
  steps: WorkflowStep[];
  defaults?: { run?: { "working-directory"?: string } };
};

export function parseWorkflow(source: string) {
  return load(source) as { jobs: Record<string, WorkflowJob>; defaults?: WorkflowJob["defaults"] };
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
 * The helper requires sfw and a tracked lock, then compares the installed copy.
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
  if (lines.some((line) => /(?:\b(?:cp|mv|ln|install|tee)\b.*|>{1,2}.*)(?:package-lock|npm-shrinkwrap)\.json/.test(line))) {
    refuse("lockfile write in the install step");
  }
  const dirs: string[] = [];
  let changedDirectory = false;
  let uninspectedCommand = false;
  for (const line of lines) {
    if (!isInstall(line)) {
      if (line === "set -euo pipefail") continue;
      // The helper's workflow prelude has no directory changes. The pin command
      // is a literal invocation; other command substitutions are refused.
      if (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[A-Za-z0-9_./${}-]*"|'[A-Za-z0-9_./-]*'|[A-Za-z0-9_./-]+)$/.test(line) ||
          line === 'pin="$(node scripts/heartbeat-real-openclaw-lane.mjs --pin)"') {
        uninspectedCommand = true;
        continue;
      }
      if (/^(?:npm|bun) run [A-Za-z0-9_:. -]+$/.test(line) || /^test -f [A-Za-z0-9_./-]+$/.test(line)) {
        uninspectedCommand = true;
        continue;
      }
      if (line === 'echo "OPENCLAW_BIN_DIR=$prefix/node_modules/.bin" >> "$GITHUB_ENV"') continue;
      refuse("unsupported command in the install step");
    }
    if (changedDirectory) refuse("a prior install changed directory");
    if (line.includes("npm-ci-tracked-lock.sh")) {
      const helper = line.match(/^bash (?:\.\/)?scripts\/npm-ci-tracked-lock\.sh ([A-Za-z0-9_./-]+) (?:"[A-Za-z0-9_./${}-]+"|'[A-Za-z0-9_./-]+'|[A-Za-z0-9_./$\{\}-]+)(?: [A-Za-z0-9_./=-]+)*$/);
      if (helper === null || helper[1].startsWith("/") || helper[1] === "-" ||
          resolveRepoDir(workdir, "scripts/npm-ci-tracked-lock.sh", label) !== "scripts/npm-ci-tracked-lock.sh") {
        refuse("helper requires a literal relative fixture directory and repository-root invocation");
      }
      dirs.push(resolveRepoDir(workdir, helper[1], label));
      continue;
    }
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
