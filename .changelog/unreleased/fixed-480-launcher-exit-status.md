- **The `tps` launcher preserves non-zero platform binary exits and maps signals to a non-zero code (Closes #480).**

  Previously, either case ran the JS fallback: success returned 0 without a
  banner; otherwise it printed the missing-binding banner and returned 1.
  Fallback now runs when the platform package could not be resolved or the
  binary could not start. A missing JS entry prints reinstall guidance and exits 1.
