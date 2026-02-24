# CHECKPOINT-25-office-manager

## Context
As we expand the branch office sandboxes, different agents need different tools (gh CLI, claude-code, specific node modules). Instead of bloating the base `node:22-alpine` image or writing complex bash scripts, we are introducing the "Office Manager" agent role.

## Objective
The Office Manager is an agent that runs immediately after a sandbox is provisioned. Its sole responsibility is reading a tool/dependency manifest and configuring the local sandbox environment before the actual worker agents are spawned inside it.

## Requirements
1. **Manifest Format:** Define a standard way (e.g., `WORKSPACE_MANIFEST.md` or similar) to specify required tools (apk packages, npm globals, curl binaries).
2. **Office Manager Agent:** A specialized, lightweight agent role that can parse the manifest and execute installation commands.
3. **Execution Pipeline:** 
   - Sandbox starts.
   - Office Manager runs, installs dependencies, verifies them, and writes a `.office-ready` marker.
   - Worker agents wait for `.office-ready` before starting.
4. **Nono Boundaries:** The Office Manager needs a specific `nono` profile (`tps-office-manager`) that allows network access and writes to system binaries/paths, unlike normal worker agents.

## Success Criteria
- The base Docker image remains light.
- A worker agent can request `gh` in its manifest, and it is available when the agent starts.
- The Office Manager safely handles missing dependencies and exits gracefully.

## Next Steps
Anvil: Please review this spec, define the `tps-office-manager` nono profile, and implement the manifest parsing logic.
