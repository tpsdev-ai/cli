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
# ^ Rule 2b: the sha256 recording is the LAST instruction of this stage and lives
# in the SAME logical line as the pinned checkout+build — a later RUN cannot swap
# the binary and recompute the baseline.

FROM node:24-bookworm-slim AS base
ARG TPS_VERSION=0.5.4
RUN npm install -g @tpsdev-ai/agent@${TPS_VERSION}
# The shipped binary comes only from the pinned stage. The baseline sha256 is
# NOT copied in — it is read from a read-only bind mount of the builder stage by
# the assertion below, so no instruction in this stage can rewrite it.
COPY --from=nono-builder /usr/local/bin/nono /usr/local/bin/nono
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
# LAST instruction of the stage, in EXEC form: the interpreter itself comes from
# the read-only bind mount. It reads the baseline (/nono.sha256), every tool
# (sha256sum, cut, xargs, test, cat) AND the shell (/b/bin/sh) from the immutable
# builder stage, and carries EXACTLY ONE --mount — so no runtime-stage state can
# alter what it compares, nor who runs the comparison (a writable /bin/sh, a
# SHELL directive, an ENV PATH, or a second mount shadowing /b or the shipped
# path all fail the gate). The only thing hashed is the shipped path, which comes
# solely from the pinned COPY above (cli#341 S4 r9).
RUN --mount=type=bind,from=nono-builder,source=/,target=/b,ro ["/b/bin/sh","-c","/b/usr/bin/sha256sum /usr/local/bin/nono | /b/usr/bin/cut -d' ' -f1 | /b/usr/bin/xargs -I{} /b/usr/bin/test {} = \"$(/b/bin/cat /b/nono.sha256)\""]
