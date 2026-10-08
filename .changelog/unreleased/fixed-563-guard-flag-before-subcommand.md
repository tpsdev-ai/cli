- **A guard flag before the `secrets-guard` subcommand is refused (Closes #563).**

  `tps --check secrets-guard …` and `tps --no-guard secrets-guard …` exit 1
  with `InvalidSecretsGuardMode` and run no child. Put the flag after the
  subcommand: `tps secrets-guard --check` or `tps secrets-guard --no-guard …`.
