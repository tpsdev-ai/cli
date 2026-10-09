#!/usr/bin/env bash
# Print the Bun version in the ROOT package.json "packageManager" (e.g. 1.3.10),
# read with a JSON parser. Fails if the root pin is missing, malformed, or not
# bun@<x.y.z>.
#
# Usage: BUN_VERSION="$(scripts/docker-bun-version.sh)" docker compose build
set -euo pipefail

root="${DOCKER_BUN_VERSION_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

fail() { printf 'docker-bun-version: %s\n' "$1" >&2; exit 1; }

[ -f "$root/package.json" ] || fail "missing $root/package.json"

pm="$(node -e '
const fs = require("fs");
let pkg;
try { pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch (e) { console.error("package.json is not valid JSON: " + e.message); process.exit(2); }
const pm = pkg !== null && typeof pkg === "object" ? pkg.packageManager : undefined;
process.stdout.write(typeof pm === "string" ? pm : "");
' "$root/package.json")" || fail "cannot read $root/package.json"

printf '%s' "$pm" | grep -qE '^bun@[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "root package.json packageManager must be bun@<x.y.z> (got: ${pm:-<missing>})"

printf '%s\n' "${pm#bun@}"
