#!/usr/bin/env bash
# Print the Bun version in the ROOT package.json "packageManager" (e.g. 1.3.10),
# read with a JSON parser. Fails if the root pin is missing, malformed, or not
# exactly one complete bun@<x.y.z> value.
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
process.stdout.write(typeof pm === "string" ? pm : "");
' "$root/package.json" >"$pin_tmp" || fail "cannot read $root/package.json"

# read -d '' reads the value verbatim: $(...) would trim a trailing newline and
# hide it from the check below (cli#605).
pm=""
IFS= read -r -d '' pm <"$pin_tmp" || true

# Whole-value match, not a line-by-line grep. A packageManager holding two pins,
# on two lines, passed the line-based check because its first line looked like a
# pin; this admits exactly one complete bun@<x.y.z> — three numeric parts, no
# range, tag, prerelease or extra text.
if ! [[ "$pm" =~ ^bun@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  shown="${pm//$'\n'/<newline>}"; shown="${shown//$'\r'/<cr>}"
  fail "root package.json packageManager must be exactly one bun@<x.y.z> (got: ${shown:-<missing>})"
fi

printf '%s\n' "${pm#bun@}"
