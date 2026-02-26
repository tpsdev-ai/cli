FROM rust:bookworm AS nono-builder
RUN apt-get update && apt-get install -y libdbus-1-dev pkg-config
RUN git clone --depth 1 https://github.com/lukehinds/nono.git /tmp/nono && cd /tmp/nono && cargo build --release

FROM node:24-bookworm-slim AS base
ARG TPS_VERSION=0.4.2
RUN npm install -g @tpsdev-ai/cli@${TPS_VERSION}
COPY --from=nono-builder /tmp/nono/target/release/nono /usr/local/bin/nono
RUN apt-get update && apt-get install -y --no-install-recommends git curl jq ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -r tps && useradd -r -g tps -m -s /bin/bash tps
COPY docker/tps-office-supervisor.sh /usr/local/bin/tps-office-supervisor
USER tps
WORKDIR /workspace
ENTRYPOINT ["tps-office-supervisor"]
