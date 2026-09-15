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
    cp target/release/nono /usr/local/bin/nono; \
    sha256sum target/release/nono | cut -d' ' -f1 > /nono.sha256

FROM node:24-bookworm-slim AS base
ARG TPS_VERSION=0.5.4
RUN npm install -g @tpsdev-ai/agent@${TPS_VERSION}
# The shipped binary AND the sha256 the pinned stage recorded for exactly those
# bytes. The last instruction of this stage re-derives the hash from the path a
# fetcher would have to write and fails the BUILD if it differs (cli#341 S4).
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
COPY --from=nono-builder /nono.sha256 /tmp/nono.sha256
# Runtime stage: only what the shipped workload needs. This image RUNS AGENTS
# (docker/tps-office-supervisor.sh starts `tps-agent start` per agent user), and
# the agent toolchain shells out to git — packages/agent/src/runtime/event-loop.ts,
# packages/cli/src/utils/workspace-provider.ts, agent-lifecycle.ts,
# generators/brief.ts, commands/git.ts — so git stays. ca-certificates stays for
# git over TLS (openssl comes with it). curl/wget/python3/nc/socat/php are never
# installed: the runtime stage carries no general-purpose fetcher.
# Capability removal is best-effort hardening; the control is the sha256
# assertion at the end of this stage — whatever is installed, the bytes shipped
# at /usr/local/bin/nono must hash to the pinned build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ca-certificates libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -r tps && useradd -r -g tps -m -s /bin/bash tps
COPY docker/tps-office-supervisor.sh /usr/local/bin/tps-office-supervisor
WORKDIR /workspace
# Supervisor starts as root only for setup, then drops to tps-supervisor.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["tps-office-supervisor"]
# LAST instruction of the stage — after every other RUN/COPY, so it runs whatever
# they were. The shipped binary must be the bytes the pinned stage built; any
# rewrite of this path, by any primitive, spelling, variable or interpreter,
# changes its hash and fails THIS BUILD rather than a grep. The tools are called
# by absolute path so a PATH shadow in an earlier ENV/RUN cannot substitute
# them, and the baseline hash file cannot be rewritten within the stage — so the
# comparison cannot be made vacuous (cli#341 S4 r7).
RUN test "$(/usr/bin/sha256sum /usr/local/bin/nono | /usr/bin/cut -d' ' -f1)" = "$(/bin/cat /tmp/nono.sha256)" \
 && rm -f /tmp/nono.sha256
