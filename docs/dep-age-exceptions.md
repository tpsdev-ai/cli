# Dependency release-age exceptions

`scripts/check-dep-ages.mjs` checks external versions in `bun.lock` and tracked
`package-lock.json` files against `[install] minimumReleaseAge` in `bunfig.toml`.
For npm entries, it ages the package identified by a canonical registry tarball
URL, or recorded name@version without `resolved`, regardless of `inBundle`.
Versionless entries, URL/name/version disagreement, non-canonical registry URLs
(including query strings and percent-encoded path components), and git URLs are refused. The root,
`link: true`, and unencoded local `file:`/`workspace:` entries are skipped.
A v2 or v3 npm lockfile is required. The tracked `package-lock.json` files are:

- `plugins/openclaw-github-review/package-lock.json`
- `plugins/openclaw-tps-mail/package-lock.json`
- `test/fixtures/heartbeat-openclaw/package-lock.json`

The gate lists them with `git ls-files`, so a new tracked `package-lock.json` is read
without editing a list.

Each workflow `run:` block is split into physical lines. A line is flagged if
lowercasing and deleting backslashes and quotes reveals `npm`. A flagged block
must match a complete block pinned in the guard, after trailing-newline
normalization, or use these shapes without backticks, `$(` or multiline quotes:

- a helper call to `scripts/npm-ci-tracked-lock.sh` with a literal relative
  tracked directory and literal `--via npm` or `--via sfw`;
