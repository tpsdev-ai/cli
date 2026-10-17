# TPS Soundstage Image
# Purpose-built for branch office smoke testing and soundstage mode.
#
# Includes: Node 22, OpenClaw CLI, bash, git
# No outbound network needed at runtime.

FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# Install system deps needed by openclaw (koffi needs cmake + build tools)
RUN apk add --no-cache git bash cmake make g++ python3 linux-headers && \
    npm install -g openclaw && \
    openclaw --version && \
    npm cache clean --force && \
    # Remove build-only deps to reduce size
    apk del cmake make g++ python3 linux-headers

WORKDIR /workspace

RUN openclaw --version && which bash && which node
