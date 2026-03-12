# Remote OpenClaw Agent Bootstrap (Anvil VM Dogfood)

## Goal
Capture the real bootstrap steps and failure modes discovered while bringing up Anvil on `tps-anvil.exe.xyz`, in the repo where remote-branch implementation work actually lives.

## Task for Anvil
Update this document with:

1. **Current manual flow**
   - VM provisioning assumptions
   - required repos and local paths
   - OpenClaw install/config steps
   - Discord binding setup
   - Flair tunnel setup
   - GitHub auth/bootstrap

2. **Sharp edges discovered**
   - mail path mismatch
   - foreground `office connect` fragility
   - shell/bootstrap drift (`GH_TOKEN`, `PATH`, Bun)
   - invalid assumptions about shared `ops` paths on remote branches
   - anything else encountered directly on the VM

3. **Productization recommendations**
   Split clearly into:
   - **TPS**
   - **Flair**
   - **Operator / local machine setup**

4. **Follow-up implementation tasks**
   Keep it small and actionable.

## Constraints
- This is a documentation / task-shaping pass, not a code change.
- Keep it grounded in what actually happened.
- Prefer practical checklists over essays.
- If something is unclear, mark it as an open question.

## Output
When updated and actionable, report DONE.
