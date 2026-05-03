#!/usr/bin/env node
import { checkScopeExpansion } from "./utils/helper";

const args = process.argv.slice(2);
let thresholdMultiplier = 3;
let ackScopeExpansion = false;
let checkOnly = false;

for (const arg of args) {
  if (arg === "--ack-scope-expansion") {
    ackScopeExpansion = true;
  } else if (arg === "--check-only") {
    checkOnly = true;
  } else if (arg.startsWith("--threshold=")) {
    const value = parseFloat(arg.split("=")[1]);
    if (!isNaN(value) && value >= 0) {
      thresholdMultiplier = value;
    }
  }
}

const result = checkScopeExpansion("anvil", thresholdMultiplier);

if (result.withinThreshold) {
  // Within threshold - exit successfully
  process.exit(0);
}

// Scope expansion detected
if (ackScopeExpansion) {
  // User has acknowledged the scope expansion
  if (checkOnly) {
    // In check-only mode, just output the info
    console.log(`Scope check: ${result.diffCount} files vs spec hint of ${result.hintCount} (threshold: ${result.threshold})`);
    process.exit(0);
  }
  
  // Otherwise, exit successfully (don't block)
  process.exit(0);
}

if (checkOnly) {
  // In check-only mode, output the warning and exit
  console.error(result.warningMessage || "Scope expansion detected");
  process.exit(0);
}

// Output the warning to stderr (does not block)
console.error("");
console.error("╔══════════════════════════════════════════════════════════════════╗");
console.error(`║  ⚠️  ${result.warningMessage}`);
console.error("╚══════════════════════════════════════════════════════════════════╝");
console.error("");

// Always exit 0 - never blocks commit
process.exit(0);