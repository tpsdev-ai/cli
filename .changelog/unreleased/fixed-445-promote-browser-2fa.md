- **`scripts/promote-latest.sh` runs `npm dist-tag add` with the terminal attached, so a write behind browser 2FA can approve each move (Closes #445).**

  A captured or piped add has no terminal, so npm printed the auth URL and exited `EOTP` without moving the tag; the promote then rolled back. Both adds (promote and rollback) now inherit stdin/stdout/stderr, and the registry re-read stays the source of truth.
