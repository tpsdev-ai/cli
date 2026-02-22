# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TPS, please **DO NOT** file a public issue. 

Instead, please send an email to **security@tps.dev**. 

We will acknowledge receipt of your vulnerability report within 48 hours and strive to send you regular updates about our progress. If you're interested in helping us develop a fix, please let us know in your report.

## Scope

TPS is a security-focused project. The following components are in scope for our security program:

- The Noise_IK transport layer (`src/utils/noise-ik-transport.ts`, `src/utils/ws-noise-transport.ts`)
- The cryptographic identity primitives (`src/utils/identity.ts`)
- Mail signing and verification
- The branch daemon connection state and mail handler isolation boundaries
- Input sanitization (`src/utils/sanitizer.ts`) and path traversal protections

## Out of Scope

- The security of third-party agent runtimes (e.g., vulnerabilities in Ollama, Claude Code, or OpenClaw itself)
- Privilege escalation vulnerabilities on the host machine if running without `nono` isolation
- Any vulnerabilities requiring physical access to the host or branch VM

## Coordinated Disclosure

If you report a vulnerability, we ask that you do not disclose it publicly until a fix has been released. We will work with you to ensure a timely fix and coordinated public disclosure.
