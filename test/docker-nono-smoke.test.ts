/**
 * cli#353 — the Docker Image workflow smokes every platform it publishes.
 *
 * `.github/scripts/docker-nono-smoke.sh` is run here against a stub `docker`
 * and a tiny fixture binary (no real image): the correct per-platform hash
 * passes, a wrong hash fails printing both hashes, a missing platform line
 * fails naming the platform, and a failed `nono --version` fails. A smoke is
 * red on a missing hash line, a hash mismatch, a wrong version, or a failed
 * run. The workflow tests read the real `docker.yml`: one build step writes the
 * OCI archive, the smoke loop loads each PLATFORMS instance from that same
 * archive, every registry copy uses `--all --preserve-digests` from it and is
 * followed by a digest check, and only the GHCR copy is gated on
 * `inputs.publish`.
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
const ARM64 = "#!/bin/sh\necho nono 0.74.0\n# arm64 build\n";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * A docker stub: create/cp serve a fixture binary per platform, and run
 * executes the fixture selected by the image tag, so its `--version` output
 * comes from that fixture. STUB_VERSION_RC simulates a nono that fails.
 */
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
    bin=""
    for arg in "$@"; do
      case "$arg" in
        tps-office-verify:linux-amd64) bin="$STUB_AMD64" ;;
        tps-office-verify:linux-arm64) bin="$STUB_ARM64" ;;
      esac
    done
    [ -n "$bin" ] || exit 97
    if [ "\${STUB_VERSION_RC:-0}" -ne 0 ]; then exit "$STUB_VERSION_RC"; fi
    exec "$bin" --version ;;
  *) exit 97 ;;
