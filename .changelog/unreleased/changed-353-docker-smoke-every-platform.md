- **The Docker image workflow builds each platform natively, smokes that platform's OCI archive, and assembles one manifest index (Closes #353).**

  `linux/amd64` and `linux/arm64` build on their own runners, without QEMU.
  Each leg loads its own OCI archive and checks its nono against
  `docker/nono.sha256` and its `--version` against `.nono-version`, then uploads
  the archive. A `publish` job copies both archives with `--preserve-digests`
  into a local `registry:2`, assembles their index, and checks it lists exactly
  `PLATFORMS` with the smoked digests. Only `publish=true` logs in to ghcr.io
  and copies that index to the computed tags.
