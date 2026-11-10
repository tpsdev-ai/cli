/**
 * cli#353 — the publish job's registry handoff.
 *
 * `.github/scripts/docker-publish-index.sh` is run here against stubs for
 * `skopeo` and `docker` (the same way test/docker-nono-smoke.test.ts stubs
 * `docker`) and hand-built OCI layouts: an index with a provenance attestation
 * entry and one without. `copy` must record each archive's PLATFORM
 * image-manifest digest (not the attestation's, not the index digest), and
 * `verify` must accept a final index whose non-attestation entries are exactly
 * `PLATFORMS` with those digests, and fail naming a missing platform, an extra
 * platform, and a wrong digest.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, ".github", "scripts", "docker-publish-index.sh");

const work = mkdtempSync(join(tmpdir(), "docker-publish-index-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const tagKey = (ref: string): string => ref.replace(/[/:]/g, "_");

/**
 * A skopeo stub. `inspect --raw` reads the archive's index.json, or a tag
 * recorded by an earlier copy. `copy` registers the tag and every referenced
 * manifest. Both copy paths require `--all --preserve-digests`.
 */
const STUB_SKOPEO = `#!/usr/bin/env bash
set -euo pipefail
state="\${STUB_STATE:?}"
sub="\${1:?}"
shift
case "$sub" in
  inspect)
    raw=0
    tls=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --raw) raw=1; shift ;;
        --tls-verify=false) tls=1; shift ;;
        *) break ;;
      esac
    done
    [ "$raw" -eq 1 ] || { echo "stub skopeo: inspect without --raw" >&2; exit 97; }
    ref="\${1:?}"
    case "$ref" in
      oci-archive:*)
        tar -xOf "\${ref#oci-archive:}" index.json ;;
      docker://*)
        case "$ref" in
          docker://localhost:*) [ "$tls" -eq 1 ] || { echo "stub skopeo: local inspect requires --tls-verify=false" >&2; exit 97; } ;;
          *) [ "$tls" -eq 0 ] || { echo "stub skopeo: destination inspect disabled TLS" >&2; exit 97; } ;;
        esac
        key="$(printf '%s' "\${ref#docker://}" | tr '/:' '__')"
        [ -f "$state/tags/$key" ] || { echo "stub skopeo: no tag $ref" >&2; exit 1; }
        cat "$state/tags/$key" ;;
      *) echo "stub skopeo: unsupported source $ref" >&2; exit 97 ;;
    esac ;;
  copy)
    all=0
    preserve=0
    src_tls=0
    dest_tls=0
    src=""
    dst=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --all) all=1; shift ;;
        --preserve-digests) preserve=1; shift ;;
        --src-tls-verify=false) src_tls=1; shift ;;
        --dest-tls-verify=false) dest_tls=1; shift ;;
        -*) echo "stub skopeo: unsupported flag $1" >&2; exit 97 ;;
        *) if [ -z "$src" ]; then src="$1"; else dst="$1"; fi; shift ;;
      esac
    done
    [ -n "$src" ] && [ -n "$dst" ] || exit 97
    [ "$all" -eq 1 ] && [ "$preserve" -eq 1 ] || { echo "stub skopeo: copy requires --all --preserve-digests" >&2; exit 97; }
    case "$src:$dst" in
      oci-archive:*:docker://*)
        [ "$src_tls" -eq 0 ] && [ "$dest_tls" -eq 1 ] || { echo "stub skopeo: wrong local copy TLS flags" >&2; exit 97; }
        archive="\${src#oci-archive:}"
        raw="$(tar -xOf "$archive" index.json)"
        key="$(printf '%s' "\${dst#docker://}" | tr '/:' '__')"
        mkdir -p "$state/tags" "$state/blobs" "$state/platforms"
        while IFS= read -r line; do
          digest="\${line%% *}"
          platform="\${line#* }"
          tar -xOf "$archive" "blobs/sha256/\${digest#sha256:}" >"$state/blobs/\${digest#sha256:}"
          printf '%s' "$platform" >"$state/platforms/\${digest#sha256:}"
        done < <(printf '%s' "$raw" | jq -r '.manifests[]? | "\\(.digest) \\(.platform.os)/\\(.platform.architecture)"')
        printf '%s' "$raw" >"$state/tags/$key" ;;
      docker://localhost:5000/*:docker://*)
        [ "$src_tls" -eq 1 ] || { echo "stub skopeo: push requires --src-tls-verify=false" >&2; exit 97; }
        case "$dst" in
          docker://localhost:5001/*) [ "$dest_tls" -eq 1 ] || { echo "stub skopeo: rehearsal requires --dest-tls-verify=false" >&2; exit 97; } ;;
          *) [ "$dest_tls" -eq 0 ] || { echo "stub skopeo: destination TLS disabled" >&2; exit 97; } ;;
        esac
        source_key="$(printf '%s' "\${src#docker://}" | tr '/:' '__')"
        target_key="$(printf '%s' "\${dst#docker://}" | tr '/:' '__')"
        [ -f "$state/tags/$source_key" ] || exit 97
        if [ "\${STUB_MISMATCH:-0}" = 1 ]; then
          printf 'changed' >"$state/tags/$target_key"
        else
          cp "$state/tags/$source_key" "$state/tags/$target_key"
        fi ;;
      *) echo "stub skopeo: unsupported copy $src -> $dst" >&2; exit 97 ;;
    esac ;;
  *) echo "stub skopeo: unsupported command $sub" >&2; exit 97 ;;
esac
`;

