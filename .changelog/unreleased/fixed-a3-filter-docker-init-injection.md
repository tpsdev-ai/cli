- **The A3 container diff filter now accepts only Docker's own `/usr/sbin/docker-init` as a legitimate binary injection (Refs #425, cli#428).**

  An image launched with `--init` has `docker-init` injected at
  `/usr/sbin/docker-init`. The A3 filesystem check (the container diff filter
  in `scripts/reviewer/filter-container-diff.mjs`) now whitelists exactly that
  path and reject, refusing any other addition under `usr/sbin` or changes
  under `/etc` that do not carry the `docker-init` injection. The filter in
  `scripts/reviewer/image-checks.sh` is updated accordingly, and the A3
  container diff tests (in
  `packages/cli/test/reviewer/container-diff.test.ts`) validate that only this
  injection passes and all others are rejected.
