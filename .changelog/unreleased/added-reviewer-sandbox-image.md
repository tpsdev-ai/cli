- **A checksum-pinned reviewer sandbox image, a trusted runtime table and a launcher that refuses to run repository code on an unverified runtime (Refs #425).**

  The reviewer environment now has its own image and launch path, defined in
  this repository.

  **The image** (`docker/reviewer/Dockerfile`) is built `FROM` a digest-pinned
  sandbox base and carries `git`, a TOKENLESS `gh`, Bun and Node. Every runtime
  is installed at an exact version and verified against a checksum from the
  trusted table; the build takes those versions and checksums as build args read
  from the table, so a wrong value cannot be passed silently. The image bakes in
  hermetic defaults — `HOME`, `USERPROFILE`, `TMPDIR` and the Bun/npm caches all
  point at container-local ephemeral paths before any child starts — and carries
  no credentials and no credential helpers. `gh` has no authenticated path.

  **The trusted table** (`docker/reviewer/runtime-matrix.json`) is maintained
  here and installed on the host. The reviewed checkout can neither extend it
  nor choose a download source.

  **The resolver** (`scripts/reviewer/resolve-runtime.mjs`) reads the reviewed
  commit's own declarations — `packageManager`, `engines` and the applicable
  runtime-version files (`.nvmrc`, `.node-version`, `.bun-version`,
  `.tool-versions`) — reconciles them with its CI lanes, and resolves ranges to
  ONE explicit matrix entry. Ambiguous, conflicting or out-of-matrix
  requirements are refused by name; an out-of-matrix refusal names the missing
  image, and there is no `latest`, no fallback runtime and no unchecked download.

  **The launcher** (`scripts/reviewer/reviewer-launch.mjs`) records the actual
  Bun and Node versions before any repository code runs and verifies them against
  the selected entry AND the repository's requirements; a mismatch, a missing
  support, a checksum failure or an inability to establish CI equivalence stops
  the build. It then sets the hermetic environment and runs the repository's OWN
  frozen installation, build and test commands, derived from its CI lanes — a
  repository launcher is preserved, never replaced by a blanket test command.

  A dedicated CI job builds every matrix image and runs the image-level checks
  (A2 integrity and runtime-state refusals, A3 hermetic defaults and mounts, A9
  tokenless `gh`), recording each image digest.