/**
 * A docker stub for `docker buildx imagetools create`: it assembles an index
 * from the referenced per-platform manifests. STUB_ATTEST=1 adds an
 * attestation entry (`unknown/unknown`), as a build with provenance would.
 */
const STUB_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
state="\${STUB_STATE:?}"
[ "\${1:-}" = buildx ] || { echo "stub docker: expected buildx" >&2; exit 97; }
shift
[ "\${1:-}" = imagetools ] || { echo "stub docker: expected imagetools" >&2; exit 97; }
shift
[ "\${1:-}" = create ] || { echo "stub docker: expected create" >&2; exit 97; }
shift
target=""
refs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -t) target="\${2:?}"; shift 2 ;;
    *) refs+=("$1"); shift ;;
  esac
done
[ -n "$target" ] || { echo "stub docker: no -t" >&2; exit 97; }
mkdir -p "$state/tags"
entries="[]"
for ref in "\${refs[@]}"; do
  digest="\${ref##*@}"
  hex="\${digest#sha256:}"
  [ -f "$state/blobs/$hex" ] || { echo "stub docker: missing manifest $digest" >&2; exit 1; }
  platform="$(cat "$state/platforms/$hex")"
  entries="$(jq -c --arg d "$digest" --arg os "\${platform%%/*}" --arg arch "\${platform#*/}" '. + [{mediaType:"application/vnd.oci.image.manifest.v1+json",size:1,digest:$d,platform:{architecture:$arch,os:$os}}]' <<<"$entries")"
done
if [ "\${STUB_ATTEST:-0}" = 1 ]; then
  att="sha256:$(printf 'stub attestation' | sha256sum | cut -d' ' -f1)"
  entries="$(jq -c --arg d "$att" '. + [{mediaType:"application/vnd.oci.image.manifest.v1+json",size:1,digest:$d,platform:{architecture:"unknown",os:"unknown"},annotations:{"vnd.docker.reference.type":"attestation-manifest"}}]' <<<"$entries")"
fi
jq -nc --argjson m "$entries" '{schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",manifests:$m}' >"$state/tags/$(printf '%s' "\${target#docker://}" | tr '/:' '__')"
`;

interface Case {
  dir: string;
  state: string;
  archives: string;
  digests: string;
}

function newCase(): Case {
  const dir = join(work, `case-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "state", "tags"), { recursive: true });
  mkdirSync(join(dir, "state", "blobs"), { recursive: true });
  mkdirSync(join(dir, "state", "platforms"), { recursive: true });
  const archives = join(dir, "archives");
  mkdirSync(archives, { recursive: true });
  writeFileSync(join(dir, "bin", "skopeo"), STUB_SKOPEO, { mode: 0o755 });
  writeFileSync(join(dir, "bin", "docker"), STUB_DOCKER, { mode: 0o755 });
  return { dir, state: join(dir, "state"), archives, digests: join(dir, "platform-digests") };
}

interface Archive {
  imageDigest: string;
  attestationDigest?: string;
  indexDigest: string;
}

