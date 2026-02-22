# Fake nono — test double

This directory contains a bash-based fake of the [nono](https://nono.sh) CLI
used by TPS tests. It simulates the nono interface without kernel enforcement.

## Why it's here

Docker CI has access only to the `dtrt-dev/tps` repo. Bundling the fake here
keeps the test suite self-contained — no external repo mount required.

The canonical copy lives in `dtrt-dev/ops/fakes/nono/`. If you update the fake
there, copy it here too (`cp` the binary and TOML files) and commit both.

## What it does

- Parses `nono run --profile <name> [--workdir <path>] -- <cmd>` arguments
- Loads profile TOML from `profiles/` (no actual kernel policy is applied)
- Logs every invocation to `$NONO_FAKE_LOG` so tests can assert on calls
- Executes the wrapped command directly (no sandbox enforcement)

## Environment variables

| Variable | Purpose |
|---|---|
| `NONO_FAKE_LOG` | Path to log file (default: `/tmp/nono-fake.log`) |
| `NONO_PROFILES_DIR` | Override profile search directory |
| `NONO_FAKE_CANARY` | Path to canary file for S4.1 enforcement tests |

## Security note

This fake provides **zero** isolation. It is for unit/integration testing only.
Install real nono for production use.
