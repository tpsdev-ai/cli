# SKILL: verification-before-completion

## Description
Use when about to claim work is complete, fixed, or passing, before committing, creating PRs, or reporting status to Flint/Nathan. Requires running verification commands and confirming output before making any success claims; evidence before assertions always.

## Core Principle: Evidence Before Claims
Claiming work is complete without fresh verification evidence is a failure of duty.

**NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**
If you haven't run the verification command in *this* turn, you cannot claim it passes.

## The Process
BEFORE claiming any status or expressing satisfaction:

1. **IDENTIFY:** What command or manual check proves this claim?
2. **RUN:** Execute the FULL command (fresh, complete).
3. **READ:** Capture full output, check exit code, count failures.
4. **VERIFY:** Does the output actually confirm the claim?
   - If NO: State actual status with evidence (the error log).
   - If YES: State claim WITH evidence (the pass log).
5. **ONLY THEN:** Make the claim (e.g., "Tests pass", "Feature works").

## Verification Matrix

| Claim | Required Evidence | Not Sufficient |
| :--- | :--- | :--- |
| **Tests pass** | `bun test` output showing 0 failures | "I think I fixed it" |
| **Build succeeds** | `bun run build` exit code 0 | "Linter is clean" |
| **Bug fixed** | Reproduction script now passes | "Changed the code" |
| **PR Ready** | `gh pr status` showing Green CI | "I pushed the changes" |
| **Beads Updated** | `bd list --status in_progress` shows the change | "I ran the command" |

## Forbidden Phrases (Until Verified)
- "Should work now"
- "Seems to be fixed"
- "I'm confident it's done"
- "Great! That's finished."

## Handoff Requirements
When reporting DONE to Flint or Nathan, you MUST include:
1. The command you ran to verify.
2. The specific output that proves success (e.g., "32 passing").
3. A link to the PR or the commit hash.

**Skip any step = failure to verify.**
No shortcuts. Run the command. Read the output. Then claim the result.
