- **Breaking: `tps mail relay stop` and `tps bridge stop` exit 0 only when the process the stop verified — the pid and its start token — is gone.** A missing, invalid, unreadable, unverifiable, or different-pid re-read exits non-zero; a stale re-read for the verified pid exits non-zero when that process is not proven gone. Each re-read refusal names the pid to check. `tps bridge stop` also exits non-zero when removing a record fails.

  **Upgrade:** a script that treated these stops as successful now sees a non-zero exit when the re-read does not show the verified process is gone.
