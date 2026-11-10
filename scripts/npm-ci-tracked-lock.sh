#!/usr/bin/env bash
# npm-ci-tracked-lock.sh — install a tracked package-lock.json through npm ci.
#
# Supply-chain contract (cli#837): this helper resolves packages only from the
# registry the release-age gate checked (scripts/check-dep-ages.mjs).
#   * REGISTRY: installs with --registry=<R>, where R is TPS_DEP_AGES_REGISTRY
#     when set, otherwise https://registry.npmjs.org. Under GITHUB_ACTIONS=true
#     the helper refuses TPS_DEP_AGES_REGISTRY, as the gate refuses it under
#     --ci. The helper runs before the install, so install scripts cannot unset
#     that signal first.
#   * CONFIG: --userconfig and --globalconfig point at empty files made here, so
#     no user or global npmrc applies. --no-update-notifier keeps npm's own
#     version check out of the registry request log.
#   * REFUSALS, before any fetch: an .npmrc in the fixture or install directory;
#     an npm_config_* environment variable outside the allowlist in
#     check_npm_config_env (a default-deny allowlist, so an npm option that is
#     not on it is refused; matching is case-insensitive because npm reads
#     environment keys case-insensitively; the allowlist holds names that
#     cannot change the fetch, and the user config path, which the --userconfig
#     flag above outranks); the unprefixed proxy variables https_proxy,
#     http_proxy and proxy (case-insensitive, presence test), which npm's
#     agent reads alongside no_proxy, and all_proxy, which the agent does not
#     read and which is refused as defence in depth; NODE_EXTRA_CA_CERTS and
#     NODE_TLS_REJECT_UNAUTHORIZED (presence test) and a non-empty NODE_OPTIONS;
#     and a lock entry that would install (not root, link:true, inBundle, file:
#     or workspace:) whose resolved URL is missing or is not under R, or whose
#     integrity is missing or is not sha512. no_proxy is left alone: it only
#     narrows proxying, and some runners set it.
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$1" != --via ]; then
  echo 'usage: npm-ci-tracked-lock.sh --via <npm|sfw> [--in-place] <tracked-dir> [<prefix>] [npm ci args...]' >&2
  exit 1
fi
case "$2" in
  npm) installer=(npm) ;;
  sfw) installer=(sfw npm) ;;
  *) echo "npm-ci-tracked-lock: unsupported installer: $2" >&2; exit 1 ;;
esac
shift 2
in_place=false
if [ "$1" = --in-place ]; then
  in_place=true
  shift
fi
fixture=$1
shift
lock="$fixture/package-lock.json"
if [ "$in_place" = true ]; then
  prefix=$fixture
else
  prefix=$1
  shift
fi
if ! command -v "${installer[0]}" >/dev/null; then
  echo "npm-ci-tracked-lock: ${installer[0]} is required; install refused" >&2
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "npm-ci-tracked-lock: node is required; install refused" >&2
  exit 1
fi
for arg in "$@"; do
  case "$arg" in
    --prefix*|-C*|--global*|-g|--location*)
      echo "npm-ci-tracked-lock: directory override refused: $arg" >&2
      exit 1
      ;;
    --ignore-scripts|--no-audit|--no-fund) ;;
    *)
      echo "npm-ci-tracked-lock: unsupported npm ci argument: $arg" >&2
      exit 1
      ;;
  esac
done
if [ "${GITHUB_ACTIONS:-}" = true ] && [ "${TPS_DEP_AGES_REGISTRY+set}" = set ]; then
  echo 'npm-ci-tracked-lock: Refusing TPS_DEP_AGES_REGISTRY under GitHub Actions; unset the registry override.' >&2
  exit 1
fi
registry="${TPS_DEP_AGES_REGISTRY:-https://registry.npmjs.org}"
registry="${registry%/}"