- `npm install -g` or `--global` followed by `<name>@<MAJOR.MINOR.PATCH>`, where
  each part is `0` or `[1-9][0-9]{0,8}`, with an optional literal
  `--registry=https://<host>[/<path>]` with a non-empty host; that line may not contain `$`, a backtick,
  a quote, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}` or `\`.

Refusals name the workflow, job, step and physical line. Variable or substitution
indirection such as `n${x}pm` and `$(printf n)pm` is outside this spelling check.
The guard follows repository scripts a workflow invokes by a literal path,
recursively, and local composite actions (`uses: ./...`). One scanner reads
workflow and action `run:` blocks and followed shell files: it splits clauses,
tracks `cd` through one resolution state, scans command substitutions (`$(...)`
and backtick spans, each with its own `cd` and nested state; one left-to-right
lexer carries quote state and span nesting together, so a substitution body
whose own lexing ends inside a quote or an unclosed span on its own logical line
is refused rather than skipped; a line that ends inside a quote at the end of a
run block or script is not refused (bash fails it with a syntax error), and the
passes that track quotes outside this lexer are a known limit (cli#975); a
substitution that does not close on its logical line is not followed; a
backslash-escaped double quote inside a double-quoted backtick body is not
unescaped before the body is scanned (cli#975)), resolves wrapped interpreters
and literal invocations, and follows scripts. A run block and a followed script
differ in their initial state: the install classifier runs on followed shell
files, and a run block's lines are screened by the physical-line check above.
An `npx` invocation in a workflow or composite-action `run:` block is not
classified by either pass. Here-document bodies are install-screened;
a here-document passed to a shell is refused rather than executed. It refuses what it cannot
resolve in the shapes it parses; a prefix assignment whose value the lexer
cannot close skips the clause, and nested quoting inside substitutions is a
known limit (cli#975). It passes an install only as a bounded global
install or when it resolves to a tracked lockfile, and any invocation or install
it cannot resolve is refused unless a reviewed allowlist entry names it; an
unresolved-invocation refusal names the step and the invocation path. It is not a boundary
against an author who deliberately evades it; review is, and a runtime npm
guard in CI is the structural fix, tracked separately (cli#948). Installs inside
followed JavaScript or TypeScript scripts and `npm run`/`bun run` targets in
`package.json` are not inspected. A `$'...'` span is a quote in which a backslash
escapes the next character and `$(` and a backtick are literal.

In a followed shell script, a logical line (continuations joined, word-boundary
comments stripped, here-document headers matched after comment stripping,
here-document bodies kept) is an install when, after lowercasing and deleting
backslashes and quotes, it contains `npx` as a word, or `npm` as a word followed
later by `ci`, `install`, `i`, `add`, `exec` or `x`. Every install clause on a
line is judged, in order. An install must use the tracked-lock helper, a bounded
global install, or bind to a tracked lockfile; an install line whose npm/npx
shape cannot be read is refused, as are `--no-package-lock`, `npx`, `npm exec`
and `npm x`, which do not read a lockfile. `--prefix`/`-C`/`--workspace`/`-w`
bind the install to the literal directory they name; a repeated directory flag
is refused. `scripts/npm-ci-tracked-lock.sh` is the approved install
implementation: its own lines are not screened by that classifier, and a helper
call is followed wherever it appears; a helper call is refused when the cwd or
its directory argument is not resolved.

An interpreter invocation is followed when its script argument resolves to a
repository file: a literal path; a variable the script binds exactly once to a
literal or script-directory-relative path; or a computed token whose literal
suffix (`$VAR/scripts/entry.sh`) names an existing repository file. That suffix
form is resolved without the single-assignment check and without an unknown-cwd
refusal. Any other computed, external, `-c`/`-s` or here-document-to-shell
invocation is refused unless it is on the reviewed allowlist, as is a wrapped
interpreter (`timeout`, `docker`, `su`, ...) whose payload is absent or
non-literal. A clause whose first word is an assignment whose value holds a
closed command substitution and that has more words after it is refused: a run
block offers computing the value on its own line, and a followed script offers computing the value on its
own line or naming the script in a reviewed entry. A `$(` the lexer reads as
literal text (single quotes, ANSI-C quoting, an escaped dollar) is not a
substitution, so the clause is scanned.
The allowlist pins the target, the single assignment to the variable and any
content source; a `source` must be derived from the pinned assignment, and an
entry whose assignment is an env-overridable default (`${VAR:-...}`) is refused.

An install or relative invocation after a non-literal `cd`, `pushd`, `popd` or
`cd -` is refused. The unknown cwd is sticky: a later relative `cd` keeps it
unknown, and only a `cd` to an absolute path inside the repository, to a path
anchored to the repository root, or to the script's own directory makes it
known again. A literal absolute `cd` outside the repository leaves it unknown.
A step whose `working-directory` is not a literal relative path (a `${{ ... }}`
expression or any other `$`, or a leading `/`) starts at an unknown cwd, so a
relative invocation or a cwd-bound install on it is unresolved, except a
computed token whose literal suffix names an existing repository file (see
above).

Installs inside followed JavaScript or TypeScript scripts, node `-e`/`-p` or
node here-document payloads, and `npm run`/`bun run` targets in `package.json`
are not inspected; here-document bodies are still install-screened. Helper
steps allow
`set -euo pipefail`, allowlisted quoted assignments with lowercase names (including
literal `node scripts/heartbeat-real-openclaw-lane.mjs --pin` substitutions), helper
calls and `GITHUB_ENV` echoes. Other helper-step lines are refused. The helper
limits install flags to `--ignore-scripts`, `--no-audit` and `--no-fund`.

The gate refuses tracked `npm-shrinkwrap.json` files anywhere in the repository.
The helper selects `GITHUB_SHA` under GitHub Actions (required to be 40 hex
characters), or `HEAD` locally, and logs that revision. It requires the selected
installer and reads the tracked directory's manifest and lock from that revision.
In prefix mode it requires an absent or empty prefix and copies those bytes there.
In `--in-place` mode it refuses `npm-shrinkwrap.json` in the install directory,
including untracked files, and verifies that the working `package-lock.json` and
`package.json` are byte-identical to the selected revision before installing there.
Both modes compare the installed directory's `package-lock.json` against the saved
revision bytes after the install. npm configuration is not checked (#837).
The heartbeat uses `--via sfw`; plugin installs use `--via npm`.
#818 defers hermetic local-registry adversarial coverage; the heartbeat CI step
already runs real npm through `sfw`.

Add one line per exception under the `## Exceptions` heading below, in this
exact shape:

```
- name@version | expires:YYYY-MM-DD | reason: why this version is needed now
```

- `name@version` must use valid semver and match a resolution in `bun.lock` or a
  tracked `package-lock.json` byte for byte
  (a scoped name keeps its `@scope/`, so `@scope/pkg@1.2.3`).
- `expires` is a real calendar date, `YYYY-MM-DD`, and is inclusive: the entry
  holds through the end of that day, UTC. It is a deadline to remove the
  exception (pin or upgrade to an aged version, or let the package bake).
- `reason` is free text saying why the fresh version cannot wait.

Everything above the heading is documentation. Every non-blank line under the
heading must be an entry; an entry that is undated, has an impossible or past
date, has no reason, uses invalid semver, or is absent from `bun.lock` and the tracked `package-lock.json` files fails the gate (exit 2).

## Workspace patterns

When `minimumReleaseAgeExcludes` is non-empty, the gate uses its local workspace
model of the root `package.json` `workspaces` patterns to decide which manifests
an exclusion applies to. It refuses these shapes:

- a `!`-negated pattern, because Bun 1.3.10 and 1.4.4 resolve some negated
  spellings to different workspace sets (with `["!packages/x", "packages/*"]`,
  1.3.10 installs `packages/x` and `packages/y`, and 1.4.4 installs only
  `packages/y`);
- a pattern mixing a `{...}` brace group with a `[...]` character class; the
  unbalanced spelling `packages/{a,[b}c]` is version-dependent too (1.3.10
  installs `packages/a`, 1.4.4 installs nothing);
- a brace group with an empty or `.` alternative at any nesting level, such as
  `packages/{a,}` or `packages/{a,{b,}}`; Bun applies only `packages/a` for
  `packages/{a,}`, while the local workspace model would also apply the parent
  directory `packages`;
- a pattern using glob syntax the gate does not model: a `(`, `)` or `|`
  outside a `[...]` class, an extended glob (`?(...)`, `*(...)`, `+(...)`,
  `@(...)`, `!(...)`), or any `..` inside a brace group (such as
  `packages/{1..3}` or `packages/{..,a}`). Bun 1.3.10 matches
  neither `packages/+([ab])` nor `packages/@(a|b)` and installs no workspace
  (`packages/@(a|b)` exits with `Workspace not found`), while 1.4.4 installs
  the matching directories.

List only the directories to include.

## Exceptions
