#!/usr/bin/env bash
# cli#341 S4 — fail-first gate: the Docker image must pin nono to an immutable
# commit and must never fetch a moving ref (branch, tag, or generated archive).
#
# This gate WHITELISTS. It asserts that one specific, known-good shape is present
# rather than enumerating bad refs to reject: a blacklist lets a fork's branch
# name, an unlisted tag, or a `--depth 1` clone slip through. Concretely it
# requires:
#
#   1. .nono-version exists and has EXACTLY two keys — `version` (informational,
#      a bare x.y.z) and `commit` (the pin: a 40-char lowercase hex commit id).
#      No other keys, no duplicate assignments.
#   2. docker/Dockerfile's nono stage sources .nono-version and checks out
#      ${commit} from the canonical repo, then asserts `git rev-parse HEAD` is
#      exactly ${commit}. (The required positive shape is tied to the nono stage.)
#   3. WHOLE-FILE ref scan: no line ANYWHERE in docker/Dockerfile may fetch a
#      moving ref — no --branch/--depth, no refs/heads|tags, no generated-archive
#      URL, no branch/HEAD name (the rev-parse assertion is the one allowed use of
#      HEAD). The scan is file-wide because the binary that actually ships comes
#      from a `COPY --from=` in the `base` stage: a second stage could otherwise
#      clone a moving ref while nono-builder stays perfectly pinned (the S4
#      bypass). The only permitted source clone in the file is the pinned one.
#      The bare tag-name rule stays scoped to nono lines so a version literal in
#      another stage cannot false-positive.
#   4. Canonical identity: any line naming a nono repository URL/ref must name
#      https://github.com/nolabs-ai/nono — a crafted second stage cloning a
#      look-alike at a "pinned-looking" sha is still a fail.
#   5. No remote fetch primitive. Any `ADD <url>` is refused, and the archive
#      rule covers `releases/latest/download`: bytes pulled into the image over
#      the network bypass the pin no matter how they are fetched.
#   6. Provenance of the shipped bytes. Every `COPY --from=` must name the pinned
#      local stage `nono-builder` — a registry image ref (Docker resolves an
#      unknown name against a registry), or any other stage, is refused — and
#      the file may define only two stages, `nono-builder` and `base`, whitelisted
#      by name. A stage name is a provenance guarantee only if the set of stages
#      is closed.
#
# Pre-S4 (`git clone --depth 1 .../nono.git /tmp/nono`, no pin file) fails rules
# 1–3; a `--branch v0.74.0` fetch fails rule 3; the two-stage bypass fails rules
# 3 & 4; `COPY --from=<image>` and `ADD <url>` fail rules 5–6. All of those are
# executable fixtures in scripts/test-check-nono-pin.sh.
#
# NONO_PIN_ROOT overrides the tree under test. It exists only for that fixture
# harness; it is unset in CI, where the gate reads the repository it lives in.
set -euo pipefail

root="${NONO_PIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
pin_file="$root/.nono-version"
dockerfile="$root/docker/Dockerfile"
fail=0

err() { printf 'check-nono-pin: %s\n' "$1" >&2; fail=1; }

canonical='https://github.com/nolabs-ai/nono'
allowed_assertion='test "$(git -C /tmp/nono rev-parse HEAD)" = "${commit}"'
allowed_clone='git clone --filter=blob:none https://github.com/nolabs-ai/nono /tmp/nono'
# The complete set of build stages the file may define (rule 6b), by name.
allowed_stages='nono-builder base'

# ── Rule 1: the pin file has exactly two keys, both well-formed ───────────────
version=""
commit=""
if [ ! -f "$pin_file" ]; then
  err "missing pin file: .nono-version"
