# Reviewer sandbox image

The image a reviewer agent builds and tests a pull request inside. It carries the
repository's runtimes and a `gh` with **no credential of its own**: no token in
the image, its environment or the launcher's child environment, and no git
credential helper or auth setting in the image or the mounted worktree's git
configuration. The GitHub review credential never enters it. linux/amd64 only
(the reviewer VMs are x86_64).

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
  sandbox. It takes no arguments: the worktree is always `/workspace`.
  `shims/sfw` — stands in for Socket Firewall's `sfw` wrapper (runs the wrapped
  command unchanged; the firewall itself is not reproduced).
- `../../scripts/reviewer/reviewer-launch.mjs` — the trusted launcher. It reads
  the fixed table and the image's baked identity, and the host's assignment —
  `REVIEWER_CI_WORKFLOW`, `REVIEWER_CI_JOB`, `REVIEWER_CI_BASE` — from the
  environment the **host** gave the sandbox when it created it (the container
  init's, `/proc/1/environ`); a caller that passes different values is refused.
  It refuses symlinked lockfiles and symlinked directories in the worktree
  (outside `node_modules/` and `.git/`), plans the job and the jobs it needs,
  resolves the declarations and pins to ONE image and refuses unless it is THIS
  image; creates hermetic `HOME`/`TMPDIR`/caches under `/tmp/review`; builds the
  child env from an allowlist with a fixed `PATH`; and runs the image's own
  node and bun at fixed paths to verify their versions. Then, per job in
  dependency order, it removes what earlier jobs of the build created, refuses a
  worktree whose git configuration carries credential or auth settings, and runs
  every `run:` step as one script under `/bin/bash --noprofile --norc -eo
  pipefail`, after re-checking the step's effective environment and that its
  resolved working directory stays inside the worktree. `review-build-ok` only if
  every job in the closure ran, every step exited 0, and no lockfile in the
  worktree (outside `node_modules/` and `.git/`) changed, appeared or
  disappeared.
- `../../scripts/reviewer/ci-job.mjs` — bounds the workflow (256 KiB, 50,000
  YAML nodes counting every alias use, 32 levels), parses it (YAML 1.2 core
  schema), requires printable-ASCII keys, and requires a `pull_request` trigger
  that covers the host-named base branch. It plans the named job and its
  `needs` closure: what runs; what is skipped — checkout, setup-bun, setup-node,
  socketdev (firewall-free), cache and upload-artifact, each only at a reviewed
  commit SHA and with inputs whose skip semantics were checked; and what is
  refused (any other action or ref, `${{ }}` expressions, other `if:` conditions,
  `continue-on-error`, `strategy`, containers/services, non-bash shells,
  launcher-owned env keys, and credential-shaped or config-redirecting env such
  as `GH_TOKEN`, `*_TOKEN`, `GIT_*`, `NPM_CONFIG_*`, `NODE_OPTIONS`, `BASH_ENV`,
  `LD_*`).
- `../../scripts/reviewer/resolve-runtime.mjs` — resolves `packageManager`,
  `engines`, `.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions` and the
  jobs' pins to ONE matrix image with npm-semver range semantics, or refuses by
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
reference the container engine itself resolves. The same config carries the
assignment: `sandbox.docker.env` sets `REVIEWER_CI_WORKFLOW`, `REVIEWER_CI_JOB`
and `REVIEWER_CI_BASE`, which the container runtime gives the sandbox's init
process at creation.

Builds on different hosts are **not** claimed to produce the same image id: the
base is digest-pinned and every runtime is checksum-verified, but the apt
packages are not version-pinned. Cross-host reproducibility is a follow-up.

## Known limits

- OpenClaw's default `/tmp` tmpfs is `noexec`, as measured in the reviewer-image
  CI run. A suite that executes files from `TMPDIR` needs `/tmp:exec` in the
  reviewer's sandbox config (A15).
- The "no credential" statements cover the image, the environments the launcher
  builds and the worktree's git configuration. They do not cover a credential
  that repository code itself supplies (committed, generated or fetched at
  build time).
- Jobs of the closure run one after another in the one worktree. Before each
  job the launcher removes what earlier jobs created, but not changes they made
  to files that existed before the build, and it treats `node_modules/` and
  `.git/` as single entries (a pre-existing `node_modules/` is kept whole).
- Only a `pull_request` trigger with exact branch names is evaluated; a workflow
  CI runs only on push, or filtered by path or branch pattern, is refused.
