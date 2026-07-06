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

# Run tests
bun test
```

## Architecture Notes

Before contributing, please read [docs/architecture.md](docs/architecture.md) (the system model) and [DESIGN.md](DESIGN.md) (why it's built this way).

When modifying the branch daemon or transport layers, keep the following security boundaries in mind — see [DESIGN.md § Trust boundaries](DESIGN.md#trust-boundaries) for the rationale:
- **Never expose the Host's private key**.
- **Always validate inputs** on cross-boundary messaging.
- **Fail closed** on authentication or permission errors.

## Code Quality

- We use Biome for linting. Run `bun run lint` before committing.
- Ensure all tests pass (`bun test`). We aim for high test coverage, especially in `src/utils/identity.ts`, `src/utils/relay.ts`, and the transport layers.
- Write tests for new features.

## Submitting a Pull Request

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-new-feature`).
3. Make your changes and commit (`git commit -am 'feat: add some feature'`).
4. Push to the branch (`git push origin feature/my-new-feature`).
5. Open a Pull Request.

Please describe the problem your PR solves and the approach you took. For significant architectural changes, consider opening an issue first for discussion.
