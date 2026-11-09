- **The Docker image workflow builds once, smokes every platform in `PLATFORMS` from that archive, and pushes the same bytes (Closes #353).**

  One build writes an OCI archive; each platform is loaded from it, its nono is
  checked against `docker/nono.sha256`, and its `--version` against
  `.nono-version`. A red smoke means a missing hash line, a hash mismatch, a
  wrong version, or a failed run. The archive is copied to a local registry on
  every run; `publish=false` skips the GHCR image push (the Actions cache is
  still written).
