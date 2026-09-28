# Reviewer sandbox image

The image a reviewer agent builds and tests a pull request inside. It carries the
repository's runtimes and a **tokenless** `gh`; the GitHub credential never
enters it.

## Pieces

- `Dockerfile` — built `FROM` a digest-pinned sandbox base, with `git`, Bun, Node
  and `gh`, each installed at an exact version and verified against a checksum
  from the trusted runtime table. The build reads every version and checksum as a
  build arg, so the table is the single source of truth.
- `runtime-matrix.json` — the **trusted** runtime table (base digest, per-tool
  exact versions and checksums, and the image matrix). Maintained here and
  installed on the host; the reviewed checkout can neither extend it nor choose a
  download source.
- `../../scripts/reviewer/resolve-runtime.mjs` — resolves the reviewed commit's
  declared requirements (`packageManager`, `engines`, runtime-version files,
  reconciled with its CI lanes) to ONE matrix entry, or refuses by name
  (`ambiguous`, `conflicting`, `out-of-matrix`). An out-of-matrix refusal names
  the missing image.
- `../../scripts/reviewer/reviewer-launch.mjs` — the trusted launcher: verifies
  the actual Bun/Node versions against the entry and the requirements, sets
  hermetic container-local `HOME`/`TMPDIR`/caches, then runs the repository's own
  frozen install, build and test commands.
- `../../scripts/reviewer/build-reviewer-image.mjs` — builds one matrix image
  with args read from the table, and prints the resulting image digest.
- `../../scripts/reviewer/image-checks.sh` — the image-level acceptance checks
  (A2 integrity and runtime-state refusals, A3 hermetic defaults and mounts, A9
  tokenless `gh`). Run by the `reviewer-image` CI job.

## Building

```bash
node scripts/reviewer/build-reviewer-image.mjs reviewer-node22-bun1310
bash scripts/reviewer/image-checks.sh reviewer-image:reviewer-node22-bun1310 reviewer-node22-bun1310
```

## Recording the digest

`build-reviewer-image.mjs` prints the built image digest; the CI job records each
one as the `reviewer-image-digests` artifact for the reviewer's host-managed
configuration. Registry publishing is a separate decision.
