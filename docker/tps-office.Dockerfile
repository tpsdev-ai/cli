# CP32 Branch Office image
FROM node:24-bookworm-slim AS base

# Security: no root package installs after this layer
# Harden: disable npm update notifier, reduce attack surface
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1

# Install nono + bootstrap dependencies (build tools purged after)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bash git cmake make g++ python3 \
  && npm i -g nono @tpsdev-ai/cli openclaw \
  && npm cache clean --force \
  && apt-get purge -y cmake make g++ python3 \
  && apt-get autoremove -y \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /root/.npm

# Install CLI agent runtimes
RUN npm i -g @anthropic-ai/claude-code codex gemini-cli || true \
  && npm cache clean --force \
  && rm -rf /root/.npm

# Copy nono profiles and entrypoint
WORKDIR /opt/openclaw
COPY nono-profiles /opt/openclaw/nono-profiles
COPY docker/entrypoint.sh /opt/openclaw/entrypoint.sh
RUN chmod +x /opt/openclaw/entrypoint.sh

# Non-root user
RUN useradd -m -s /bin/bash tps
WORKDIR /workspace
RUN chown tps:tps /workspace
USER tps

# Drop capabilities — entrypoint doesn't need any
# (enforced at docker run with --cap-drop=ALL, but document intent here)
ENTRYPOINT ["/opt/openclaw/entrypoint.sh"]
