# Reviewer sandbox image

The image a reviewer agent builds and tests a pull request inside. It carries the
repository's runtimes and a **tokenless** `gh`; the GitHub credential never
enters it. linux/amd64 only (the reviewer VMs are x86_64).

## Pieces

- `Dockerfile` — `FROM` debian:bookworm-slim pinned by digest, with OpenClaw's
  sandbox package set (bash, ca-certificates, curl, git, jq, python3, ripgrep)
  plus Node, Bun, a tokenless `gh` and the launcher's js-yaml, each at an exact
  version verified against a checksum from the trusted table. No entrypoint; the
  CMD is `sleep infinity`, because OpenClaw starts the sandbox as
  `<image> sleep infinity` without overriding the entrypoint.
- `runtime-matrix.json` — the **trusted** table: base digest and platform,
  per-tool exact versions and checksums, the launcher's js-yaml pin (the version
  and integrity `bun.lock` pins), and the image matrix. Maintained here and
  installed on the host; the reviewed checkout can neither extend it nor choose
  a download source.
- `bin/reviewer-launch` — the review build command, run explicitly inside the
  sandbox. `shims/sfw` — stands in for Socket Firewall's `sfw` wrapper (runs the
  wrapped command unchanged; the firewall itself is not reproduced).
- `../../scripts/reviewer/reviewer-launch.mjs` — the trusted launcher. Reads the
  fixed table and the image's baked identity, the CI job the **host** names
  (`REVIEWER_CI_WORKFLOW` + `REVIEWER_CI_JOB` in the sandbox env), the
  workspace's declarations and the job's runtime pins; refuses unless they
  resolve to THIS image; creates hermetic `HOME`/`TMPDIR`/caches under
  `/tmp/review`; builds the child env from an allowlist; verifies the actual
  node/bun; only then runs every `run:` step of the job in order, each as one
  script in its working directory under `bash --noprofile --norc -eo pipefail`.
  `review-build-ok` only if every step exits 0 and no lockfile changed.
- `../../scripts/reviewer/ci-job.mjs` — parses the workflow (YAML) and plans the
  named job: what runs, what is skipped by name (checkout, setup-bun/-node,
  socketdev, cache, upload-artifact) and what is refused (any other action,
  `${{ }}` expressions, other `if:` conditions, `continue-on-error`, `strategy`,
  containers/services, non-bash shells, launcher-owned env keys).
- `../../scripts/reviewer/resolve-runtime.mjs` — resolves `packageManager`,
  `engines`, `.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions` and the
  job's pins to ONE matrix image with npm-semver range semantics, or refuses by
  name (`invalid-declaration`, `ambiguous`, `conflicting`, `out-of-matrix`). An
  out-of-matrix refusal names the missing image by its requirements, e.g.
  `missing image: node >=25 with bun 1.3.10`.
- `../../scripts/reviewer/build-reviewer-image.mjs` — builds one matrix image for
  linux/amd64 with every input read from the table; prints its local image id.
- `../../scripts/reviewer/image-checks.sh` — the image-level checks (A2, A3, A9),
  with the build-path fixtures run the way OpenClaw runs the sandbox.
  `../../scripts/reviewer/a9-red-proofs.sh` — requires the A9 checks to FAIL on
  derived images with planted fake credentials. Both run in the `reviewer-image`
  CI job.

## Building and installing on a reviewer host

```bash
node scripts/reviewer/build-reviewer-image.mjs reviewer-node22-bun1310
bash scripts/reviewer/image-checks.sh reviewer-image:reviewer-node22-bun1310 reviewer-node22-bun1310
```

There is no registry in this slice. The host builds the image from this pinned
Dockerfile at install time and records the printed `local_image_id`
(`sha256:…`) in its sandbox config (`sandbox.docker.image`), a content-addressed
reference the container engine itself resolves. The same config names the job:
`sandbox.docker.env` sets `REVIEWER_CI_WORKFLOW` and `REVIEWER_CI_JOB`.

Builds on different hosts are **not** claimed to produce the same image id: the
base is digest-pinned and every runtime is checksum-verified, but the apt
packages are not version-pinned. Cross-host reproducibility is a follow-up.

## Known limits

OpenClaw's default `/tmp` tmpfs is `noexec`, as measured in the reviewer-image
CI run. A suite that executes files from `TMPDIR` needs `/tmp:exec` in the
reviewer's sandbox config (A15).
