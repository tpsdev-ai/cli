# Reviewer sandbox image (cli#425 section A).
#
# A digest-pinned sandbox base carrying the repository's build runtimes and a
# TOKENLESS `gh`. Every runtime is installed from the trusted table
# (docker/reviewer/runtime-matrix.json) with a verified checksum; the build
# passes the exact versions and checksums as build args read from that table.
#
# The image carries NO credentials and NO credential helpers. Authenticated
# GitHub operations happen only through the host-side github_review tool.
#
# Build with scripts/reviewer/build-reviewer-image.mjs, which supplies every
# ARG from the table.

ARG BASE_REF=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
FROM ${BASE_REF}

ARG NODE_VERSION
ARG NODE_SHA256
ARG BUN_VERSION
ARG BUN_SHA256
ARG GH_VERSION
ARG GH_SHA256
ARG REVIEWER_IMAGE_ID

ENV DEBIAN_FRONTEND=noninteractive

# git (repository operations), jq/procps (fixtures), plus the download tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils unzip git jq procps bash coreutils \
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

# The trusted launcher, its resolver and the runtime table, baked in.
COPY scripts/reviewer/reviewer-launch.mjs /opt/reviewer/reviewer-launch.mjs
COPY scripts/reviewer/resolve-runtime.mjs /opt/reviewer/resolve-runtime.mjs
COPY docker/reviewer/runtime-matrix.json /opt/reviewer/runtime-matrix.json

# A non-root reviewer user. No credentials, no credential helpers, anywhere.
RUN useradd -m -s /bin/bash reviewer \
 && mkdir -p /tmp/review \
 && chown -R reviewer:reviewer /tmp/review \
 && chmod 700 /tmp/review

# Hermetic defaults set BEFORE any child process starts (section A): HOME,
# USERPROFILE, TMPDIR and the Bun/npm caches point at container-local ephemeral
# paths. Host values are never inherited — the image defines them itself.
ENV REVIEWER_IMAGE_ID=${REVIEWER_IMAGE_ID} \
    HOME=/home/reviewer \
    USERPROFILE=/home/reviewer \
    TMPDIR=/tmp/review \
    TMP=/tmp/review \
    TEMP=/tmp/review \
    XDG_CACHE_HOME=/tmp/review/.cache \
    XDG_CONFIG_HOME=/tmp/review/.config \
    XDG_DATA_HOME=/tmp/review/.local/share \
    npm_config_cache=/tmp/review/npm-cache \
    BUN_INSTALL_CACHE_DIR=/tmp/review/bun-cache \
    BUN_TMPDIR=/tmp/review/bun-tmp \
    PIP_CACHE_DIR=/tmp/review/pip-cache \
    GOCACHE=/tmp/review/go-cache

# The only persistent writable bind is the review worktree, mounted at
# /workspace by the reviewer host. Nothing else is expected to persist.
WORKDIR /workspace
USER reviewer

ENTRYPOINT ["node", "/opt/reviewer/reviewer-launch.mjs"]

# TEMPORARY red-run probe: a credential helper must fail the A9 lane.
RUN git config --system credential.helper store
