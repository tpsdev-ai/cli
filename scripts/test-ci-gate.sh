#!/usr/bin/env bash
# test-ci-gate.sh - Test script for the CG gate

set -euo pipefail

GATE_SCRIPT="scripts/mail-send-ci-gate.sh"

echo "Testing CI gate..."

# Test 1: Non-existent PR (should fail)
echo "Test 1: Non-existent PR (expecting failure)"
"$GATE_SCRIPT" test "DONE https://github.com/tpsdev-ai/cli/pull/999999" 2>&1
result=$?
if [[ $result -ne 0 ]]; then
    echo "Test 1 PASSED: gate correctly rejected non-existent PR (exit code $result)"
else
    echo "Test 1 FAILED: gate should have rejected non-existent PR but didn't"
    exit 1
fi

# Test 2: Known green PR (should pass)
echo "Test 2: Known green PR (expecting success)"
"$GATE_SCRIPT" test "DONE https://github.com/tpsdev-ai/cli/pull/271" 2>&1
result=$?
if [[ $result -eq 0 ]]; then
    echo "Test 2 PASSED: gate correctly allowed green PR (exit code $result)"
else
    echo "Test 2 FAILED: gate should have allowed green PR but rejected it (exit code $result)"
    exit 1
fi

# Test 3: Non-DONE message (should pass)
echo "Test 3: Non-DONE message (expecting success)"
"$GATE_SCRIPT" test "Just a regular message" 2>&1
result=$?
if [[ $result -eq 0 ]]; then
    echo "Test 3 PASSED: gate correctly allowed non-DONE message (exit code $result)"
else
    echo "Test 3 FAILED: gate should have allowed non-DONE message but rejected it (exit code $result)"
    exit 1
fi

echo "All tests passed!"
exit 0
