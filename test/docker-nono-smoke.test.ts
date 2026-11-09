/**
 * cli#353 — the Docker Image workflow smokes every platform it publishes.
 *
 * `.github/scripts/docker-nono-smoke.sh` is run here against a stub `docker`
 * and a tiny fixture binary (no real image): the correct per-platform hash
 * passes, a wrong hash fails printing both hashes, a missing platform line
 * fails naming the platform, and a failed `nono --version` fails. A smoke is
 * red on a missing hash line, a hash mismatch, a wrong version, or a failed
 * run. The workflow tests read the real `docker.yml`: one job checks the
 * version and tags, each platform is built on its own native runner (no QEMU)
 * into one OCI archive, that leg's smoke loads its own archive, the publish job
 * downloads the `tps-office-*` artifacts and refuses files outside one archive
 * per platform, and runs the tested `.github/scripts/docker-publish-index.sh`
 * to copy each archive with `--all --preserve-digests`, assemble the index from
 * the recorded platform manifests, check digest rows and index entries against
 * `PLATFORMS`, and rehearse the push; only GHCR steps depend on `inputs.publish`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
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
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  "runs-on"?: string;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  services?: Record<string, { image?: string }>;
  steps?: Step[];
}
interface Workflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { type?: string; default?: boolean }>;
    };
  };
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const workflow = yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;
const jobs = workflow.jobs ?? {};
const allSteps = (): Step[] => Object.values(jobs).flatMap((j) => j.steps ?? []);
const platformList = (): string[] =>
  (workflow.env?.PLATFORMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Runs a workflow step's `run` in a temp dir holding the named archive files. */
