# Fake nono — test double

This directory contains a bash-based fake of the [nono](https://nono.sh) CLI
used by TPS tests. It simulates the nono interface without kernel enforcement.

## Why it's here

Docker CI has access only to the `dtrt-dev/tps` repo. Bundling the fake here
keeps the test suite self-contained — no external repo mount required.

The canonical copy lives in `dtrt-dev/ops/fakes/nono/`. If you update the fake
there, copy it here too (`cp` the binary and the JSON profiles) and commit both.

## What it does

- Parses `nono run --profile <name|path> [--workdir <path>] -- <cmd>`
- Resolves `profile validate [--strict] <path>` (exit 0/1), which TPS calls
  before every launch — validate-or-FAIL
- Loads profiles from `profiles/` as JSON (no kernel policy is applied)
- Logs every invocation to `$NONO_FAKE_LOG` so tests can assert on calls
- Executes the wrapped command directly (no sandbox enforcement)

The fake reports `0.74.0-fake` by default, i.e. **above** the TPS floor
(`NONO_MIN_VERSION = 0.70.0`). Refusal-below-floor is tested by overriding
`NONO_FAKE_VERSION=0.69.0`, not by shipping a fake that TPS would reject.

## Environment variables

| Variable | Purpose |
|---|---|
| `NONO_FAKE_LOG` | Path to log file (default: `/tmp/nono-fake.log`) |
| `NONO_FAKE_VERSION` | Version string to report (default: `0.74.0-fake`) |
| `NONO_FAKE_VALIDATE_FAIL` | Make `profile validate` exit non-zero |
| `NONO_FAKE_CANARY` | Path to canary file for enforcement tests |

## Security note

This fake provides **zero** isolation. It is for unit/integration testing only.
Real enforcement (landlock/Seatbelt) is tested separately in
`test/nono-sandbox.mutation.test.ts`, gated on a pinned `NONO_BIN`, and in the
profile check script `scripts/check-nono-profiles.sh`.
