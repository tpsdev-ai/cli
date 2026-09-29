# Reviewer sandbox image (cli#425 section A). linux/amd64 only.
#
# BASE. debian:bookworm-slim, pinned by digest. OpenClaw publishes no
# digest-pinnable sandbox base: its default sandbox image
# (openclaw-sandbox:bookworm-slim) is built locally, and the build OpenClaw
# 2026.8.1 documents for npm installs is `FROM debian:bookworm-slim` (a floating
# tag) plus bash, ca-certificates, curl, git, jq, python3 and ripgrep. This image
# pins that same base by digest and carries the same packages (python3 is what
# OpenClaw's sandbox write/edit helpers run), plus Node, Bun and a TOKENLESS gh,
# each at an exact version verified against a checksum from the trusted table
# (docker/reviewer/runtime-matrix.json). scripts/reviewer/build-reviewer-image.mjs
# supplies every ARG from that table.
#
# RUN MODEL. OpenClaw 2026.8.1 creates the sandbox as
#   docker create --init --read-only --tmpfs /tmp --tmpfs /var/tmp --tmpfs /run
#     --network none --cap-drop ALL --security-opt no-new-privileges
#     --workdir /workspace -v <worktree>:/workspace --env-file <env> <image> sleep infinity
# and does not override ENTRYPOINT. So this image has no entrypoint and its CMD
# is `sleep infinity`. The review build is the explicit command
# /opt/reviewer/bin/reviewer-launch, which creates its own hermetic
# HOME/TMPDIR/cache directories under /tmp/review (a tmpfs) before any child
# process starts, and runs the CI job the host names.
#
# The image carries NO credentials and NO credential helpers. Authenticated
# GitHub operations happen only through the host-side github_review tool.

ARG BASE_REF=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
FROM --platform=linux/amd64 ${BASE_REF}

ARG NODE_VERSION
ARG NODE_SHA256
ARG BUN_VERSION
ARG BUN_SHA256
ARG GH_VERSION
ARG GH_SHA256
ARG JSYAML_VERSION
ARG JSYAML_SHA256
ARG REVIEWER_IMAGE_ID

ENV DEBIAN_FRONTEND=noninteractive

# OpenClaw's sandbox package set, plus the download/unpack tools and procps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq python3 ripgrep \
      xz-utils unzip procps coreutils \
 && rm -rf /var/lib/apt/lists/*

# Node — exact version, verified against the trusted checksum.
RUN set -eux; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f /tmp/node.tar.xz; \
    node -v; npm -v

# Bun — exact version, verified against the trusted checksum.
RUN set -eux; \
    curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip; \
    bun --version

# gh — exact version, verified against the trusted checksum, installed TOKENLESS.
RUN set -eux; \
    curl -fsSLo /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb"; \
    echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c -; \
    dpkg -i /tmp/gh.deb; rm -f /tmp/gh.deb; \
    gh --version

# js-yaml — the launcher's workflow parser, at the version bun.lock pins, from
# the npm registry tarball, verified against the trusted checksum.
RUN set -eux; \
    curl -fsSLo /tmp/js-yaml.tgz "https://registry.npmjs.org/js-yaml/-/js-yaml-${JSYAML_VERSION}.tgz"; \
    echo "${JSYAML_SHA256}  /tmp/js-yaml.tgz" | sha256sum -c -; \
    mkdir -p /opt/reviewer/lib/node_modules/js-yaml; \
    tar -xzf /tmp/js-yaml.tgz -C /opt/reviewer/lib/node_modules/js-yaml --strip-components=1 --no-same-owner; \
    rm -f /tmp/js-yaml.tgz

# The trusted launcher, its planner and resolver, the runtime table, the
# entry command and the sfw shim, baked in and root-owned.
COPY scripts/reviewer/reviewer-launch.mjs scripts/reviewer/resolve-runtime.mjs scripts/reviewer/ci-job.mjs /opt/reviewer/lib/
COPY docker/reviewer/runtime-matrix.json /opt/reviewer/runtime-matrix.json
COPY docker/reviewer/bin/reviewer-launch /opt/reviewer/bin/reviewer-launch
COPY docker/reviewer/shims/sfw /opt/reviewer/shims/sfw

# The image's identity (the matrix entry it was built for), baked read-only; and
# a non-root reviewer user (uid 1000, the reviewer VMs' host uid).
RUN set -eux; \
    test -n "${REVIEWER_IMAGE_ID}"; \
    printf '%s\n' "${REVIEWER_IMAGE_ID}" > /opt/reviewer/image-id; \
    chmod 0755 /opt/reviewer/bin/reviewer-launch /opt/reviewer/shims/sfw; \
    chmod -R go-w /opt/reviewer; \
    useradd -u 1000 -m -s /bin/bash reviewer

# Hermetic defaults (section A), identical to reviewer-launch.mjs HERMETIC:
# HOME, USERPROFILE, TMPDIR and the Bun/npm caches point under /tmp/review, a
# tmpfs discarded with the sandbox. The launcher creates the directories.
ENV REVIEWER_IMAGE_ID=${REVIEWER_IMAGE_ID} \
    HOME=/tmp/review/home \
    USERPROFILE=/tmp/review/home \
    TMPDIR=/tmp/review/tmp \
    TMP=/tmp/review/tmp \
    TEMP=/tmp/review/tmp \
    XDG_CACHE_HOME=/tmp/review/cache \
    XDG_CONFIG_HOME=/tmp/review/config \
    XDG_DATA_HOME=/tmp/review/data \
    XDG_STATE_HOME=/tmp/review/state \
    npm_config_cache=/tmp/review/cache/npm \
    BUN_INSTALL_CACHE_DIR=/tmp/review/cache/bun \
    BUN_TMPDIR=/tmp/review/tmp \
    PIP_CACHE_DIR=/tmp/review/cache/pip \
    GOCACHE=/tmp/review/cache/go

# The only persistent writable bind is the review worktree at /workspace.
WORKDIR /workspace
USER reviewer

CMD ["sleep", "infinity"]
