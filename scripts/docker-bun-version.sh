#!/usr/bin/env bash
# Print the Bun version from the root package.json packageManager.
#
# Usage: BUN_VERSION="$(scripts/docker-bun-version.sh)" docker compose build
set -euo pipefail

root="${DOCKER_BUN_VERSION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

fail() { printf 'docker-bun-version: %s\n' "$1" >&2; exit 1; }

[ -f "$root/package.json" ] || fail "missing $root/package.json"

pin_tmp="$(mktemp)"
trap 'rm -f "$pin_tmp"' EXIT
node -e '
const fs = require("fs");
let pkg;
try { pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch (e) { console.error("package.json is not valid JSON: " + e.message); process.exit(2); }
const pm = pkg !== null && typeof pkg === "object" ? pkg.packageManager : undefined;
if (typeof pm === "string" && /[\u0000-\u001f\u007f-\u009f]/.test(pm)) {
  const shown = JSON.stringify(pm).replace(/[\u007f-\u009f]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  console.error("docker-bun-version: root package.json packageManager must be exactly one bun@<x.y.z> (got: " + shown + ")");
  process.exitCode = 2;
} else {
  process.stdout.write(typeof pm === "string" ? pm : "");
}
' "$root/package.json" >"$pin_tmp" || exit 1

# Node rejects control characters before Bash reads the value.
pm=""
IFS= read -r -d '' pm <"$pin_tmp" || true

# Match the whole value.
if ! [[ "$pm" =~ ^bun@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  shown="${pm//$'\n'/<newline>}"; shown="${shown//$'\r'/<cr>}"
  fail "root package.json packageManager must be exactly one bun@<x.y.z> (got: ${shown:-<missing>})"
fi

printf '%s\n' "${pm#bun@}"
