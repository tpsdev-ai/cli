- **A checksum-pinned reviewer sandbox image, a trusted runtime table and a launcher that builds a PR the way its CI job would, as advisory evidence for the reviewer, without any credential or host access reachable from the review (Refs #425).**

  The reviewer environment now has its own image and launch path, defined in
  this repository. Its verdict, `review-build-ok`, is advisory evidence for the
  reviewer, not a merge gate: CI remains the gate on every PR. The boundary it
  holds is that no credential and no host access are reachable from the review;
  how well it predicts CI is best effort, with its known limits documented in
  `docker/reviewer/README.md`.

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
  It carries no credentials and no configured credential helpers.

  **The trusted table** (`docker/reviewer/runtime-matrix.json`) is maintained
  here and installed on the host. The reviewed checkout can neither extend it
  nor choose a download source.

  **The launcher** (`/opt/reviewer/bin/reviewer-launch`, from
  `scripts/reviewer/reviewer-launch.mjs`) is run explicitly. Build mode takes no
  arguments and always builds the worktree the host mounted at `/workspace`
  (`--self-check` is the only other mode). Before any repository code runs it
  reads the fixed table and the image's baked identity; takes the workflow, job
  and base branch only from the environment the HOST gave the sandbox at
  creation (`REVIEWER_CI_WORKFLOW`, `REVIEWER_CI_JOB`, `REVIEWER_CI_BASE`),
  refusing a caller that passes different values; refuses symlinked lockfiles
  and symlinked directories in the worktree; plans the job and the jobs it
  `needs`; resolves the reviewed commit's declarations (`packageManager`,
  `engines`, `.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions`, each
  read with size bounds and inside the worktree) and every planned job's runtime
  pins to ONE matrix image with npm-semver range semantics; refuses unless that
  image is the one it is running in; builds the child environment from an
  allowlist (hermetic values, a fixed `PATH`, `LANG`, `LC_ALL`, `TERM`, `TZ`,
  `CI=true`); and runs the image's own Node and Bun at fixed paths to verify
  their versions. Then, job by job in dependency order, it removes what earlier
  jobs of the build created, gives each job a fresh `HOME`/`TMPDIR`/cache root,
  refuses a worktree whose effective git configuration leaves a documented safe
  baseline (no `core.fsmonitor`, `core.hooksPath`, `core.pager`, `protocol.*`,
  `url.*.insteadOf`, credential helpers, auth headers, ...) or whose repository
  holds hooks, and refuses unless the worktree is the fresh clone
  `actions/checkout` would give CI. It runs every `run:` step as one script under
  `/bin/bash --noprofile --norc -eo pipefail` after re-checking the step's
  effective environment and that its resolved working directory stays inside
  the worktree, enforces `timeout-minutes` (the job's, default 360, and each
  step's), and kills what a job left running when it ends. After every job it
  refuses symlinked lockfiles and symlinked directories. It reports
  `review-build-ok` only when every job in the closure ran, every step exited 0,
  and no lockfile in the worktree (outside `node_modules/` and `.git/`)
  changed, appeared or disappeared.

  **The planner** (`scripts/reviewer/ci-job.mjs`) bounds the workflow (bytes,
  YAML nodes counting every alias use, depth) before trusting it, requires
  printable-ASCII keys, and requires a `pull_request` trigger that covers the
  host-named base branch; a workflow CI would not run for the review is refused.
  Every job must begin with `actions/checkout` and run on `ubuntu-latest` or
  `ubuntu-24.04`. It skips checkout (first step only), setup-bun and setup-node
  (exact versions only), socketdev (firewall-free), cache (path and key
  required) and upload-artifact (path required; unique, valid name) only at
  reviewed commit SHAs, with every input the real action needs and only input
  values whose skip is equivalent; it names them in the verdict and refuses
  every other action, ref or input. It refuses what it cannot reproduce (`${{ }}`
  expressions, conditions other than success/always, `continue-on-error`,
  matrices, containers) and credential-shaped or config-redirecting workflow env
  (`GH_TOKEN`, `*_TOKEN`, `*_SECRET`, `*_KEY`, `GIT_*`, `NPM_CONFIG_*`, `SSH_*`,
  `NODE_OPTIONS`, `BASH_ENV`, `LD_*`, proxies, ...). Ambiguous, conflicting,
  malformed and out-of-matrix runtime requirements are refused by name; an
  out-of-matrix refusal names the missing image (e.g. `missing image: node >=25
  with bun 1.3.10`).

  The "no credential" statements cover the image, the environments the launcher
  builds and the worktree's git configuration; a credential that repository
  code itself supplies is outside them. The host assignment's integrity relies
  on the deployed sandbox denying same-user process-memory writes, a
  host-integration check in PR 3.

  This repository now declares `engines.node: "22.x"` (the Node major its CI
  runs), so it resolves to exactly one reviewer image.

  A dedicated CI job builds every matrix image and runs the image-level checks
  (A2 integrity and build-path refusals, including a caller naming another job,
  a `--workspace` argument, impostor binaries on the caller's `PATH`, an
  enforced `timeout-minutes`, a worktree that is not a fresh clone and a git
  `core.fsmonitor`; A3 hermetic defaults observed inside a build run the way
  OpenClaw runs the sandbox; A9 tokenless `gh`, a worktree git auth header and a
  workflow `GH_TOKEN`), then requires the A9 checks to fail on derived images
  carrying planted fake credentials.