esac
`;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

interface Fixtures {
  amd64?: string;
  arm64?: string;
  /** The `version=` line written to .nono-version. */
  version?: string;
}

const hashFile = (amd64: string, arm64: string): string =>
  `${amd64} linux/amd64\n${arm64} linux/arm64\n`;

let caseNo = 0;
function runScript(
  platform: string,
  hashes: string,
  env: Record<string, string> = {},
  fixtures: Fixtures = {},
): Run {
  const dir = join(work, `case-${++caseNo}`);
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  mkdirSync(join(dir, "docker"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, ".github", "scripts", "docker-nono-smoke.sh"));
  writeFileSync(join(dir, "docker", "nono.sha256"), hashes);
  writeFileSync(join(dir, ".nono-version"), `version=${fixtures.version ?? "0.74.0"}\ncommit=unused\n`);
  writeFileSync(join(dir, "bin", "docker"), STUB_DOCKER, { mode: 0o755 });
  const amd64 = join(dir, "nono-amd64");
  const arm64 = join(dir, "nono-arm64");
  writeFileSync(amd64, fixtures.amd64 ?? AMD64, { mode: 0o755 });
  writeFileSync(arm64, fixtures.arm64 ?? ARM64, { mode: 0o755 });
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

  test("fails a wrong version that exits 0, naming expected and actual", () => {
    const bad = "#!/bin/sh\necho nono 0.73.0\n";
    const r = runScript("linux/amd64", hashFile(sha256(bad), sha256(ARM64)), {}, { amd64: bad });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nono 0.74.0");
    expect(r.stderr).toContain("nono 0.73.0");
  });

  test("fails a version line with extra text, which is not exactly 'nono <version>'", () => {
    const extra = "#!/bin/sh\necho 'nono 0.74.0 (arm64)'\n";
    const r = runScript("linux/amd64", hashFile(sha256(extra), sha256(ARM64)), {}, { amd64: extra });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nono 0.74.0 (arm64)");
  });
});

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Workflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { type?: string; default?: boolean }>;
    };
  };
  jobs?: Record<
    string,
    { env?: Record<string, string>; services?: Record<string, { image?: string }>; steps?: Step[] }
  >;
}

const workflow = yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;
const job = workflow.jobs?.["build-and-push"];
const steps = job?.steps ?? [];

describe("docker.yml", () => {
  test("one build step writes the OCI archive and no shell build remains", () => {
    const builds = steps.filter((s) => s.uses?.includes("docker/build-push-action"));
    expect(builds.length).toBe(1);
    const build = builds[0];
    expect(build.with?.push).toBe(false);
    expect(build.with?.platforms).toBe("${{ env.PLATFORMS }}");
    expect(String(build.with?.outputs)).toBe("type=oci,dest=${{ runner.temp }}/tps-office.oci.tar");
    expect(String(build.with?.["cache-from"])).toBe("type=gha");
    expect(String(build.with?.["cache-to"])).toBe("type=gha,mode=max");

    expect(steps.filter((s) => s.run?.includes("docker buildx build"))).toEqual([]);
    expect(steps.filter((s) => s.with?.push === true)).toEqual([]);
    expect(steps.filter((s) => s.run?.includes("docker push "))).toEqual([]);
  });

  test("PLATFORMS drives the build and the smoke loop", () => {
    const all = (job?.env?.PLATFORMS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(all).toEqual(["linux/amd64", "linux/arm64"]);

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

  test("the smoke loads each platform from the archive and requires skopeo", () => {
    const smoke = steps.find((s) => s.run?.includes("docker-nono-smoke.sh"));
    const run = smoke?.run ?? "";
    expect(run).toContain('archive="${RUNNER_TEMP:-/tmp}/tps-office.oci.tar"');
    expect(run).toContain("command -v skopeo");
    expect(run).toContain('"oci-archive:$archive"');
    expect(run).toContain('"docker-daemon:$tag"');
  });

  test("every registry copy uses --all --preserve-digests from the archive, then checks the digest", () => {
    const withCopies = steps.filter(
      (s) => s.run?.includes("skopeo copy") && s.run.includes("docker://"),
    );
    expect(withCopies.length).toBe(2);
    const lines = withCopies.flatMap((s) =>
      (s.run ?? "").split("\n").filter((l) => l.includes("skopeo copy")),
    );
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toContain("--all");
      expect(line).toContain("--preserve-digests");
      expect(line).toContain("oci-archive:$archive");
    }
    for (const step of withCopies) {
      const run = step.run ?? "";
      const copy = run.indexOf("skopeo copy");
      const check = run.indexOf('test "$src" = "$dst"');
      expect(copy).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(copy);
      expect(run).toContain('skopeo inspect --raw "oci-archive:$archive"');
    }
  });

  test("the local-registry handoff runs always and the GHCR copy is gated on publish", () => {
    const local = steps.find((s) => s.run?.includes("docker://localhost:5000/"));
    expect(local).toBeDefined();
    expect(local?.if).toBeUndefined();
    // The job's registry service is plain HTTP on localhost.
    expect(local?.run).toContain("--dest-tls-verify=false");
    expect(local?.run).toContain("skopeo inspect --tls-verify=false");

    const ghcr = steps.find((s) => s.run?.includes('"docker://$tag"'));
    expect(ghcr).toBeDefined();
    expect(ghcr?.if).toContain("inputs.publish");
    expect(ghcr?.run).not.toContain("tls-verify=false");
    expect(ghcr?.env?.TAGS).toBe("${{ steps.image.outputs.tags }}");
    expect(workflow.on?.workflow_dispatch?.inputs?.publish?.type).toBe("boolean");
  });

  test("the local registry service is pinned by digest", () => {
    expect(job?.services?.registry?.image).toMatch(/^registry:2@sha256:[0-9a-f]{64}$/);
  });

  test("every pushed platform has a nono hash line", () => {
    const all = (job?.env?.PLATFORMS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = readFileSync(HASHES, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/));
    for (const platform of all) {
      expect(lines.some(([hash, p]) => p === platform && /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    }
  });

  test("the nono-builder base is digest-pinned", () => {
    expect(readFileSync(DOCKERFILE, "utf8")).toMatch(
      /^FROM rust:bookworm@sha256:[0-9a-f]{64} AS nono-builder$/m,
    );
  });
});
