# Contributing to TPS

We welcome contributions to the Team Provisioning System! TPS is built to be a robust, secure kernel for Agent OS development.

## Development Setup

TPS is built with TypeScript and [Bun](https://bun.sh/).

```bash
# Clone the repository
git clone https://github.com/tpsdev-ai/cli.git
cd cli

# Install dependencies
bun install

# Build the CLI
bun run build

# Run tests through the HOME-isolating launcher (cli#430). A bare `bun test`
# aborts: the preload refuses a run that no launcher set up. That is a
# launch-time check, not an OS boundary (cli#434).
bun run test
```

## Architecture Notes

Before contributing, please read [docs/architecture.md](docs/architecture.md) (the system model) and [DESIGN.md](DESIGN.md) (why it's built this way).

When modifying the branch daemon or transport layers, keep the following security boundaries in mind — see [DESIGN.md § Trust boundaries](DESIGN.md#trust-boundaries) for the rationale:
- **Never expose the Host's private key**.
- **Always validate inputs** on cross-boundary messaging.
- **Fail closed** on authentication or permission errors.

## Code Quality

- We use Biome for linting. Run `bun run lint` before committing.
- Run `bun run audit` for this repo's dependency audit: it invokes `bun audit`, the command CI's Dependency Audit runs. A bare `npm audit` is unsupported.
- Ensure all tests pass (`bun run test`). We aim for high test coverage, especially in `packages/cli/src/utils/identity.ts`, `packages/cli/src/utils/relay.ts`, and the transport layers.
- Write tests for new features.

### Exit status

A command reports status by setting `process.exitCode` and returning. The
completion tail in `packages/cli/bin/tps.ts` calls `process.exit` once after the
command returns, with the code the command set, so scripts and CI see failures
as failures.

Do not call `process.exit(0)` or `process.exit()` from a command. Approved
exceptions are identified by AST context in
`packages/cli/test/exit-status-discipline-750.test.ts`. A non-zero
`process.exit(<code>)` remains legal for an in-frame refusal.

## Changelog

A user-visible change adds one fragment file under
[`.changelog/unreleased/`](.changelog/unreleased/) — one file per change, so
pull requests with distinct fragment filenames do not share an edit to
`CHANGELOG.md`'s `[Unreleased]` section. Name it `<category>-<slug>.md`
(category one of `added`, `changed`, `deprecated`, `removed`, `fixed`,
`security`) and write the entry as it should read under its `### Category`
heading, leading `- ` included. Do not edit `[Unreleased]` by hand; CI runs
`node scripts/changelog-fragments.mjs check`.

At a release cut, `node scripts/changelog-fragments.mjs promote <version>`
writes the fragments into a new `## [<version>]` section of `CHANGELOG.md` and
deletes them. See [`.changelog/unreleased/README.md`](.changelog/unreleased/README.md)
for the naming, indentation and bold-lede rules.

## Submitting a Pull Request

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-new-feature`).
3. Make your changes and commit (`git commit -am 'feat: add some feature'`).
4. Push to the branch (`git push origin feature/my-new-feature`).
5. Open a Pull Request.

Please describe the problem your PR solves and the approach you took. For significant architectural changes, consider opening an issue first for discussion.
