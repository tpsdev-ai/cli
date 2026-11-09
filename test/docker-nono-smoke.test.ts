/**
 * cli#353 — the Docker Image workflow smokes every platform it publishes.
 *
 * `.github/scripts/docker-nono-smoke.sh` is run here against a stub `docker`
 * and a tiny fixture binary (no real image): the correct per-platform hash
 * passes, a wrong hash fails printing both hashes, a missing platform line
 * fails naming the platform, and a failed `nono --version` fails. The workflow
 * tests read the real `docker.yml`: the push step's platforms are the same list
 * the smoke loop iterates, and the push is gated on the `publish` input.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, ".github", "scripts", "docker-nono-smoke.sh");
const WORKFLOW = join(REPO, ".github", "workflows", "docker.yml");
const DOCKERFILE = join(REPO, "docker", "Dockerfile");
const HASHES = join(REPO, "docker", "nono.sha256");

const work = mkdtempSync(join(tmpdir(), "docker-nono-smoke-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const AMD64 = "#!/bin/sh\necho nono 0.74.0\n";
const ARM64 = "#!/bin/sh\necho 'nono 0.74.0 (arm64)'\n";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A docker stub: create/cp serve a fixture binary per platform, run its version. */
const STUB_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; shift
case "$cmd" in
  create)
    while [ "$#" -gt 0 ] && [ "$1" != "--platform" ]; do shift; done
    [ "$1" = "--platform" ] || exit 97
    case "$2" in
      linux/amd64) echo cid-amd64 ;;
      linux/arm64) echo cid-arm64 ;;
      *) exit 97 ;;
    esac ;;
  cp)
    case "$1" in
      cid-amd64:*) cp "$STUB_AMD64" "$2" ;;
      cid-arm64:*) cp "$STUB_ARM64" "$2" ;;
      *) exit 97 ;;
    esac ;;
  rm) exit 0 ;;
  run)
    case " $* " in
      *" --version "*) ;;
      *) exit 97 ;;
    esac
    printf '%s\\n' "\${STUB_VERSION_OUT:-nono 0.74.0}"
    exit "\${STUB_VERSION_RC:-0}" ;;
  *) exit 97 ;;
esac
`;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

const hashFile = (amd64: string, arm64: string): string =>
  `${amd64} linux/amd64\n${arm64} linux/arm64\n`;

let caseNo = 0;
function runScript(
  platform: string,
  hashes: string,
  env: Record<string, string> = {},
): Run {
  const dir = join(work, `case-${++caseNo}`);
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  mkdirSync(join(dir, "docker"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, ".github", "scripts", "docker-nono-smoke.sh"));
  writeFileSync(join(dir, "docker", "nono.sha256"), hashes);
  writeFileSync(join(dir, "bin", "docker"), STUB_DOCKER, { mode: 0o755 });
  const amd64 = join(dir, "nono-amd64");
  const arm64 = join(dir, "nono-arm64");
  writeFileSync(amd64, AMD64);
  writeFileSync(arm64, ARM64);
  const r = spawnSync(
    "bash",
    [
      join(dir, ".github", "scripts", "docker-nono-smoke.sh"),
      platform,
      `tps-office-verify:${platform.replace("/", "-")}`,
    ],
    {
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        STUB_AMD64: amd64,
        STUB_ARM64: arm64,
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("docker-nono-smoke.sh", () => {
  test("amd64 passes against its own hash line", () => {
    const r = runScript("linux/amd64", hashFile(sha256(AMD64), sha256(ARM64)));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nono 0.74.0");
  });

  test("arm64 passes against its own hash line", () => {
    const r = runScript("linux/arm64", hashFile(sha256(AMD64), sha256(ARM64)));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nono 0.74.0");
  });

  test("fails a wrong hash, printing expected and actual", () => {
    const wrong = "0".repeat(64);
    const r = runScript("linux/amd64", hashFile(wrong, sha256(ARM64)));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(wrong);
    expect(r.stderr).toContain(sha256(AMD64));
  });

  test("fails a platform with no hash line, naming it", () => {
    const r = runScript("linux/arm64", `${sha256(AMD64)} linux/amd64\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("linux/arm64");
  });

  test("fails when nono --version exits non-zero", () => {
    const r = runScript("linux/amd64", hashFile(sha256(AMD64), sha256(ARM64)), {
      STUB_VERSION_RC: "1",
    });
    expect(r.status).toBe(1);
  });
});

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: { push?: boolean; platforms?: string };
}
interface Workflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { type?: string; default?: boolean }>;
    };
  };
  jobs?: Record<string, { env?: Record<string, string>; steps?: Step[] }>;
}

const workflow = yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;
const job = workflow.jobs?.["build-and-push"];
const steps = job?.steps ?? [];
const push = steps.find((s) => s.with?.push === true);

describe("docker.yml", () => {
  test("the push step publishes the same platforms the smoke loop builds", () => {
    const all = (job?.env?.PLATFORMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    expect(all).toEqual(["linux/amd64", "linux/arm64"]);
    expect(push?.with?.platforms).toBe("${{ env.PLATFORMS }}");

    const smoke = steps.find((s) => s.run?.includes("docker-nono-smoke.sh"));
    expect(smoke).toBeDefined();
    const found = /for platform in ([^;]+); do/.exec(smoke?.run ?? "");
    expect(found).not.toBeNull();
    const iter = found?.[1].trim() ?? "";
    // The only accepted expansion is the whole list; anything else is read as
    // the literal platforms it names, so a loop that drops one is visible here.
    const smoked = iter === "${PLATFORMS//,/ }" ? all : iter.split(/\s+/).filter(Boolean);
    expect(smoked).toEqual(all);
  });

  test("every pushed platform has a nono hash line", () => {
    const all = (job?.env?.PLATFORMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const lines = readFileSync(HASHES, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/));
    for (const platform of all) {
      expect(
        lines.some(([hash, p]) => p === platform && /^[0-9a-f]{64}$/.test(hash)),
      ).toBe(true);
    }
  });

  test("the push step is gated on the publish input", () => {
    expect(push?.if).toContain("inputs.publish");
    expect(workflow.on?.workflow_dispatch?.inputs?.publish?.type).toBe("boolean");
    expect(workflow.on?.workflow_dispatch?.inputs?.publish?.default).toBe(true);
  });

  test("the nono-builder base is digest-pinned", () => {
    expect(readFileSync(DOCKERFILE, "utf8")).toMatch(
      /^FROM rust:bookworm@sha256:[0-9a-f]{64} AS nono-builder$/m,
    );
  });
});
