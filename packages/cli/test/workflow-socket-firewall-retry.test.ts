/**
 * workflow-socket-firewall-retry.test.ts — every socketdev/action use
 * pre-fetches its binary through the retrying, checksum-verifying script
 * (cli#898).
 *
 * The pinned action (v1.3.2) makes one un-retried download of the Socket
 * Firewall binary and verifies no checksum of its own, so a transient 504 from
 * the release host failed every job before its own steps. Each job now runs
 * scripts/prefetch-socket-firewall.sh immediately before the action: it
 * downloads the exact version the action is told to use with a bounded curl
 * retry, checks the pinned sha256, and only then writes the tool-cache entry the
 * action reuses. The action still runs, so the firewall is installed; a failed
 * download or a checksum mismatch fails the job.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO = join(import.meta.dir, "..", "..", "..");
const WORKFLOW_DIR = join(REPO, ".github", "workflows");
const PREFETCH = "bash scripts/prefetch-socket-firewall.sh";
const ACTION = "socketdev/action";
const ACTION_SHA = "ba6de6cc0565af1f42295590380973573297e31f";
const FIREWALL_VERSION = "1.15.4";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

function loadWorkflow(file: string): Workflow {
  return yaml.load(readFileSync(join(WORKFLOW_DIR, file), "utf8")) as Workflow;
}

describe("every Socket Firewall action step", () => {
  test("is preceded by the retrying pre-fetch and pins the version it installs", () => {
    const violations: string[] = [];
    const perFile: Record<string, number> = {};
    let total = 0;

    for (const file of workflowFiles()) {
      const workflow = loadWorkflow(file);
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        steps.forEach((step, index) => {
          if (typeof step.uses !== "string") return;
          if (step.uses.split("@")[0].toLowerCase() !== ACTION) return;

          total += 1;
          perFile[file] = (perFile[file] ?? 0) + 1;
          const where = `${file} job ${jobId} step ${index + 1}`;

          if (step.uses !== `${ACTION}@${ACTION_SHA}`) {
            violations.push(`${where} uses ${step.uses}, not the pinned v1.3.2 commit`);
          }

          const previous = steps[index - 1];
          if (previous?.run !== PREFETCH) {
            violations.push(`${where} is not preceded by \`${PREFETCH}\``);
          }

          const inputs = step.with ?? {};
          if (inputs.mode !== "firewall-free") {
            violations.push(`${where} has mode ${JSON.stringify(inputs.mode)}, not firewall-free`);
          }
          if (inputs["firewall-version"] !== FIREWALL_VERSION) {
            violations.push(`${where} has firewall-version ${JSON.stringify(inputs["firewall-version"])}, not ${FIREWALL_VERSION}`);
          }
        });
      }
    }

    expect(violations).toEqual([]);
    expect(total).toBe(14);
    expect(perFile).toEqual({
      "test.yml": 9,
      "release.yml": 3,
      "smoke.yml": 1,
      "real-flair.yml": 1,
    });
  });

  test("the pre-fetch verifies the pinned binary before it can be used", () => {
    const script = readFileSync(join(REPO, "scripts", "prefetch-socket-firewall.sh"), "utf8");

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain(
      "--retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 --max-time 300",
    );
    expect(script).toContain(
      "https://github.com/SocketDev/sfw-free/releases/download/v${FIREWALL_VERSION}/sfw-free-linux-x86_64",
    );
    expect(script).toContain("cf9f55b8343e1ef6e6dcccdb09b99c70c0430a22ed7d0079286eccddeaf72670");

    // The checksum check runs on the downloaded file before that file is copied
    // into the tool-cache path the action reads.
    const verify = script.indexOf('echo "${SHA256}  ${tmp}" | sha256sum -c -');
    const install = script.indexOf('cp "${tmp}" "${CACHE_BINARY}"');
    expect(verify).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(verify);
  });
});
