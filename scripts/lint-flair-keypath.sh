#!/usr/bin/env bash
# lint-flair-keypath.sh — fail if createFlairClient is called without explicit keyPath
# Pattern: createFlairClient(x, y) with only 2 args = missing keyPath.
# createFlairClient(x, y, z) = fine.

set -euo pipefail

SEARCH_DIR="${1:-packages/cli/src}"
FAIL=0

while IFS= read -r -d '' file; do
  # Extract all createFlairClient(...) calls; flag any with exactly 2 args (no 3rd comma inside)
  while IFS= read -r match; do
    # Count commas inside the parens — 1 comma = 2 args = bad
    inner="${match#*createFlairClient(}"
    inner="${inner%)*}"
    commas=$(echo "$inner" | tr -cd ',' | wc -c | tr -d ' ')
    if [ "$commas" -lt 2 ]; then
      echo "❌ Missing keyPath in $file: createFlairClient($inner)"
      FAIL=1
    fi
  done < <(grep -oP 'createFlairClient\([^)]+\)' "$file" || true)
done < <(find "$SEARCH_DIR" -name "*.ts" -not -path "*/node_modules/*" -not -name "*.d.ts" -print0)

if [ "$FAIL" -eq 0 ]; then
  echo "✅ All createFlairClient calls include explicit keyPath"
fi

exit "$FAIL"