# Allowlisted because they cannot change what npm installs or the registry it
# fetches from: cache (an installable entry must carry integrity, so a
# pre-seeded cache cannot supply other content), log level, npm's own version,
# user agent, init template, and the user config path (the command-line
# --userconfig passed below outranks it).
# npm_config_globalconfig is refused: an environment-named global config is
# loaded even when --globalconfig is passed.
# Every other name, a future option included, is refused.
check_npm_config_env() {
  node - "$1" <<'NODE'
const registry = process.argv[2];
const allowed = new Set([
  "npm_config_cache",
  "npm_config_init_module",
  "npm_config_loglevel",
  "npm_config_npm_version",
  "npm_config_user_agent",
  "npm_config_userconfig",
]);
const names = Object.keys(process.env);
const refused = names
  .filter((name) => name.toLowerCase().startsWith("npm_config_") && !allowed.has(name.toLowerCase()))
  .sort();
if (refused.length > 0) {
  console.error(`npm-ci-tracked-lock: refusing npm_config_* variables that can change where npm fetches: ${refused.map((name) => JSON.stringify(name)).join(", ")}`);
  console.error(`npm-ci-tracked-lock: unset them; this helper installs only from ${registry}`);
  process.exit(3);
}
const routing = new Set([
  "http_proxy", "https_proxy", "proxy", "all_proxy", "node_extra_ca_certs", "node_tls_reject_unauthorized",
]);
// NODE_OPTIONS can load code into npm's Node process (--require) or switch its
// TLS trust (--use-openssl-ca); it is refused when non-empty. The names in
// `routing` are refused on presence.
const routingRefused = names
  .filter((name) => name.toLowerCase() === "node_options"
    ? process.env[name] !== ""
    : routing.has(name.toLowerCase()))
  .sort();
if (routingRefused.length > 0) {
  console.error(`npm-ci-tracked-lock: refusing environment variables that can redirect the fetch, load code into npm's process or change its trust anchors: ${routingRefused.map((name) => JSON.stringify(name)).join(", ")}`);
  console.error("npm-ci-tracked-lock: unset them for this install");
  process.exit(3);
}
NODE
}

# The committed lock is the one npm will read. Refuse an installable entry whose
# `resolved` URL is absent or not under R, or whose integrity is missing or is
# not sha512, before npm runs.
check_lock_registry() {
  node - "$1" "$2" "$3" <<'NODE'
const { readFileSync } = require("node:fs");
const [lockPath, registry, label] = process.argv.slice(2);
let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (err) {
  console.error(`npm-ci-tracked-lock: cannot parse ${label}: ${err?.message ?? err}`);
  process.exit(3);
}
const packages = lock?.packages;
if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
  console.error(`npm-ci-tracked-lock: ${label}: no packages map`);
  process.exit(3);
}
const prefix = `${registry.replace(/\/+$/, "")}/`;
const problems = [];
for (const [entry, value] of Object.entries(packages)) {
  if (entry === "") continue;
  const marker = entry.lastIndexOf("node_modules/");
  if (marker === -1 || (marker !== 0 && entry[marker - 1] !== "/")) continue;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${entry}: entry is not an object`);
    continue;
  }
  if (value.link === true || value.inBundle === true) continue;
  const resolved = value.resolved;
  if (typeof resolved !== "string" || resolved === "") {
    problems.push(`${entry}: no resolved URL (version ${JSON.stringify(value.version ?? null)})`);
    continue;
  }
  if (/^(?:file|workspace):/.test(resolved)) continue;
  const integrity = value.integrity;
  if (typeof integrity !== "string" || integrity === "") {
    problems.push(`${entry}: no integrity (version ${JSON.stringify(value.version ?? null)})`);
  } else {
    const dash = integrity.indexOf("-");
    const algorithm = dash === -1 ? integrity : integrity.slice(0, dash);
    if (algorithm !== "sha512") {
      problems.push(`${entry}: integrity algorithm is not sha512 (version ${JSON.stringify(value.version ?? null)}): ${algorithm}`);
    }
  }
  // `prefix` ends in "/", so this pins the host and not just a host prefix:
  // a different host, a host-suffix trick (R + ".evil.test") and a userinfo
  // trick (R + "@evil.test") all fail. A URL with an upper-case scheme fails
  // closed, because the match is case-sensitive.
  if (!resolved.startsWith(prefix)) {
    problems.push(`${entry}: resolved URL is not under ${registry}: ${resolved}`);
  }
}
if (problems.length > 0) {
  console.error(`npm-ci-tracked-lock: ${label}: refusing entries that do not resolve from ${registry}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("Regenerate the lock against that registry; the release-age gate checks packages from it.");
  process.exit(3);
}
NODE
}

