/**
 * workflow-socket-firewall-retry.test.ts — every socketdev/action use restores
 * a cache of the verified binary and then pre-fetches it through the retrying,
 * checksum-verifying script (cli#898).
 *
 * The pinned action (v1.3.2) makes one un-retried download of the Socket
 * Firewall binary and verifies no checksum of its own, so a transient 504 from
 * the release host failed every job before its own steps. Each job now restores
 * the verified binary from actions/cache, and runs
 * scripts/prefetch-socket-firewall.sh immediately before the action: a restored
 * file is used only when its sha256 matches the pin, otherwise the script
 * downloads the exact version the action is told to use with a bounded curl
 * backoff, checks the pinned sha256, and only then writes the tool-cache entry
 * the action reuses. The action still runs, so the firewall is installed; a
 * failed download or a checksum mismatch fails the job.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO = join(import.meta.dir, "..", "..", "..");
const WORKFLOW_DIR = join(REPO, ".github", "workflows");
const PREFETCH = "bash scripts/prefetch-socket-firewall.sh";
const ACTION = "socketdev/action";
const ACTION_SHA = "ba6de6cc0565af1f42295590380973573297e31f";
const CACHE_ACTION = "actions/cache";
const CACHE_ACTION_SHA = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const FIREWALL_VERSION = "1.15.4";
const PINS = [
  "cf9f55b8343e1ef6e6dcccdb09b99c70c0430a22ed7d0079286eccddeaf72670",
  "c8c80aa582829f24f5d633f2c3f2ccd0b070bbee80bf3b956e5e2a9880184e20",
  "b19f96f0dd3ebc4ecc7111dbc43cc2b095f37bf759273c0bd9c0c4784ea24731",
  "1b705ea7c399727ee41aa93f63e0469d2c3787c50e1dd8842cb8ff5ceec9eb99",
];

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
  test("is preceded by the cache restore and the retrying pre-fetch, in that order, and pins the version it installs", () => {
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

          const restore = steps[index - 2];
          if (typeof restore?.uses !== "string" || restore.uses.split("@")[0].toLowerCase() !== CACHE_ACTION) {
            violations.push(`${where} is not preceded by the ${CACHE_ACTION} restore step`);
          } else if (restore.uses !== `${CACHE_ACTION}@${CACHE_ACTION_SHA}`) {
            violations.push(`${where} restores with ${restore.uses}, not the pinned v6.1.0 commit`);
          } else {
            const restoreWith = restore.with ?? {};
            if (restoreWith.path !== ".sfw-cache") {
              violations.push(`${where} restores path ${JSON.stringify(restoreWith.path)}, not .sfw-cache`);
            }
            const key = typeof restoreWith.key === "string" ? restoreWith.key : "";
            if (key.trim() === "") {
              violations.push(`${where} cache key is empty`);
            } else {
              if (key.length > 512 || key.includes(",")) {
                violations.push(`${where} cache key is one actions/cache rejects (longer than 512 characters or containing a comma)`);
              }
              for (const pin of PINS) {
                if (!key.includes(pin)) violations.push(`${where} cache key does not include the sha256 pin ${pin}`);
              }
              const platform =
                /(Linux|macOS|Darwin)-(X64|ARM64|x64|arm64)/.test(key) ||
                /\$\{\{\s*(runner\.(os|arch)|matrix\.)/.test(key);
              if (!platform) violations.push(`${where} cache key does not include the platform`);
            }
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
      "--retry 8 --retry-all-errors --retry-max-time 300 --connect-timeout 20 --max-time 60",
    );
    expect(script).toContain(
      "https://github.com/SocketDev/sfw-free/releases/download/v${FIREWALL_VERSION}/sfw-free-${ASSET}",
    );
    for (const sha of PINS) expect(script).toContain(sha);
    expect(script).toContain("shasum -a 256");

    // The checksum check runs on the restored cache entry before that file can
    // be installed, and a mismatched entry is deleted before the download.
    const restored = script.indexOf('if [ "$(sha256_of "${RESTORED_BINARY}")" = "${SHA256}" ]; then');
    const discard = script.indexOf('rm -f "${RESTORED_BINARY}"');
    const download = script.indexOf('curl -fsSL --retry 8');
    expect(restored).toBeGreaterThan(-1);
    expect(discard).toBeGreaterThan(restored);
    expect(download).toBeGreaterThan(discard);

    // The checksum check runs on the downloaded file before that file is copied
    // into both the cache path and the tool-cache path the action reads.
    const verify = script.indexOf('if [ "$(sha256_of "${tmp}")" != "${SHA256}" ]; then');
    const install = script.indexOf('install_binary "${tmp}"');
    expect(verify).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(verify);
  });
});

// The cache and download paths are exercised without network by a fake curl
// and, for the cache cases, a fake sha256sum whose verdict depends only on the
// file's content. The download-mismatch case below uses the real sha256 tool.
function hostPin(script: string): string {
  const os = process.platform === "darwin" ? "Darwin" : "Linux";
  const arch = process.arch !== "x64" && process.arch !== "arm64" ? null : process.arch;
  if (arch === null) throw new Error(`unsupported test host architecture: ${process.arch}`);
  const uname = `${os}-${process.platform === "linux" && arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : "arm64"}`;
  const table = script.split('case "$(uname -s)-$(uname -m)" in')[1]?.split("esac")[0] ?? "";
  for (const arm of table.split(";;")) {
    const lines = arm.split("\n").map((line) => line.trim());
    const matches = lines.some((line) => line === `${uname})` || line.startsWith(`${uname} |`));
    if (!matches) continue;
    const sha = /SHA256="([0-9a-f]{64})"/.exec(arm)?.[1];
    if (sha) return sha;
  }
  throw new Error(`no sha256 pin for ${uname} in the pre-fetch script`);
}

function fakeTools(root: string, pin: string): string {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "curl"),
    [
      "#!/bin/sh",
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac',
      "done",
      'echo called >> "$CURL_LOG"',
      'if [ "${CURL_FAIL:-0}" = "1" ]; then',
      '  echo "curl: (22) 504" >&2',
      "  exit 22",
      "fi",
      'cat "$CURL_PAYLOAD" > "$out"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "sha256sum"),
    [
      "#!/bin/sh",
      'if grep -qx "verified-binary" "$1"; then',
      `  printf '%s  %s\\n' "${pin}" "$1"`,
      "else",
      `  printf '%s  %s\\n' "${"0".repeat(64)}" "$1"`,
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBin;
}

interface RunOptions {
  root: string;
  pin: string;
  cached?: string;
  payload?: string;
  curlFail?: boolean;
}

function runPrefetch({ root, pin, cached, payload, curlFail }: RunOptions) {
  const workspace = join(root, "workspace");
  const cache = join(root, "cache");
  const fakeBin = fakeTools(root, pin);
  if (cached !== undefined) {
    mkdirSync(join(workspace, ".sfw-cache"), { recursive: true });
    writeFileSync(join(workspace, ".sfw-cache", "sfw"), cached);
  }
  if (payload !== undefined) writeFileSync(join(root, "payload"), payload);

  const result = spawnSync("bash", [join(REPO, "scripts", "prefetch-socket-firewall.sh")], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      RUNNER_TOOL_CACHE: cache,
      RUNNER_TEMP: root,
      GITHUB_WORKSPACE: workspace,
      CURL_LOG: join(root, "curl.log"),
      CURL_PAYLOAD: join(root, "payload"),
      CURL_FAIL: curlFail ? "1" : "0",
    },
    encoding: "utf8",
  });

  return {
    result,
    log: join(root, "curl.log"),
    restored: join(workspace, ".sfw-cache", "sfw"),
    installed: join(cache, "socket-firewall-free", "1.15.4", process.arch === "arm64" ? "arm64" : "x64", "sfw"),
  };
}

describe("the pre-fetch cache and download paths", () => {
  const script = readFileSync(join(REPO, "scripts", "prefetch-socket-firewall.sh"), "utf8");

  test("a restored file matching the pin is used without a download", () => {
    const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-test-"));
    try {
      const run = runPrefetch({ root, pin: hostPin(script), cached: "verified-binary" });

      expect(run.result.status).toBe(0);
      expect(readFileSync(run.installed, "utf8")).toBe("verified-binary");
      expect(existsSync(run.log)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a restored file that does not match the pin is deleted, downloaded and verified", () => {
    const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-test-"));
    try {
      const run = runPrefetch({
        root,
        pin: hostPin(script),
        cached: "stale-binary",
        payload: "verified-binary",
      });

      expect(run.result.status).toBe(0);
      expect(run.result.stderr).toContain("does not match the pinned sha256");
      expect(readFileSync(run.log, "utf8")).toContain("called");
      expect(readFileSync(run.restored, "utf8")).toBe("verified-binary");
      expect(readFileSync(run.installed, "utf8")).toBe("verified-binary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed cold-cache download exits non-zero and installs nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-test-"));
    try {
      const run = runPrefetch({ root, pin: hostPin(script), curlFail: true });

      expect(run.result.status).not.toBe(0);
      expect(existsSync(run.installed)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a download that does not match the pinned sha256 is not installed", () => {
    const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-test-"));
    try {
      // Real sha256 tools: the payload is not the pinned binary.
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, "curl"),
        [
          "#!/bin/sh",
          'out=""',
          'while [ $# -gt 0 ]; do',
          '  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac',
          "done",
          'printf "not the binary" > "$out"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [join(REPO, "scripts", "prefetch-socket-firewall.sh")], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TOOL_CACHE: join(root, "cache"),
          RUNNER_TEMP: root,
          GITHUB_WORKSPACE: join(root, "workspace"),
        },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
      expect(existsSync(join(root, "cache", "socket-firewall-free", "1.15.4", "x64", "sfw"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