/** Builds a single-platform OCI archive, optionally with an attestation entry. */
function makeArchive(c: Case, platform: string, attestation: boolean): Archive {
  const arch = platform.split("/")[1];
  const layout = join(c.dir, `layout-${arch}`);
  const blobs = join(layout, "blobs", "sha256");
  mkdirSync(blobs, { recursive: true });

  const config = JSON.stringify({ architecture: arch, os: "linux", rootfs: { type: "layers", diff_ids: [] } });
  const configDigest = sha256(config);
  writeFileSync(join(blobs, configDigest), config);

  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${configDigest}`,
      size: Buffer.byteLength(config),
    },
    layers: [],
  });
  const imageDigest = sha256(manifest);
  writeFileSync(join(blobs, imageDigest), manifest);

  const entries: Array<Record<string, unknown>> = [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${imageDigest}`,
      size: Buffer.byteLength(manifest),
      platform: { architecture: arch, os: "linux" },
    },
  ];

  let attestationDigest: string | undefined;
  if (attestation) {
    const statement = JSON.stringify({ _type: "https://in-toto.io/Statement/v1", subject: [] });
    attestationDigest = sha256(statement);
    writeFileSync(join(blobs, attestationDigest), statement);
    entries.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${attestationDigest}`,
      size: Buffer.byteLength(statement),
      platform: { architecture: "unknown", os: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": `sha256:${imageDigest}`,
      },
    });
  }

  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: entries,
  });
  writeFileSync(join(layout, "index.json"), index);
  writeFileSync(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));

  const archive = join(c.archives, `tps-office-${arch}.oci.tar`);
  const tar = spawnSync("tar", ["-cf", archive, "-C", layout, "index.json", "oci-layout", "blobs"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return { imageDigest, attestationDigest, indexDigest: sha256(index) };
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(c: Case, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: `${join(c.dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      STUB_STATE: c.state,
      PLATFORMS: "linux/amd64,linux/arm64",
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The four fields of one recorded platform line. */
function recorded(c: Case, platform: string): string[] {
  const line = readFileSync(c.digests, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${platform} `));
  expect(line).toBeDefined();
  return (line as string).split(" ");
}

/** Seeds a registry index tag directly, for verify cases. */
function seedIndex(c: Case, entries: Array<{ platform: string; digest: string }>, attestation = false): void {
  const manifests: Array<Record<string, unknown>> = entries.map(({ platform, digest }) => {
    const [os, arch] = platform.split("/");
    return {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: 1,
      platform: { architecture: arch, os },
    };
  });
  if (attestation) {
    manifests.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${sha256("stub attestation")}`,
      size: 1,
      platform: { architecture: "unknown", os: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest" },
    });
  }
  writeFileSync(
    join(c.state, "tags", tagKey("localhost:5000/tps-office:verify")),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests,
    }),
  );
}

describe("docker-publish-index.sh copy", () => {
  test("records the platform image-manifest digest of an index with an attestation entry", () => {
    const c = newCase();
    const amd64 = makeArchive(c, "linux/amd64", true);
    const arm64 = makeArchive(c, "linux/arm64", false);

    const r = runScript(c, ["copy", c.archives, c.digests]);
    expect(r.status).toBe(0);

    const amd64Line = recorded(c, "linux/amd64");
    expect(amd64Line[1]).toBe("amd64");
    expect(amd64Line[2]).toBe(`sha256:${amd64.indexDigest}`);
    expect(amd64Line[3]).toBe(`sha256:${amd64.imageDigest}`);
    expect(amd64Line[3]).not.toBe(`sha256:${amd64.attestationDigest}`);
    expect(amd64Line[3]).not.toBe(amd64Line[2]);

    const arm64Line = recorded(c, "linux/arm64");
    expect(arm64Line[2]).toBe(`sha256:${arm64.indexDigest}`);
    expect(arm64Line[3]).toBe(`sha256:${arm64.imageDigest}`);
    expect(r.stdout).toContain(amd64Line.join(" "));
  });
});