for dir in "$fixture" "$prefix"; do
  if [ -e "$dir/.npmrc" ] || [ -L "$dir/.npmrc" ]; then
    echo "npm-ci-tracked-lock: .npmrc refused: $dir/.npmrc; remove it (this helper installs only from $registry)" >&2
    exit 1
  fi
done
check_npm_config_env "$registry"
revision=$(bash "${BASH_SOURCE[0]%/*}/lib/npm-ci-revision.sh")
echo "npm-ci-tracked-lock: reading fixture files from $revision"
if [ "$in_place" = false ] && { [ -e "$prefix" ] || [ -L "$prefix" ]; }; then
  if [ ! -d "$prefix" ] || [ ! -r "$prefix" ] || [ ! -x "$prefix" ]; then
    echo "npm-ci-tracked-lock: cannot inspect prefix: $prefix" >&2
    exit 1
  fi
  shopt -s dotglob nullglob
  prefix_entries=("$prefix"/*)
  if [ "${#prefix_entries[@]}" -ne 0 ]; then
    echo "npm-ci-tracked-lock: non-empty prefix refused: $prefix" >&2
    exit 1
  fi
fi
if [ -e "$prefix/npm-shrinkwrap.json" ] || [ -L "$prefix/npm-shrinkwrap.json" ]; then
  echo "npm-ci-tracked-lock: npm-shrinkwrap.json refused: $prefix/npm-shrinkwrap.json" >&2
  exit 1
fi
if [ "$in_place" = false ]; then
  mkdir -p -- "$prefix"
fi
committed=$(mktemp -d)
trap 'rm -f -- "$committed/package-lock.json" "$committed/package.json"; rmdir -- "$committed" 2>/dev/null || true' EXIT
for path in "$lock" "$fixture/package.json"; do
  if ! git show "$revision:$path" > "$committed/${path##*/}"; then
    echo "npm-ci-tracked-lock: cannot read committed file: $path" >&2
    exit 1
  fi
done
check_lock_registry "$committed/package-lock.json" "$registry" "$lock"
config_dir=$(mktemp -d)
userconfig="$config_dir/userconfig"
globalconfig="$config_dir/globalconfig"
: > "$userconfig"
: > "$globalconfig"
install_flags=(--registry="$registry" --userconfig="$userconfig" --globalconfig="$globalconfig" --no-update-notifier)
trap 'rm -f -- "$committed/package-lock.json" "$committed/package.json" "$userconfig" "$globalconfig"; rmdir -- "$committed" "$config_dir" 2>/dev/null || true' EXIT
if [ "$in_place" = true ]; then
  for file in package-lock.json package.json; do
    if ! cmp -- "$committed/$file" "$fixture/$file"; then
      echo "npm-ci-tracked-lock: working file differs from $revision: $fixture/$file" >&2
      exit 1
    fi
  done
  (cd -- "$fixture" && "${installer[@]}" ci "$@" "${install_flags[@]}")
else
  cp "$committed/package.json" "$committed/package-lock.json" "$prefix/"
  "${installer[@]}" ci --prefix "$prefix" "$@" "${install_flags[@]}"
fi
if ! cmp -- "$committed/package-lock.json" "$prefix/package-lock.json"; then
  exit 1
fi
