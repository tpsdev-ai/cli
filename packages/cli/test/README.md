# Test Patterns

## homedir() in CI

`homedir()` from `node:os` caches the result at module load time. Setting
`process.env.HOME = tempHome` in tests does NOT affect `homedir()`.

**Pattern:** Any command that calls `createFlairClient()` without an explicit
`keyPath` will fail in CI (key at `/home/runner/.tps/...` doesn't exist).

**Fix:** Add `keyPath` to the command's opts interface and thread it through:
```ts
const keyPath = args.keyPath ?? join(homedir(), ".tps", "identity", `${viewerId}.key`);
const flair = createFlairClient(viewerId, flairUrl, keyPath);
```
Then pass `keyPath: join(tempHome, ".tps", "identity", "anvil.key")` in tests.

**Affected commands so far:** roster invite, agent logs (both fixed).
