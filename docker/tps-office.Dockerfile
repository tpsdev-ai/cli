# CP32 Branch Office image
FROM node:22-bookworm-slim AS base

# Install nono + bootstrap dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bash git cmake make g++ python3 \
  && npm i -g nono @tpsdev-ai/cli openclaw \
  && npm cache clean --force \
  && apt-get purge -y cmake make g++ python3 \
  && apt-get autoremove -y && apt-get clean 

# Install CLI binaries used in branch offices
RUN npm i -g @anthropic-ai/claude-code codex gemini-cli || true

# Copy nono profiles and scripts
WORKDIR /opt/openclaw
COPY nono-profiles /opt/openclaw/nono-profiles
COPY docker/entrypoint.sh /opt/openclaw/entrypoint.sh
RUN chmod +x /opt/openclaw/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/opt/openclaw/entrypoint.sh"]