else
  # Every non-comment, non-blank line must be `version=` or `commit=`.
  while IFS= read -r line; do
    case "$line" in
      '' | \#*) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      version | commit) ;;
      *) err ".nono-version: unexpected line '${line}' (only version= and commit= are allowed)" ;;
    esac
  done <"$pin_file"

  count_key() { grep -cE "^$1=" "$pin_file" || true; }

  if [ "$(count_key version)" != "1" ]; then
    err ".nono-version: expected exactly one 'version=' line, found $(count_key version)"
  fi
  if [ "$(count_key commit)" != "1" ]; then
    err ".nono-version: expected exactly one 'commit=' line, found $(count_key commit)"
  fi

  version="$(sed -n 's/^version=//p' "$pin_file" | head -n1)"
  commit="$(sed -n 's/^commit=//p' "$pin_file" | head -n1)"

  if [ -n "$version" ] && ! printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    err ".nono-version: version '$version' is not a bare x.y.z (no leading 'v', no suffix)"
  fi
  if ! printf '%s' "$commit" | grep -qE '^[0-9a-f]{40}$'; then
    err ".nono-version: commit '$commit' is not a 40-char lowercase hex commit id"
  fi
fi

# ── Rules 2–4: docker/Dockerfile ─────────────────────────────────────────────
if [ ! -f "$dockerfile" ]; then
  err "missing docker/Dockerfile"
