/**
 * workflow-socket-firewall-retry.test.ts — every socketdev/action use attempts
 * to restore a cache of the verified binary and then pre-fetches it through the
 * retrying, checksum-verifying script (cli#898).
 *
 * The pinned action (v1.3.2) makes one un-retried download of the Socket
 * Firewall binary and verifies no checksum of its own, so a transient 504 from
 * the release host failed every job before its own steps. Each job now attempts
 * to restore the verified binary from actions/cache, and runs
 * scripts/prefetch-socket-firewall.sh immediately before the action: a restored
 * entry that does not match the pin is discarded and the script downloads the
 * exact version the action is told to use with a bounded curl backoff, checks
 * the pinned sha256, and only then writes the tool-cache entry the action
 * reuses. The action still runs, so the firewall is installed; a downloaded
 * binary that does not match the pin, or a failed download, fails the job.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

  test("every workflow step that runs it passes no arguments", () => {
    const violations: string[] = [];
    let total = 0;

    for (const file of workflowFiles()) {
      const workflow = loadWorkflow(file);
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        steps.forEach((step, index) => {
          if (typeof step.run !== "string" || !step.run.includes("prefetch-socket-firewall.sh")) return;
          total += 1;
          if (step.run !== PREFETCH) {
            violations.push(
              `${file} job ${jobId} step ${index + 1} runs ${JSON.stringify(step.run)}, not \`${PREFETCH}\``,
            );
          }
        });
      }
    }

    expect(violations).toEqual([]);
    expect(total).toBe(14);
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

  test("environment values cannot change the download URL or the pin", () => {
    const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-env-"));
    try {
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin);
      const argvLog = join(root, "curl.argv");
      writeFileSync(
        join(fakeBin, "curl"),
        [
          "#!/bin/sh",
          'printf "%s\\n" "$*" >> "$CURL_ARGV_LOG"',
          'out=""',
          'while [ $# -gt 0 ]; do',
          '  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac',
          "done",
          'printf "injected-payload" > "$out"',
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
          CURL_ARGV_LOG: argvLog,
          SFW_PREFETCH_URL: "https://example.invalid/sfw",
          SFW_PREFETCH_TEST_SHA256: sha256("injected-payload"),
        },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
      const attempted = readFileSync(argvLog, "utf8");
      expect(attempted).toContain("https://github.com/SocketDev/sfw-free/releases/download/v1.15.4/sfw-free-");
      expect(attempted).not.toContain("example.invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an unknown argument", () => {
    const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-args-"));
    try {
      const result = spawnSync("bash", [join(REPO, "scripts", "prefetch-socket-firewall.sh"), "--unknown-flag"], {
        env: { ...process.env, RUNNER_TOOL_CACHE: join(root, "cache"), RUNNER_TEMP: root },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown argument");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function archName(): string {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`unsupported test host architecture: ${process.arch}`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Async spawn: the local HTTP servers below live in this process, so a blocking
// spawnSync would stop the event loop from answering them.
function runProcess(
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ status: null, stdout, stderr: `${stderr}${String(error)}` }));
    child.on("close", (code) => finish({ status: code, stdout, stderr }));
  });
}

interface LocalServer {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

function startServer(
  handler: (request: string, response: import("node:http").ServerResponse, count: number) => void,
): Promise<LocalServer> {
  return new Promise((resolve, reject) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const request = `${req.method} ${req.url}`;
      requests.push(request);
      handler(request, res, requests.length);
    });
    // A proxy CONNECT is a download attempt; the mock refuses it and logs it.
    server.on("connect", (req, socket) => {
      requests.push(`CONNECT ${req.url}`);
      socket.destroy();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("test server did not bind a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function testEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[key];
  return { ...env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...overrides } as Record<string, string>;
}

describe("the pre-fetch retry against a local HTTP server", () => {
  const script = readFileSync(join(REPO, "scripts", "prefetch-socket-firewall.sh"), "utf8");

  test(
    "the real curl retries a 504 and installs the verified bytes on the next 200",
    async () => {
      const payload = "retry-test-payload";
      let attempts = 0;
      const server = await startServer((_request, response) => {
        attempts += 1;
        if (attempts === 1) {
          response.statusCode = 504;
          response.end("gateway timeout");
          return;
        }
        response.statusCode = 200;
        response.end(payload);
      });
      const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-retry-"));
      try {
        const result = await runProcess(
          "bash",
          [
            join(REPO, "scripts", "prefetch-socket-firewall.sh"),
            "--test-url",
            `${server.url}/sfw-free-linux-x86_64`,
            "--test-sha256",
            sha256(payload),
            "--test-retry-delay",
            "1",
          ],
          {
            env: testEnv({
              RUNNER_TOOL_CACHE: join(root, "cache"),
              RUNNER_TEMP: root,
              GITHUB_WORKSPACE: join(root, "workspace"),
            }),
            timeoutMs: 25_000,
          },
        );

        expect(result.status).toBe(0);
        expect(attempts).toBe(2);
        const installed = join(root, "cache", "socket-firewall-free", FIREWALL_VERSION, archName(), "sfw");
        expect(readFileSync(installed, "utf8")).toBe(payload);
        expect(readFileSync(join(root, "workspace", ".sfw-cache", "sfw"), "utf8")).toBe(payload);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await server.close();
      }
    },
    30_000,
  );

  test(
    "the real curl stops after 9 attempts against a server that always answers 504",
    async () => {
      const server = await startServer((_request, response) => {
        response.statusCode = 504;
        response.end("gateway timeout");
      });
      const root = mkdtempSync(join(tmpdir(), "sfw-prefetch-retry-"));
      try {
        const result = await runProcess(
          "bash",
          [
            join(REPO, "scripts", "prefetch-socket-firewall.sh"),
            "--test-url",
            `${server.url}/sfw-free-linux-x86_64`,
            "--test-sha256",
            sha256("never-served"),
            "--test-retry-delay",
            "1",
          ],
          {
            env: testEnv({
              RUNNER_TOOL_CACHE: join(root, "cache"),
              RUNNER_TEMP: root,
              GITHUB_WORKSPACE: join(root, "workspace"),
            }),
            timeoutMs: 25_000,
          },
        );

        expect(result.status).not.toBe(0);
        expect(server.requests.length).toBe(9);
        expect(existsSync(join(root, "cache"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await server.close();
      }
    },
    30_000,
  );
});

const ACTION_DIST_URL = `https://raw.githubusercontent.com/SocketDev/action/${ACTION_SHA}/dist/main.js`;

let actionDistPath: string | undefined;
let actionDistRoot: string | undefined;

// The test uses the action copy GitHub's runner caches under
// <runner>/_work/_actions/socketdev/action/<sha> when it can locate it;
// otherwise it fetches dist/main.js from the pinned SHA on
// raw.githubusercontent.com into a temp dir. Nothing is vendored into the repo.
function cachedActionDist(): string | undefined {
  const workspace = process.env.RUNNER_WORKSPACE ?? process.env.GITHUB_WORKSPACE;
  if (!workspace) return undefined;
  const candidate = join(workspace, "..", "_actions", "socketdev", "action", ACTION_SHA, "dist", "main.js");
  return existsSync(candidate) ? candidate : undefined;
}

async function actionDist(): Promise<string> {
  if (actionDistPath) return actionDistPath;
  const cached = cachedActionDist();
  if (cached) {
    actionDistPath = cached;
    return cached;
  }
  actionDistRoot = mkdtempSync(join(tmpdir(), "sfw-action-dist-"));
  actionDistPath = join(actionDistRoot, "dist", "main.js");
  mkdirSync(join(actionDistRoot, "dist"));
  const response = await fetch(ACTION_DIST_URL);
  if (!response.ok) throw new Error(`fetching the pinned action dist returned ${response.status}`);
  writeFileSync(actionDistPath, Buffer.from(await response.arrayBuffer()));
  return actionDistPath;
}

afterAll(() => {
  if (actionDistRoot) rmSync(actionDistRoot, { recursive: true, force: true });
});

interface ActionRun {
  status: number | null;
  output: string;
  stdout: string;
  stderr: string;
}

async function runPinnedAction({ root, main, apiUrl }: { root: string; main: string; apiUrl: string }): Promise<ActionRun> {
  const outDir = join(root, "github");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(root, "runner-temp"), { recursive: true });
  const outputFile = join(outDir, "output");
  const pathFile = join(outDir, "path");
  const envFile = join(outDir, "env");
  writeFileSync(outputFile, "");
  writeFileSync(pathFile, "");
  writeFileSync(envFile, "");
  const shim = join(root, "test-retry-shim.cjs");
  writeFileSync(
    shim,
    "globalThis.TEST_DOWNLOAD_TOOL_RETRY_MIN_SECONDS = 0;\nglobalThis.TEST_DOWNLOAD_TOOL_RETRY_MAX_SECONDS = 0;\n",
  );

  const env = testEnv({
    "INPUT_MODE": "firewall-free",
    "INPUT_GITHUB-TOKEN": "test-token",
    "INPUT_USE-CACHE": "true",
    "INPUT_JOB-SUMMARY": "all",
    "INPUT_FIREWALL-VERSION": FIREWALL_VERSION,
    "INPUT_PATCH-DRY-RUN": "false",
    "INPUT_PATCH-VERSION": "",
    "INPUT_PATCH-ECOSYSTEMS": "",
    "INPUT_PATCH-CWD": "",
    RUNNER_TOOL_CACHE: join(root, "cache"),
    RUNNER_TEMP: join(root, "runner-temp"),
    GITHUB_API_URL: apiUrl,
    GITHUB_OUTPUT: outputFile,
    GITHUB_PATH: pathFile,
    GITHUB_ENV: envFile,
    HTTPS_PROXY: apiUrl,
    https_proxy: apiUrl,
  });

  const result = await runProcess("node", ["--require", shim, main], { env, timeoutMs: 25_000 });
  return { status: result.status, output: readFileSync(outputFile, "utf8"), stdout: result.stdout, stderr: result.stderr };
}

describe("the pinned socketdev/action lookup", () => {
  const script = readFileSync(join(REPO, "scripts", "prefetch-socket-firewall.sh"), "utf8");

  function releaseApi() {
    return startServer((request, response) => {
      if (request === `GET /repos/socketdev/sfw-free/releases/tags/v${FIREWALL_VERSION}`) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ tag_name: `v${FIREWALL_VERSION}` }));
        return;
      }
      response.statusCode = 500;
      response.end("mock release API fails every request");
    });
  }

  test(
    "finds the pre-fetched binary and never attempts its own download",
    async () => {
      const main = await actionDist();
      const server = await releaseApi();
      const root = mkdtempSync(join(tmpdir(), "sfw-action-lookup-"));
      try {
        const prefetch = runPrefetch({ root, pin: hostPin(script), cached: "verified-binary" });
        expect(prefetch.result.status).toBe(0);

        const result = await runPinnedAction({ root, main, apiUrl: server.url });
        expect(result.status).toBe(0);
        expect(result.output).toContain(prefetch.installed);
        expect(server.requests).toEqual([`GET /repos/socketdev/sfw-free/releases/tags/v${FIREWALL_VERSION}`]);
        expect(readFileSync(prefetch.installed, "utf8")).toBe("verified-binary");
      } finally {
        rmSync(root, { recursive: true, force: true });
        await server.close();
      }
    },
    60_000,
  );

  test(
    "misses without the tool-cache marker and falls through to a failed download",
    async () => {
      const main = await actionDist();
      const server = await releaseApi();
      const root = mkdtempSync(join(tmpdir(), "sfw-action-lookup-"));
      try {
        const prefetch = runPrefetch({ root, pin: hostPin(script), cached: "verified-binary" });
        expect(prefetch.result.status).toBe(0);
        const marker = `${join(root, "cache", "socket-firewall-free", FIREWALL_VERSION, archName())}.complete`;
        rmSync(marker);

        const result = await runPinnedAction({ root, main, apiUrl: server.url });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain("Failed to download Socket Firewall binary");
        expect(server.requests).toContain("CONNECT github.com:443");
      } finally {
        rmSync(root, { recursive: true, force: true });
        await server.close();
      }
    },
    60_000,
  );
});
