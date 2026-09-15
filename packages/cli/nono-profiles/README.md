# nono-profiles

Bundled nono profiles, one file per profile name the CLI asks for. These are
**JSON** profiles validated against the nono 0.70+ schema (`nono profile
validate --strict`) — the pre-2.0 TOML dialect (`[process]`, `readonly = true`,
`writable`, `exec_allowlist`, `localhost_only`, `{home}` templating) is not
valid on 0.70+ and is gone. See cli#341.

## Why `extends` + an explicit deny list

`tps-base` extends nono's built-in `default` for the 18 security groups (that
is a materially better deny list than three hand-typed entries), but `extends`
**appends and can never subtract**: array fields are merge-and-dedup and deny
lists union. So:

- every deny TPS relies on is re-stated in `tps-base` explicitly;
- the only subtraction is `groups.exclude`, which is group-granular, never
  path-granular — used only to drop *grant* groups a given harness never needs
  (`system_write_*`, `user_tools`), never to drop the security-deny groups;
- `~/.openclaw/openclaw.json` is denied in the base (it is the harness's own
  control plane) and exempted only in the **operator-side** profiles
  (`tps-roster`, `tps-review-*`) via `bypass_protection` + `read_file`. The
  agent-side profile carries neither. Do not let one profile carry both.

Do **not** deny `~/.tps` wholesale: `~/.tps/secrets` and `~/.tps/identity` are
siblings of `~/.tps/mail` and `~/.tps/agents`, so a parent-level deny would
take the mailbox and agent state with it.

`workdir.access: "none"` means *inherit the base*, not "no cwd" — profiles that
must not write their cwd say `"read"`.

## The floor

`nono >= 0.70.0`, installed from **homebrew-core**:

```
brew install nono        # 0.70+; JSON profiles + `nono profile` subcommand
```

`always-further/nono` is dead (unmaintained since 2026-03-09) and shadows the
formula name:

```
brew untap always-further/nono
```
