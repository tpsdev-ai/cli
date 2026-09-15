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
#   5. No remote fetch primitive. Any `ADD` that names a URL is refused (flags
#      may sit between `ADD` and the URL), and the archive rule covers
#      `releases/latest/download`: bytes pulled into the image over the network
#      bypass the pin no matter how they are fetched.
#   6. Provenance of the shipped bytes. Every `COPY --from=` must name the pinned
#      local stage `nono-builder` — a registry image ref (Docker resolves an
#      unknown name against a registry), or any other stage, is refused — and
#      the file may define only two stages, `nono-builder` and `base`, whitelisted
#      by name. A stage name is a provenance guarantee only if the set of stages
#      is closed.
#   7. Imperative fetch primitives (defence-in-depth). Declarative provenance is
#      not the whole surface: bytes can arrive inside a `RUN` (`curl`/`wget`/
#      `fetch(`/`nc`, or a pipe/redirect into `/usr/local/bin`) or through a
#      BuildKit `--mount=…,from=<operand>` whose operand is not a local stage.
#      Rule 7 refuses those, normalises path spellings (`//`, `/./`, quotes)
#      before matching, and folds heredoc (`<<EOF`) bodies into the owning `RUN`'s
#      logical line. It is a *heuristic*: no list of spellings whitelists a shell.
#      What backs it up is the capability removal (the runtime stage carries no
#      fetch tool) and rule 8.
#   8. THE POSITIVE ARTIFACT INVARIANT — the control, not a heuristic. The
#      `nono-builder` stage records the sha256 of the binary it built at the
#      asserted commit (`/nono.sha256`). The `base` stage copies that hash in, may
#      write `/usr/local/bin/nono` only via the pinned `COPY --from=nono-builder`,
#      and its LAST instruction must assert the shipped binary's sha256 equals the
#      recorded one. A rewrite by any primitive, spelling, variable or interpreter
#      changes the bytes and fails the *build*. Rule 8 asserts this invariant is
#      present and last; it does not try to enumerate how the path might be spelled.
#
# SCOPE: this gate governs IMAGE BUILD time — what the image is built from and
# what it asserts before it is saved. Runtime provenance (a container fetching
# nono after start) is a different control: image signing, no-network-at-run,
# read-only rootfs. This script deliberately does not attempt it.
#
# Pre-S4 (`git clone --depth 1 .../nono.git /tmp/nono`, no pin file) fails rules
# 1–3; a `--branch v0.74.0` fetch fails rule 3; the two-stage bypass fails rules
# 3 & 4; `COPY --from=<image>` and `ADD <url>` fail rules 5–6; a `RUN`
# `curl`/`wget`, a `--mount=…,from=<image>`, an `ADD --checksum=<url>`, a
# variable-directory or quoted-spelling rewrite of the shipped path, and a `base`
# stage that does not end with the hash assertion fail rules 7–8. All of those are
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

