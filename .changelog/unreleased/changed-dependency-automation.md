- **Renovate uses the shared TPS preset and excludes `@tpsdev-ai/**` dependencies from automated updates.**

  Maintainer note: `.github/renovate.json` extends the shared tpsdev-ai preset,
  and Renovate does not bump `@tpsdev-ai/**` dependencies, which are this
  repository's own release packages, validated and released together by the
  release workflow. Its configuration is reviewed separately from the Semgrep scan: the
  Semgrep step excludes `.github/renovate.json`, and Renovate configuration is
  checked in pull-request review.

  (Refs #423)