function runArchiveSetCheck(step: Step, archives: string[]): Run {
  const dir = join(work, `archives-${++caseNo}`);
  const archivesDir = join(dir, "archives");
  mkdirSync(archivesDir, { recursive: true });
  for (const name of archives) {
    const sub = join(archivesDir, name.replace(/\.oci\.tar$/, ""));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, name), "fixture");
  }
  const r = spawnSync("bash", ["-c", step.run ?? ""], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PLATFORMS: platformList().join(","),
      RUNNER_TEMP: dir,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("docker.yml", () => {
  test("repo scripts exist and run after a checkout that includes them", () => {
    for (const [jobName, job] of Object.entries(jobs)) {
      let checkout: Step | undefined;
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) checkout = step;
        const paths = [...(step.run ?? "").matchAll(/(?:^|[\s"'`])((?:\.github\/scripts|scripts)\/[\w./-]+)/gm)]
          .map((match) => match[1]);
        for (const path of paths) {
          const label = `${jobName}: ${step.name ?? step.id ?? "unnamed step"}: ${path}`;
          expect(checkout, `${label} requires an earlier checkout`).toBeDefined();
          expect(existsSync(join(REPO, path)), `${label} must exist in the repository`).toBe(true);
          if (jobName === "publish") {
            expect(checkout?.with?.["persist-credentials"], `${label} must not persist credentials`).toBe(false);
          }
          const sparse = checkout?.with?.["sparse-checkout"];
          if (sparse !== undefined || jobName === "publish") {
            const included = String(sparse ?? "").split("\n").map((entry) => entry.trim())
              .filter(Boolean)
              .some((entry) => path.startsWith(`${entry.replace(/^\//, "").replace(/\/$/, "")}/`));
            expect(included, `${label} must be in the sparse checkout`).toBe(true);
          }
        }
      }
    }
  });

  test("meta feeds the build, and publish needs the build and meta", () => {
    expect(Object.keys(jobs)).toEqual(["meta", "build", "publish"]);
    expect(jobs.build?.needs).toBe("meta");
    expect([jobs.publish?.needs ?? []].flat()).toContain("build");
    expect(jobs.meta?.permissions).toEqual({ contents: "read" });
    expect(jobs.build?.permissions).toEqual({ contents: "read" });
  });

  test("no job sets up QEMU", () => {
    expect(allSteps().filter((s) => s.uses?.includes("setup-qemu"))).toEqual([]);
  });

  test("the build matrix is PLATFORMS, and every arm64 entry runs on an arm runner", () => {
    const platforms = platformList();
    expect(platforms).toEqual(["linux/amd64", "linux/arm64"]);

    const include = jobs.build?.strategy?.matrix?.include ?? [];
    expect(include.map((entry) => entry.platform)).toEqual(platforms);
    expect(jobs.build?.["runs-on"]).toBe("${{ matrix.runner }}");
    expect(jobs.build?.["timeout-minutes"]).toBe(60);
    for (const entry of include) {
      if (entry.platform === "linux/arm64") expect(entry.runner).toMatch(/arm/);
      else expect(entry.runner).not.toMatch(/arm/);
    }
  });

  test("each leg has one build step writing its OCI archive and smokes that archive", () => {
    const builds = (jobs.build?.steps ?? []).filter((s) =>
      s.uses?.includes("docker/build-push-action"),
    );
    expect(builds.length).toBe(1);
    const build = builds[0];
    expect(build.if).toBeUndefined();
    expect(build.with?.push).toBe(false);
    expect(build.with?.platforms).toBe("${{ matrix.platform }}");
    expect(String(build.with?.outputs)).toContain("type=oci,dest=");
    expect(String(build.with?.outputs)).toContain("tps-office-");
    expect(String(build.with?.outputs)).toContain(".oci.tar");
    for (const key of ["cache-from", "cache-to"]) {
      expect(String(build.with?.[key]), key).toContain("scope=");
      expect(String(build.with?.[key]), key).toContain("arch");
    }

    expect((jobs.build?.steps ?? []).filter((s) => s.run?.includes("docker buildx build"))).toEqual(
      [],
    );
    expect(allSteps().filter((s) => s.with?.push === true)).toEqual([]);

    const smoke = (jobs.build?.steps ?? []).find((s) => s.run?.includes("docker-nono-smoke.sh"));
    const run = smoke?.run ?? "";
    expect(run).toContain('archive="${RUNNER_TEMP:-/tmp}/tps-office-$ARCH.oci.tar"');
    expect(run).toContain('"oci-archive:$archive"');
    expect(run).toContain('"docker-daemon:$tag"');
    expect(run).toContain('bash .github/scripts/docker-nono-smoke.sh "$PLATFORM" "$tag"');
    expect(smoke?.env?.PLATFORM).toBe("${{ matrix.platform }}");
  });

  test("the amd64 leg runs the launch control on its archive-loaded image", () => {
    const launch = (jobs.build?.steps ?? []).find((s) => s.run?.includes("tps-office-supervisor"));
    expect(launch).toBeDefined();
    expect(launch?.if).toBe("matrix.platform == 'linux/amd64'");
    expect(launch?.run).toContain("tps-office-verify:linux-amd64");
  });

  test("each leg uploads its archive with the pinned action for one day", () => {
    const uploads = (jobs.build?.steps ?? []).filter((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads.length).toBe(1);
    expect(uploads[0].uses).toBe(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(uploads[0].with?.["retention-days"]).toBe(1);
  });

  test("only the publish job can write packages, and its login is gated on publish", () => {
    const writers = Object.entries(jobs)
      .filter(([, job]) => job.permissions?.["packages"] === "write")
      .map(([name]) => name);
    expect(writers).toEqual(["publish"]);
    expect(workflow.permissions?.["packages"]).not.toBe("write");
    expect(jobs.publish?.permissions?.["contents"]).toBe("read");

    const login = (jobs.publish?.steps ?? []).find((s) =>
      s.uses?.includes("docker/login-action"),
    );
    expect(login?.with?.registry).toBe("ghcr.io");
    expect(login?.if).toBe("${{ inputs.publish }}");
  });

  test("publish downloads matching tps-office-* artifacts; a later step rejects unexpected files", () => {
    const download = (jobs.publish?.steps ?? []).find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download?.uses).toBe(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    expect(download?.with?.pattern).toBe("tps-office-*");
    expect(download?.with?.["merge-multiple"]).toBe(false);
  });

  test("the publish job refuses a downloaded set that is not one archive per PLATFORMS", () => {
    const steps = jobs.publish?.steps ?? [];
    const check = steps.find((s) => s.name?.startsWith("Require exactly one archive"));
    expect(check).toBeDefined();
    const copy = steps.findIndex((s) => s.run?.includes("docker-publish-index.sh copy"));
    expect(steps.indexOf(check as Step)).toBeLessThan(copy);

    const expected = platformList().map((p) => `tps-office-${p.replace("linux/", "")}.oci.tar`);
    const ok = runArchiveSetCheck(check as Step, expected);
    expect(ok.status).toBe(0);
    for (const name of expected) expect(ok.stdout).toContain(name);

    const missing = runArchiveSetCheck(check as Step, expected.slice(1));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`missing archive(s):\n${expected[0]}`);

    const extra = runArchiveSetCheck(check as Step, [...expected, "tps-office-riscv64.oci.tar"]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("unexpected archive(s):\ntps-office-riscv64.oci.tar");
    for (const name of ["other.oci.tar", "stray.txt"]) {
      const stray = runArchiveSetCheck(check as Step, [...expected, name]);
      expect(stray.status).toBe(1);
      expect(stray.stderr).toContain(`unexpected archive(s):\n${name}`);
    }
  });

  test("each build step disables the build-record upload", () => {
    const builds = (jobs.build?.steps ?? []).filter((s) =>
      s.uses?.includes("docker/build-push-action"),
    );
    expect(builds.length).toBe(1);
    expect(builds[0].env?.DOCKER_BUILD_RECORD_UPLOAD).toBe("false");
  });

  test("every registry copy in the publish script preserves digests", () => {
    const script = readFileSync(join(REPO, ".github/scripts/docker-publish-index.sh"), "utf8");
    const lines = script.split("\n").filter((line) => /^\s*skopeo copy\b/.test(line));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("--all");
      expect(line).toContain("--preserve-digests");
    }
  });

  test("the publish job runs the tested script for copy, assemble and verify", () => {
    const steps = jobs.publish?.steps ?? [];
    const calls = steps
      .map((s) => ({ name: s.name, run: s.run ?? "" }))
      .filter((s) => s.run.includes("docker-publish-index.sh"));
    expect(calls.map((s) => s.run.match(/docker-publish-index\.sh (\w+)/)?.[1])).toEqual([
      "copy",
      "assemble",
      "verify",
      "push",
      "push",
    ]);
    expect(calls[0].run).toContain('"${RUNNER_TEMP:-/tmp}/archives"');
    expect(calls[0].run).toContain('"${RUNNER_TEMP:-/tmp}/platform-digests"');
    expect(calls[1].run).toContain('"${RUNNER_TEMP:-/tmp}/platform-digests"');
    expect(calls[2].run).toContain('"${RUNNER_TEMP:-/tmp}/platform-digests"');
    expect(calls[2].run).toContain('"${RUNNER_TEMP:-/tmp}/index.json"');
    expect(calls[3].run).toContain("--rehearsal");
    expect(calls[4].run).not.toContain("--rehearsal");
    expect(steps.some((s) => s.run?.includes("skopeo inspect --raw oci-archive:"))).toBe(false);
    expect(steps.some((s) => s.run?.includes("docker buildx imagetools create"))).toBe(false);
  });

  test("the rehearsal and GHCR steps use push with destination TLS enabled for GHCR", () => {
    const steps = jobs.publish?.steps ?? [];
    const rehearsal = steps.find((s) => s.name === "Rehearse the GHCR copy against a second local registry");
    const ghcr = steps.find((s) => s.name === "Push the index to GHCR");
    const login = steps.findIndex((s) => s.name === "Log in to ghcr.io");
    expect(rehearsal).toBeDefined();
    expect(rehearsal?.if).toBeUndefined();
    expect(steps.indexOf(rehearsal as Step)).toBeLessThan(login);
    expect(rehearsal?.run).toContain("docker-publish-index.sh push localhost:5001/tps-office:rehearsal --rehearsal");
    expect(ghcr).toBeDefined();
    expect(ghcr?.if).toBe("${{ inputs.publish }}");
    expect(ghcr?.env?.TAGS).toBe("${{ needs.meta.outputs.tags }}");
    expect(ghcr?.run).toContain('docker-publish-index.sh push "$tag"');
    expect(ghcr?.run).not.toContain("--rehearsal");
    expect(ghcr?.run).not.toContain("tls-verify=false");
    expect(readFileSync(WORKFLOW, "utf8")).not.toContain("--dest-tls-verify=false");
    expect(workflow.on?.workflow_dispatch?.inputs?.publish?.type).toBe("boolean");
  });

  test("the local registry service is pinned by digest", () => {
    expect(jobs.publish?.services?.registry?.image).toMatch(/^registry:2@sha256:[0-9a-f]{64}$/);
    expect(jobs.publish?.services?.["rehearsal-registry"]?.image).toBe(jobs.publish?.services?.registry?.image);
  });

  test("every pushed platform has a nono hash line", () => {
    const lines = readFileSync(HASHES, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/));
    for (const platform of platformList()) {
      expect(lines.some(([hash, p]) => p === platform && /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    }
  });

  test("the nono-builder base is digest-pinned", () => {
    expect(readFileSync(DOCKERFILE, "utf8")).toMatch(
      /^FROM rust:bookworm@sha256:[0-9a-f]{64} AS nono-builder$/m,
    );
  });
});