else
  stage="$(awk '
    /^FROM[[:space:]]/ {
      if ($0 ~ /AS[[:space:]]+nono-builder([[:space:]]|$)/) { f = 1; print; next }
      f = 0
    }
    f { print }
  ' "$dockerfile")"

  # The whole file as logical lines: comments dropped and `\` continuations
  # joined, so a ref cannot hide by wrapping across physical lines. Rule 3 scans
  # this, not just the nono stage — every stage may fetch source, and the shipped
  # binary is a `COPY --from=` in base.
  logical="$(awk '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      while (line ~ /\\[[:space:]]*$/) {
        if ((getline nxt) <= 0) break
        sub(/\\[[:space:]]*$/, "", line)
        line = line " " nxt
      }
      print line
    }
  ' "$dockerfile")"

  # ── Rule 2 — the required positive shape (nono stage only) ─────────────────
  if [ -z "$stage" ]; then
    err "docker/Dockerfile: no 'FROM ... AS nono-builder' stage found"
  else
    # Full-line comments are prose; they must not trip the scans.
    code="$(printf '%s\n' "$stage" | grep -vE '^[[:space:]]*#')"

    printf '%s\n' "$code" | grep -qF 'COPY .nono-version' \
      || err "nono stage does not COPY .nono-version — the pin must be sourced from the repo file"
    printf '%s\n' "$code" | grep -qF '. /tmp/.nono-version' \
      || err "nono stage does not source .nono-version — \${commit} would be undefined"
    printf '%s\n' "$code" | grep -qF "$canonical" \
      || err "nono stage does not clone the canonical repo $canonical"
    printf '%s\n' "$code" | grep -qF 'checkout "${commit}"' \
      || err "nono stage does not contain the pinned checkout: git -C /tmp/nono checkout \"\${commit}\""
    printf '%s\n' "$code" | grep -qF "$allowed_assertion" \
      || err "nono stage does not assert the checkout: $allowed_assertion"

    # Rule 3 (tag-name clause) — scoped to the nono stage, so a version literal
    # in another stage (e.g. `@tpsdev-ai/agent@v1.2.3`) never false-positives.
    if printf '%s\n' "$code" | grep -vF 'rev-parse HEAD' | grep -qE 'v[0-9]+\.[0-9]+\.[0-9]+'; then
      err "nono stage names a tag (mutable) — the commit id is the pin"
    fi
  fi

  # ── Rule 3 — whole-file ref scan ───────────────────────────────────────────
  # Drop the one allowed HEAD assertion, then any remaining ref name is illicit.
  scan="$(printf '%s\n' "$logical" | awk -v a="$allowed_assertion" '
    {
      i = index($0, a)
      while (i > 0) {
        $0 = substr($0, 1, i - 1) substr($0, i + length(a))
        i = index($0, a)
      }
      print
    }')"
  if printf '%s\n' "$scan" | grep -qE '(^|[^A-Za-z0-9_-])(master|main|HEAD)([^A-Za-z0-9_-]|$)'; then
    err "docker/Dockerfile names a branch/HEAD ref — outside the rev-parse assertion only the pinned commit id may be referenced"
  fi
  if printf '%s\n' "$scan" | grep -qE 'refs/heads/|refs/tags/|--branch([[:space:]]|=)|--depth([[:space:]]|=)'; then
    err "docker/Dockerfile fetches a moving ref (refs/*, --branch, --depth) — pin the commit instead"
  fi
  if printf '%s\n' "$scan" | grep -qE 'archive/refs|releases/(latest/)?download'; then
    err "docker/Dockerfile fetches a generated archive (mutable bytes) — clone and check out the commit"
  fi

  # ── Rule 3 (clone clause) — the only permitted source clone is the pinned one
  offenders="$(printf '%s\n' "$logical" \
    | grep -E '(^|[^A-Za-z0-9_-])git[[:space:]]+clone([^A-Za-z0-9_-]|$)' \
    | grep -vF "$allowed_clone" || true)"
  if [ -n "$offenders" ]; then
    err "docker/Dockerfile contains a git clone other than the pinned canonical clone — no stage may fetch nono (or anything) from a moving source"
  fi

  # ── Rule 4 — canonical identity: every nono repository ref must be canonical
  refs="$(printf '%s\n' "$logical" \
    | grep -oE "([A-Za-z][A-Za-z0-9+.-]*://|git@)[^[:space:]\"']+" \
    | grep -E '[/:]nono(\.git)?$' || true)"
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    norm="${ref%.git}"
    norm="${norm%/}"
    if [ "$norm" != "$canonical" ]; then
      err "docker/Dockerfile names a non-canonical nono source '$ref' — the only allowed nono source is $canonical"
    fi
  done <<<"$refs"

  # ── Rule 5 — no remote fetch primitive (ADD with a URL) ────────────────────
  if printf '%s\n' "$logical" | grep -qE '^[[:space:]]*[Aa][Dd][Dd][[:space:]]+[A-Za-z][A-Za-z0-9+.-]*://'; then
    err "docker/Dockerfile uses ADD with a remote URL — bytes fetched into the image bypass the pin"
  fi

  # ── Rule 6a — only the pinned local stage may supply bytes via COPY --from ─
  while IFS= read -r from; do
    [ -z "$from" ] && continue
    if [ "$from" != "nono-builder" ]; then
      err "docker/Dockerfile COPY --from='$from' — the only permitted source stage is nono-builder (no image refs, no other stages)"
    fi
  done < <(printf '%s\n' "$logical" \
    | grep -oiE 'COPY[[:space:]]+--from[=[:space:]][^[:space:]]+' \
    | sed -E 's/.*--from//; s/^[=[:space:]]+//' || true)

  # ── Rule 6b — the set of build stages is closed and whitelisted by name ────
  while IFS= read -r fromline; do
    [ -z "$fromline" ] && continue
    sname="$(printf '%s\n' "$fromline" | awk '
      { line = $0; sub(/^[[:space:]]+/, "", line); n = split(line, p, /[[:space:]]+/)
        name = ""
        for (i = 2; i <= n; i++) if (tolower(p[i]) == "as" && i + 1 <= n) { name = p[i+1]; break }
        print name }')"
    if [ -z "$sname" ]; then
      err "docker/Dockerfile: FROM without an explicit 'AS <stage>' name — the file may define only the nono-builder and base stages"
      continue
    fi
    case " $allowed_stages " in
      *" $sname "*) ;;
      *) err "docker/Dockerfile: unexpected build stage '$sname' — only 'nono-builder' and 'base' are permitted" ;;
    esac
  done < <(printf '%s\n' "$logical" | grep -E '^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]' || true)
fi

if [ "$fail" -ne 0 ]; then
  printf 'check-nono-pin: FAILED\n' >&2
  exit 1
fi
printf 'check-nono-pin: OK (nono %s @ %s)\n' "$version" "$commit"
