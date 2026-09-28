- **A checksum-pinned reviewer sandbox image, a trusted runtime table and a launcher that refuses to run repository code on an unverified runtime or an unreproducible CI job (Refs #425).**

  The reviewer environment now has its own image and launch path, defined in
  this repository.

  **The image** (`docker/reviewer/Dockerfile`, linux/amd64) is built `FROM`
  debian:bookworm-slim pinned by digest — OpenClaw publishes no digest-pinnable
  sandbox base; its documented sandbox build is a local `FROM
  debian:bookworm-slim`, and this image carries the same package set (python3 is
  what OpenClaw's sandbox write/edit helpers run) — plus `git`, a `gh` with no
  credential of its own, Bun and Node, each at an exact version verified against
  a checksum from the trusted table. It has no entrypoint and its CMD is `sleep
  infinity`, matching how OpenClaw starts sandboxes (read-only root, tmpfs on
  `/tmp`, `/var/tmp`, `/run`). Its default `HOME`, `USERPROFILE`, `TMPDIR` and
  Bun/npm caches point under `/tmp/review`, a tmpfs discarded with the sandbox.
  It carries no credentials and no credential helpers.

  **The trusted table** (`docker/reviewer/runtime-matrix.json`) is maintained
  here and installed on the host. The reviewed checkout can neither extend it
  nor choose a download source.

  **The launcher** (`/opt/reviewer/bin/reviewer-launch`, from
  `scripts/reviewer/reviewer-launch.mjs`) is run explicitly, takes no
  arguments, and always builds the worktree the host mounted at `/workspace`.
  Before any repository code runs it reads the fixed table and the image's baked
  identity; takes the workflow, job and base branch only from the environment
  the HOST gave the sandbox at creation (`REVIEWER_CI_WORKFLOW`,
  `REVIEWER_CI_JOB`, `REVIEWER_CI_BASE`), refusing a caller that passes
  different values; refuses symlinked lockfiles and symlinked directories in the
  worktree; plans the job and the jobs it `needs`; resolves the reviewed
  commit's declarations (`packageManager`, `engines`, `.nvmrc`, `.node-version`,
  `.bun-version`, `.tool-versions`, each read with size bounds and inside the
  worktree) and every planned job's runtime pins to ONE matrix image with
  npm-semver range semantics; refuses unless that image is the one it is running
  in; creates its hermetic directories; builds the child environment from an
  allowlist (hermetic values, a fixed `PATH`, `LANG`, `LC_ALL`, `TERM`, `TZ`,
  `CI=true`); and runs the image's own Node and Bun at fixed paths to verify
  their versions. Then, job by job in dependency order, it removes what earlier
  jobs of the build created, refuses a worktree whose git configuration carries
  credential or auth settings (naming keys, never values), and runs every `run:`
  step as one script under `/bin/bash --noprofile --norc -eo pipefail` after
  re-checking the step's effective environment and that its resolved working
  directory stays inside the worktree. It reports `review-build-ok` only when
  every job in the closure ran, every step exited 0, and no lockfile in the
  worktree (outside `node_modules/` and `.git/`) changed, appeared or
  disappeared.

  **The planner** (`scripts/reviewer/ci-job.mjs`) bounds the workflow (bytes,
  YAML nodes counting every alias use, depth) before trusting it, requires
  printable-ASCII keys, and requires a `pull_request` trigger that covers the
  host-named base branch; a workflow CI would not run for the review is refused.
  It skips checkout, setup-bun, setup-node, socketdev (firewall-free), cache and
  upload-artifact only at reviewed commit SHAs and with inputs whose skip
  semantics were checked, names them in the verdict, and refuses every other
  action or ref. It refuses what it cannot reproduce (`${{ }}` expressions,
  conditions other than success/always, `continue-on-error`, matrices,
  containers) and credential-shaped or config-redirecting workflow env
  (`GH_TOKEN`, `*_TOKEN`, `*_SECRET`, `*_KEY`, `GIT_*`, `NPM_CONFIG_*`,
  `SSH_*`, `NODE_OPTIONS`, `BASH_ENV`, `LD_*`, proxies, ...). Ambiguous,
  conflicting, malformed and out-of-matrix runtime requirements are refused by
  name; an out-of-matrix refusal names the missing image (e.g. `missing image:
  node >=25 with bun 1.3.10`).

  The "no credential" statements cover the image, the environments the launcher
  builds and the worktree's git configuration; a credential that repository
  code itself supplies is outside them.

  This repository now declares `engines.node: "22.x"` (the Node major its CI
  runs), so it resolves to exactly one reviewer image.

  A dedicated CI job builds every matrix image and runs the image-level checks
  (A2 integrity and build-path refusals, including a caller naming another job,
  a `--workspace` argument and impostor binaries on the caller's `PATH`; A3
  hermetic defaults observed inside a build run the way OpenClaw runs the
  sandbox; A9 tokenless `gh`, a worktree git auth header and a workflow
  `GH_TOKEN`), then requires the A9 checks to fail on derived images carrying
  planted fake credentials.
