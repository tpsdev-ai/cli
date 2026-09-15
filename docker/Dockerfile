FROM rust:bookworm AS nono-builder
RUN apt-get update && apt-get install -y libdbus-1-dev pkg-config curl
# nono version + checksum live in .nono-version at the repo root (the single
# source of truth; cli#341 S1's CI gate reads the same file). Fetch the tagged
# release tarball, verify its sha256, then build — no unpinned branch clone.
COPY .nono-version /tmp/.nono-version
RUN set -eux; \
    . /tmp/.nono-version; \
    curl -fsSL -o /tmp/nono.tar.gz "https://github.com/nolabs-ai/nono/archive/refs/tags/v${version}.tar.gz"; \
    printf '%s  %s\n' "${sha256}" /tmp/nono.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/nono.tar.gz -C /tmp; \
    cd "/tmp/nono-${version}"; \
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
