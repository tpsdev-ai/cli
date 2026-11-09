- **The release-age gate's workspace model now matches Bun for non-BMP directory names.** A `?` and a `[...]` member each consume one code point, so a supplementary-character directory is not a workspace under `packages/??`.

  No action for operators: the gate reports the same workspace set `bun install` links.