describe("docker-publish-index.sh assemble and verify", () => {
  test("the assembled index passes with attestation entries present", () => {
    const c = newCase();
    const amd64 = makeArchive(c, "linux/amd64", true);
    const arm64 = makeArchive(c, "linux/arm64", false);

    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    expect(runScript(c, ["assemble", c.digests], { STUB_ATTEST: "1" }).status).toBe(0);
    const raw = join(c.dir, "index.json");
    const r = runScript(c, ["verify", c.digests, raw], { STUB_ATTEST: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`linux/amd64 sha256:${amd64.imageDigest}`);
    expect(r.stdout).toContain(`linux/arm64 sha256:${arm64.imageDigest}`);
    expect(r.stdout).not.toContain("unknown/unknown");
    expect(JSON.parse(readFileSync(raw, "utf8")).manifests).toHaveLength(3);
  });

  test("rejects a missing digest row before inspecting the index", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    const amd64 = recorded(c, "linux/amd64");
    writeFileSync(c.digests, `${amd64.join(" ")}\n`);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    // No index was seeded: an inspect before the set check would fail with the stub's "no tag" error instead.
    expect(r.stderr).not.toContain("stub skopeo");
    expect(r.stderr).toContain("missing linux/arm64");
  });

  test("rejects an extra digest platform before inspecting the index", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    const amd64 = recorded(c, "linux/amd64");
    const arm64 = recorded(c, "linux/arm64");
    const extra = `sha256:${sha256("riscv64")}`;
    writeFileSync(c.digests, `${readFileSync(c.digests, "utf8")}linux/riscv64 riscv64 ${extra} ${extra}\n`);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    // No index was seeded: an inspect before the set check would fail with the stub's "no tag" error instead.
    expect(r.stderr).not.toContain("stub skopeo");
    expect(r.stderr).toContain("extra linux/riscv64");
  });

  test("rejects a duplicate digest platform before inspecting the index", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    const amd64 = recorded(c, "linux/amd64");
    const arm64 = recorded(c, "linux/arm64");
    writeFileSync(c.digests, `${readFileSync(c.digests, "utf8")}${amd64.join(" ")}\n`);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    // No index was seeded: an inspect before the set check would fail with the stub's "no tag" error instead.
    expect(r.stderr).not.toContain("stub skopeo");
    expect(r.stderr).toContain("duplicate linux/amd64");
  });

  test("fails naming a missing platform", () => {
    const c = newCase();
    const amd64 = makeArchive(c, "linux/amd64", true);
    const arm64 = makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    seedIndex(c, [
      { platform: "linux/amd64", digest: recorded(c, "linux/amd64")[3] },
      // arm64 is in the digests file but not in the index.
    ]);
    expect(recorded(c, "linux/arm64")[2]).toBe(`sha256:${arm64.indexDigest}`);
    expect(recorded(c, "linux/amd64")[3]).toBe(`sha256:${amd64.imageDigest}`);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`missing platform linux/arm64 (expected sha256:${arm64.imageDigest})`);
  });

  test("fails naming an extra platform", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    seedIndex(c, [
      { platform: "linux/amd64", digest: recorded(c, "linux/amd64")[3] },
      { platform: "linux/arm64", digest: recorded(c, "linux/arm64")[3] },
      { platform: "linux/riscv64", digest: `sha256:${sha256("riscv64")}` },
    ]);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unexpected platform linux/riscv64");
  });

  test("fails naming an unmarked unknown/unknown entry", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    seedIndex(c, [
      { platform: "linux/amd64", digest: recorded(c, "linux/amd64")[3] },
      { platform: "linux/arm64", digest: recorded(c, "linux/arm64")[3] },
      { platform: "unknown/unknown", digest: `sha256:${sha256("unmarked")}` },
    ]);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unexpected platform unknown/unknown");
  });

  test("fails naming a wrong digest", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    const wrong = `sha256:${sha256("not the platform manifest")}`;
    seedIndex(c, [
      { platform: "linux/amd64", digest: wrong },
      { platform: "linux/arm64", digest: recorded(c, "linux/arm64")[3] },
    ]);

    const r = runScript(c, ["verify", c.digests]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`wrong digest for linux/amd64: expected ${recorded(c, "linux/amd64")[3]}, index has ${wrong}`);
  });
});

describe("docker-publish-index.sh push", () => {
  test("push compares the destination digest with the local index digest on the stubbed rehearsal and GHCR branches", () => {
    const c = newCase();
    makeArchive(c, "linux/amd64", true);
    makeArchive(c, "linux/arm64", false);
    expect(runScript(c, ["copy", c.archives, c.digests]).status).toBe(0);
    expect(runScript(c, ["assemble", c.digests]).status).toBe(0);
    const raw = join(c.dir, "index.json");
    expect(runScript(c, ["verify", c.digests, raw]).status).toBe(0);
    writeFileSync(join(c.dir, "index-digest"), sha256(readFileSync(raw, "utf8")));

    expect(runScript(c, ["push", "localhost:5001/tps-office:rehearsal", "--rehearsal"], { RUNNER_TEMP: c.dir }).status).toBe(0);
    expect(runScript(c, ["push", "ghcr.io/tpsdev-ai/tps-office:test"], { RUNNER_TEMP: c.dir }).status).toBe(0);
    const mismatch = runScript(c, ["push", "ghcr.io/tpsdev-ai/tps-office:test"], { RUNNER_TEMP: c.dir, STUB_MISMATCH: "1" });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("digest mismatch for ghcr.io/tpsdev-ai/tps-office:test");
  });
});
