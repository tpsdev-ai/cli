- **The openclaw-tps-mail plugin builds and tests in CI: its tsc is green and the two plugin CI steps no longer swallow failures.**

  The plugin's `tsc` was red — `src/index.ts` imported six channel types from
  `openclaw/plugin-sdk/channels`, a subpath the pinned SDK does not export — and
  the CI steps papered over it (`npm run build || true`) or skipped the build
  entirely, so a stale-dist run failed the node-load tests. Types now come from
  the public SDK subpaths (`channel-contract`, `core`; the two adapters derive
  from `ChannelPlugin`), the emitted `dist/src/index.js` is byte-identical
  (type-only), and both plugin CI steps run `npm ci --ignore-scripts` plus a
  mandatory `npm run build`.

  (Refs #393)