# Normalise a logical line for path matching: drop single/double quotes (so
# `/usr/local/bin/"nono"` and `"/usr/local/bin/"nono` collapse to one path),
# collapse `/./` and repeated slashes. Rules 7–8 use it so a spelling cannot hide
# a write to the shipped path.
nrm() { printf '%s' "$1" | sed -e "s/[\"']//g" -e 's|/\./|/|g' -e 's|//*|/|g'; }

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

  # The whole file as logical lines: comments dropped, `\` continuations joined,
  # and heredoc (`<<EOF`) bodies folded into the owning instruction — so a ref or
  # a fetch primitive cannot hide by wrapping or by moving into a heredoc body.
  # Rule 3 scans this, not just the nono stage: every stage may fetch source, and
  # the shipped binary is a `COPY --from=` in base.
  logical="$(awk -v q="'" '
    {
      if (hd != "") {
        cur = cur " " $0
        t = $0; sub(/^[[:space:]]+/, "", t)
        if (t == hd) { print cur; cur = ""; hd = "" }
        next
      }
      if ($0 ~ /^[[:space:]]*#/) next
      cur = $0
      while (cur ~ /\\[[:space:]]*$/) {
        if ((getline nxt) <= 0) break
        sub(/\\[[:space:]]*$/, "", cur)
        cur = cur " " nxt
      }
      re = "<<-?[[:space:]]*" q "?[A-Za-z_][A-Za-z0-9_]*" q "?"
      if (match(cur, re)) {
        hd = substr(cur, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", hd)
        gsub(q, "", hd)
        next
      }
      print cur
      cur = ""
    }
    END { if (cur != "") print cur }
  ' "$dockerfile")"

  # Rule 3 scans the logical text below with the one allowed HEAD assertion
  # removed; rules 7–8 use the raw logical text.

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
    printf '%s\n' "$code" | grep -qF '> /nono.sha256' \
      || err "nono stage does not record the built binary's sha256 (> /nono.sha256) — the base stage would have no baseline to verify the artifact against"

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

  # ── Rule 5 — no remote fetch primitive (ADD naming a URL anywhere) ──────────
  # Flags may sit between `ADD` and the URL (`ADD --checksum=<url> …`), so match
  # the instruction, then require a scheme anywhere on its logical line.
  if printf '%s\n' "$logical" | grep -E '^[[:space:]]*[Aa][Dd][Dd]([[:space:]]|$)' \
    | grep -qE '([A-Za-z][A-Za-z0-9+.-]*://|git@)'; then
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

  # ── Rule 7a — imperative fetch primitives inside a RUN (heredoc included) ──
  while IFS= read -r rline; do
    [ -z "$rline" ] && continue
    if printf '%s' "$rline" | grep -qE '(^|[^A-Za-z0-9_-])(curl|wget|fetch\(|nc[[:space:]])'; then
      err "docker/Dockerfile RUN uses a network fetch primitive (curl/wget/fetch/nc) — bytes must come from the pinned clone"
    fi
    if printf '%s' "$(nrm "$rline")" | grep -qE '(\||>>?)[^|]*/usr/local/bin'; then
      err "docker/Dockerfile RUN pipes or redirects into /usr/local/bin — the shipped path must come only from the pinned COPY"
    fi
  done < <(printf '%s\n' "$logical" | grep -E '^[[:space:]]*[Rr][Uu][Nn]([[:space:]]|$)' || true)

  # ── Rule 7b — --mount=…,from=<operand> must name the pinned local stage ────
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    while IFS= read -r op; do
      [ -z "$op" ] && continue
      [ "$op" = "nono-builder" ] \
        || err "docker/Dockerfile --mount uses from='$op' — the only permitted mount source is the pinned local stage nono-builder"
    done < <(printf '%s\n' "$m" | grep -oE 'from=[^,[:space:]]+' | sed 's/^from=//' || true)
  done < <(printf '%s\n' "$logical" | grep -oE -- '--mount=[^[:space:]]*' || true)

  # ── Rule 8 — base stage: shipped path only from the pinned COPY; the LAST
  #             instruction asserts the artifact hash (the real control) ───────
  # A shell cannot lie about a hash it is forced to assert. This is what closes
  # the variable-directory / quoted-spelling / interpreter writes that rules 5–7
  # can only partially see. The gate asserts the invariant EXISTS and is LAST.
  base="$(printf '%s\n' "$logical" | awk '
    /^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]/ { f = ($0 ~ /AS[[:space:]]+base([[:space:]]|$)/) }
    f { print }
  ')"
  base_lines=()
  while IFS= read -r bl; do
    if [ -n "$bl" ]; then base_lines+=("$bl"); fi
  done <<<"$base"
  if [ "${#base_lines[@]}" -eq 0 ]; then
    err "docker/Dockerfile: no 'FROM ... AS base' stage found"
  else
    nbase="${#base_lines[@]}"
    last_line="${base_lines[$((nbase - 1))]}"
    hash_copied=0
    pinned_copy=0
    other_path=0
    idx=0
    for bl in "${base_lines[@]}"; do
      idx=$((idx + 1))
      bn="$(nrm "$bl")"
      is_copy=0
      if printf '%s' "$bl" | grep -qE '^[[:space:]]*[Cc][Oo][Pp][Yy]([[:space:]]|$)'; then is_copy=1; fi
      is_pinned=0
      case "$bn" in *--from=nono-builder*) is_pinned=1 ;; esac
      if [ "$is_copy" = 1 ] && [ "$is_pinned" = 1 ]; then
        case "$bn" in *nono.sha256*) hash_copied=1 ;; esac
      fi
      case "$bn" in
        *"/usr/local/bin/nono"*)
          if [ "$is_copy" = 1 ] && [ "$is_pinned" = 1 ]; then
            pinned_copy=$((pinned_copy + 1))
          elif [ "$idx" != "$nbase" ]; then
            other_path=$((other_path + 1))
          fi
          ;;
      esac
    done
    [ "$hash_copied" = 1 ] \
      || err "docker/Dockerfile base does not COPY the pinned stage's sha256 (nono.sha256) — nothing verifies the shipped artifact"
    [ "$pinned_copy" = 1 ] \
      || err "docker/Dockerfile base must contain exactly one COPY --from=nono-builder onto /usr/local/bin/nono (found $pinned_copy)"
    [ "$other_path" = 0 ] \
      || err "docker/Dockerfile base names /usr/local/bin/nono on $other_path instruction(s) other than the pinned COPY and the final hash assertion — the shipped path may be written only by the pinned copy (matched with //, /./ and quotes normalised)"

    lastn="$(nrm "$last_line")"
    if ! printf '%s' "$last_line" | grep -qE '^[[:space:]]*[Rr][Uu][Nn]([[:space:]]|$)'; then
      err "docker/Dockerfile: the last instruction of base is not a RUN — the stage must END by asserting the shipped binary's hash"
    fi
    printf '%s' "$lastn" | grep -qF 'sha256sum' \
      || err "docker/Dockerfile: the last instruction of base does not hash the shipped binary (sha256sum) — the artifact invariant is missing"
    printf '%s' "$lastn" | grep -qF '/usr/local/bin/nono' \
      || err "docker/Dockerfile: the last instruction of base does not read the shipped path /usr/local/bin/nono"
    printf '%s' "$lastn" | grep -qF 'nono.sha256' \
      || err "docker/Dockerfile: the last instruction of base does not compare against the pinned sha256 (nono.sha256)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf 'check-nono-pin: FAILED\n' >&2
  exit 1
fi
printf 'check-nono-pin: OK (nono %s @ %s)\n' "$version" "$commit"
