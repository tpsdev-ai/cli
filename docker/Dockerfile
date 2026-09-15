FROM rust:bookworm AS nono-builder
RUN apt-get update && apt-get install -y libdbus-1-dev pkg-config git ca-certificates
# The nono pin lives in .nono-version at the repo root (single source of truth;
# cli#341 S1's CI gate reads the same file). Clone the canonical repo, check out
# the pinned commit, assert we got exactly it, then build. The commit id is the
# content hash; no branch, tag or generated-archive URL is ever fetched.
# https://github.com/nolabs-ai/nono is the canonical repo; the older
# always-further/nono only redirects to it — do not "correct" the URL back.
COPY .nono-version /tmp/.nono-version
RUN set -eux; \
    . /tmp/.nono-version; \
    git clone --filter=blob:none https://github.com/nolabs-ai/nono /tmp/nono; \
    git -C /tmp/nono checkout "${commit}"; \
    test "$(git -C /tmp/nono rev-parse HEAD)" = "${commit}"; \
    cd /tmp/nono; \
    cargo build --release -p nono-cli; \
    cp target/release/nono /usr/local/bin/nono

FROM node:24-bookworm-slim AS base
ARG TPS_VERSION=0.5.4
RUN npm install -g @tpsdev-ai/agent@${TPS_VERSION}
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
RUN apt-get update && apt-get install -y --no-install-recommends git curl jq ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/*
RUN groupadd -r tps && useradd -r -g tps -m -s /bin/bash tps
COPY docker/tps-office-supervisor.sh /usr/local/bin/tps-office-supervisor
WORKDIR /workspace
# Supervisor starts as root only for setup, then drops to tps-supervisor.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["tps-office-supervisor"]
