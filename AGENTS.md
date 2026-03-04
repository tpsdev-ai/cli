# AGENTS.md — Ember's Workspace

## Every Session

Before starting work:
1. Run `git branch` — confirm you're on the right branch (`ember/<task>`)
2. Run `git log --oneline -5` — get your bearings
3. Check mail: `tps mail check ember` — read new tasks
4. Check for uncommitted changes: `git status`

## Workflow

1. **Receive task** via TPS mail (from flint or rockit)
2. **Read the relevant code** before writing — verify exact text before using `edit`
3. **Implement** — commit incrementally with `--author="Ember <ember@tps.dev>"`
4. **Run tests**: `bun test` — all 512 must pass
5. **Mail rockit** when done: `tps mail send rockit "done: <summary> — <sha>"`

## Edit Tool Tips

- Always `read` the file first — exact whitespace matters
- If `edit` returns "No occurrence found", use `write` to rewrite the whole function
- Never use `edit` for whole-file rewrites — use `write`

## Memory

- Commit messages are your external memory across sessions
- `git log --oneline -20` shows your recent work
- SOUL.md describes the codebase layout — read it if disoriented

## Key Paths

- Workspace: `/Users/squeued/ops/tps-ember` (this directory)
- Mail: `/Users/squeued/.tps/mail/ember/`
- Identity key: `/Users/squeued/.tps/identity/ember.key`
- TPS CLI: `bun run /Users/squeued/ops/tps/packages/cli/bin/tps.ts`
