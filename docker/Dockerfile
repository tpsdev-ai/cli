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
# The TPS nono profiles, at the path docker/tps-office-supervisor.sh resolves the
# BUNDLED candidate from (cli#352 r3). Without them the image ships a bare-name
# launch nono cannot resolve — installNonoProfiles() runs only from `tps identity
# init`, which this container never runs — so the Landlock probe failed for the
# wrong reason (profile not found) and fail-closed refused EVERY office agent.
# The supervisor passes this absolute path to nono at both launch sites; the
# agent uid reads the file, so the COPY modes (644/755) must stay world-readable.
COPY packages/cli/nono-profiles/ /usr/local/share/tps/nono-profiles
WORKDIR /workspace
# Supervisor starts as root only for setup, then drops to tps-supervisor.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["tps-office-supervisor"]
# LAST instruction of the stage, in EXEC form with the interpreter from the
# read-only mount, and FAIL-CLOSED on absence (cli#345 r10). It requires the
# shipped path to be a regular file (not a symlink), captures the hash status
# itself (no pipeline whose exit is xargs's — dash has no pipefail), and compares
# with a single test. The baseline, the tools AND the shell come from the
# immutable builder stage; the only thing hashed is the shipped path, which comes
# solely from the pinned COPY above. A `base` RUN that removes, moves or dangles
# the shipped path now fails the BUILD.
RUN --mount=type=bind,from=nono-builder,source=/,target=/b,ro ["/b/bin/sh","-c","[ -f /usr/local/bin/nono ] && [ ! -L /usr/local/bin/nono ] || exit 1; h=$(/b/usr/bin/sha256sum /usr/local/bin/nono) || exit 1; /b/usr/bin/test \"${h%% *}\" = \"$(/b/bin/cat /b/nono.sha256)\""]
