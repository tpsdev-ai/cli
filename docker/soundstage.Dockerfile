# TPS Soundstage Image
# Purpose-built for branch office smoke testing and soundstage mode.
#
# Includes: Node 22, OpenClaw CLI, bash, git
# No outbound network needed at runtime.

FROM node:22-alpine

# Install system deps needed by openclaw (koffi needs cmake + build tools)
RUN apk add --no-cache git bash cmake make g++ python3 linux-headers && \
    npm install -g openclaw && \
    openclaw --version && \
    npm cache clean --force && \
    # Remove build-only deps to reduce size
    apk del cmake make g++ python3 linux-headers

WORKDIR /workspace

RUN openclaw --version && which bash && which node
