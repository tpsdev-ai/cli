- **A checksum-pinned reviewer sandbox image, a trusted runtime table and a launcher that refuses to run repository code on an unverified runtime or an unreproducible CI job (Refs #425).**

  The reviewer environment now has its own image and launch path, defined in
  this repository.

  **The image** (`docker/reviewer/Dockerfile`, linux/amd64) is built `FROM`
  debian:bookworm-slim pinned by digest — OpenClaw publishes no digest-pinnable
  sandbox base; its documented sandbox build is a local `FROM
  debian:bookworm-slim`, and this image carries the same package set (python3 is
  what OpenClaw's sandbox write/edit helpers run) — plus `git`, a TOKENLESS
  `gh`, Bun and Node, each at an exact version verified against a checksum from
  the trusted table. It has no entrypoint and its CMD is `sleep infinity`,
  matching how OpenClaw starts sandboxes (read-only root, tmpfs on `/tmp`,
  `/var/tmp`, `/run`). Its default `HOME`, `USERPROFILE`, `TMPDIR` and Bun/npm
  caches point under `/tmp/review`, a tmpfs discarded with the sandbox. It
  carries no credentials and no credential helpers.

  **The trusted table** (`docker/reviewer/runtime-matrix.json`) is maintained
  here and installed on the host. The reviewed checkout can neither extend it
  nor choose a download source.

  **The launcher** (`/opt/reviewer/bin/reviewer-launch`, from
  `scripts/reviewer/reviewer-launch.mjs`) is run explicitly. Before any
  repository code runs it reads the fixed table and the image's baked identity,
  plans the CI job the HOST names (`REVIEWER_CI_WORKFLOW` + `REVIEWER_CI_JOB`),
  resolves the reviewed commit's declarations (`packageManager`, `engines`,
  `.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions`) and the job's
  runtime pins to ONE matrix image with npm-semver range semantics, refuses
  unless that image is the one it is running in, creates its hermetic
  directories, builds the child environment from an allowlist (hermetic values,
  `PATH`, `LANG`, `LC_ALL`, `TERM`, `TZ`, `CI=true`) and verifies the actual Bun
  and Node. Only then does it run every `run:` step of the job, in order, each
  as one script in its working directory under `bash --noprofile --norc -eo
  pipefail`, and it reports `review-build-ok` only when every step exits 0 and
  no lockfile changed. Ambiguous, conflicting, malformed and out-of-matrix
  requirements are refused by name; an out-of-matrix refusal names the missing
  image (e.g. `missing image: node >=25 with bun 1.3.10`). Workflow features the
  launcher cannot reproduce (other actions, `${{ }}` expressions, conditions
  other than success/always, `continue-on-error`, matrices, containers) are
  refused, and the actions it skips are named in its verdict.

  This repository now declares `engines.node: "22.x"` (the Node major its CI
  runs), so it resolves to exactly one reviewer image.

  A dedicated CI job builds every matrix image and runs the image-level checks
  (A2 integrity and build-path refusals, A3 hermetic defaults observed inside a
  build run the way OpenClaw runs the sandbox, A9 tokenless `gh`), then requires
  the A9 checks to fail on derived images carrying planted fake credentials.
