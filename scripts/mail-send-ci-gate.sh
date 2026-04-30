#!/bin/bash
# mail-send-ci-gate.sh - Gate for sending DONE mails based on CI status
#
# Usage: ./mail-send-ci-gate.sh <recipient> "<mail body>"
#
# The script checks if the mail body contains a DONE PR URL pattern.
# If it does, it verifies that all CI checks for that PR are successful.
# If not, it refuses to send the mail and exits with a non-zero status.
#
# Environment variables:
#   TPS_AGENT_ID: The agent ID sending the mail (required for gh-as authentication).
#   TPS_VAULT_KEY: The vault key for TPS (should be set in the environment).
#   SKIP_CI_GATE: If set to "1", skip the CI check (for emergency override).
#
# The script sends the mail via the TPS CLI if the gate passes or if it's not a DONE mail.

set -euo pipefail

# Function to print error message and exit with error.
die() {
    echo "ERROR: $*" >&2
    exit 1
}

# Check arguments.
if [ $# -lt 2 ]; then
    die "Usage: $0 <recipient> '<mail body>'"
fi

RECIPIENT="$1"
shift
BODY="$*"

# Get the agent ID from the environment.
AGENT_ID="${TPS_AGENT_ID:-}"
if [ -z "$AGENT_ID" ]; then
    die "Environment variable TPS_AGENT_ID is not set."
fi

# Check if we should skip the CI gate.
if [ "${SKIP_CI_GATE:-}" = "1" ]; then
    echo "Warning: SKIP_CI_GATE is set, bypassing CI check." >&2
    # We'll still send the mail below.
    SKIP_CHECK=1
else
    SKIP_CHECK=0
fi

# Check if the body contains a DONE PR URL pattern.
# We look for the pattern: DONE <pr-url>
# We'll extract the URL using a simple regex: DONE (https?://[^ ]+)
# But note: the PR URL might be at the end of the line or have punctuation after.
# We'll use a more robust pattern: DONE <URL> where URL is a string that starts with http and contains a slash.
# We'll use grep to extract the first match.
if echo "$BODY" | grep -q -E 'DONE[[:space:]]+https?://[^[:space:]]+'; then
    # Extract the first URL after DONE.
    PR_URL=$(echo "$BODY" | grep -o -E 'DONE[[:space:]]+https?://[^[:space:]]+' | head -1 | sed -e 's/DONE[[:space:]]*//')
    echo "Detected DONE PR URL: $PR_URL" >&2

    if [ $SKIP_CHECK -eq 0 ]; then
        # Check the CI status for this PR.
        # We'll use gh-as to get the check runs.
        # We'll use the command: gh-as <AGENT_ID> pr checks <PR_URL> --json state
        # But note: the pr checks subcommand might not be available in all versions of gh.
        # Alternatively, we can use: gh-as <AGENT_ID> pr view <PR_URL> --json statusCheckRollup
        # We'll try the pr view method first.

        # We need to get the PR number from the URL to use with gh-as pr view.
        # The URL is like: https://github.com/tpsdev-ai/flair/pull/310
        # We can extract the PR number from the URL.
        PR_NUMBER=$(echo "$PR_URL" | grep -o -E '[0-9]+$')
        if [ -z "$PR_NUMBER" ]; then
            die "Could not extract PR number from URL: $PR_URL"
        fi

        # We'll use the gh-as command to get the PR view with statusCheckRollup.
        # We'll run: gh-as <AGENT_ID> pr view <PR_NUMBER> --repo <repo> --json statusCheckRollup
        # But we need to know the repo. We can extract it from the URL.
        # The URL is: https://github.com/<owner>/<repo>/pull/<number>
        # We'll extract the owner and repo.
        REPO_PATH=$(echo "$PR_URL" | sed -e 's|https://github.com/||' -e 's|/pull/[0-9]*$||')
        if [ -z "$REPO_PATH" ]; then
            die "Could not extract repo path from URL: $PR_URL"
        fi

        # Now run gh-as.
        # We'll use the JSON output and check the statusCheckRollup.
        # We'll look for any check that is not SUCCESS.
        # We'll use jq to parse the JSON.

        # We'll run the command and capture the output.
        # We'll set a timeout for the gh-as command.
        CHECK_OUTPUT=$(gh-as "$AGENT_ID" pr view "$PR_NUMBER" --repo "$REPO_PATH" --json statusCheckRollup 2>/dev/null) || \
            die "Failed to fetch PR status for $PR_URL using gh-as"

        # Now parse the JSON to see if all checks are SUCCESS.
        # We'll use jq to check the statusCheckRollup. We need to look at the checks array.
        # The statusCheckRollup object has a state field that can be SUCCESS, PENDING, etc.
        # But we also want to check individual checks? The statusCheckRollup gives an overall state.
        # According to the GitHub API, the statusCheckRollup state is:
        #   - SUCCESS: All checks have completed successfully.
        #   - PENDING: Some checks are still pending.
        #   - FAILURE: At least one check has failed.
        #   - ERROR: There was an error running the check.
        #   - TIMEOUT: The check timed out.
        #   - CANCELLED: The check was cancelled.
        #   - NEUTRAL: The check is neither success nor failure.
        #   - SKIPPED: The check was skipped.
        #   - ACTION_REQUIRED: The check requires action.
        # We'll consider the gate passed only if the state is SUCCESS.
        # We'll also check if there are any pending checks? The spec says: if any check is FAILURE/PENDING, refuse.
        # So we should also reject if the state is PENDING.

        # We'll extract the state from the statusCheckRollup.
        STATE=$(echo "$CHECK_OUTPUT" | jq -r '.statusCheckRollup.state // empty')
        if [ -z "$STATE" ]; then
            die "Could not determine CI state for PR $PR_URL"
        fi

        echo "CI state for PR $PR_URL: $STATE" >&2

        if [ "$STATE" != "SUCCESS" ]; then
            # Refuse to send.
            echo "CI not green for PR $PR_URL (state: $STATE). Refusing to send DONE mail." >&2
            exit 1
        fi

        # If we get here, the CI is green.
        echo "CI check passed for PR $PR_URL." >&2
    fi
else
    # Not a DONE mail, we can send without CI check.
    echo "No DONE PR URL found in mail body. Sending without CI check." >&2
fi

# If we reach here, we are allowed to send the mail.
# We'll send the mail using the TPS CLI.
# We'll use the TPS_VAULT_KEY and TPS_AGENT_ID from the environment.
# We'll run the command from the tps repo root.

# We are already in the tps repo root.
# We'll use the bun command to run the TPS CLI.
# We'll send the mail.

# We'll use the same environment variables that we have.
# We'll run: TPS_VAULT_KEY=$TPS_VAULT_KEY TPS_AGENT_ID=$TPS_AGENT_ID bun run packages/cli/dist/bin/tps.js mail send "$RECIPIENT" "$BODY"

# We'll execute the command.
exec TPS_VAULT_KEY="$TPS_VAULT_KEY" TPS_AGENT_ID="$TPS_AGENT_ID" bun run packages/cli/dist/bin/tps.js mail send "$RECIPIENT" "$BODY"
