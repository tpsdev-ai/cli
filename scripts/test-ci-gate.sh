#!/usr/bin/env bash
# test-ci-gate.sh - Test script for the CI gate

set -uo pipefail

GATE_SCRIPT="$(dirname "$0")/mail-send-ci-gate.sh"

# Gate uses TPS_AGENT_ID via gh-as; set a sensible default for the test harness.
export TPS_AGENT_ID="${TPS_AGENT_ID:-anvil}"

echo "Testing CI gate..."

# Test 1: Non-existent PR (gate should reject)
echo "Test 1: Non-existent PR (expecting failure)"
result=0
"$GATE_SCRIPT" test "DONE https://github.com/tpsdev-ai/cli/pull/999999" 2>&1 || result=$?
if [[ $result -ne 0 ]]; then
    echo "Test 1 PASSED: gate correctly rejected non-existent PR (exit code $result)"
else
    echo "Test 1 FAILED: gate should have rejected non-existent PR but did not"
    exit 1
fi

# Test 2: Known green PR (gate should allow)
echo "Test 2: Known green PR (expecting success)"
result=0
"$GATE_SCRIPT" test "DONE https://github.com/tpsdev-ai/cli/pull/271" 2>&1 || result=$?
if [[ $result -eq 0 ]]; then
    echo "Test 2 PASSED: gate correctly allowed green PR (exit code $result)"
else
    echo "Test 2 FAILED: gate should have allowed green PR but rejected it (exit code $result)"
    exit 1
fi

# Test 3: Non-DONE message (gate should pass through)
echo "Test 3: Non-DONE message (expecting success)"
result=0
"$GATE_SCRIPT" test "Just a regular message" 2>&1 || result=$?
if [[ $result -eq 0 ]]; then
    echo "Test 3 PASSED: gate correctly allowed non-DONE message (exit code $result)"
else
    echo "Test 3 FAILED: gate should have allowed non-DONE message but rejected it (exit code $result)"
    exit 1
fi

echo "All tests passed!"
exit 0
