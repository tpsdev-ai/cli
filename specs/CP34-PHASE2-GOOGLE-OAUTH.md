# CP34 Phase 2 — Google OAuth Delegation

**Issue:** ops-24 (Remote Branch Offices)
**Author:** Flint
**Status:** Ready for review
**Date:** 2026-02-27
**Depends on:** CP34 Phase 1 (PR #46, merged)

## Summary

Add Google OAuth delegation to `tps auth`, following the same pattern
as Phase 1 (Anthropic). Agents authenticate via the user's existing
Gemini CLI session. TPS reads the resulting credentials and uses them
for Gemini API calls.

## How It Works

```
tps auth login google  →  runs `gemini auth login`  →  reads credential file
```

Same transparency model as Anthropic:
- TPS does NOT implement its own OAuth flows
- User authenticates directly with Google's Gemini CLI
- TPS reads the resulting credentials and refreshes them using the
  same client ID and token endpoint
- Refreshed tokens synced back to Gemini CLI's credential file
  (prevents split-brain — lesson from S46-C)

## Files Changed

### `packages/cli/src/commands/auth.ts`

1. Add `loginGoogle()` — delegates to `gemini auth login`, reads creds
2. Add `readGeminiCredentials()` — reads from Gemini CLI's credential store
3. Add `refreshGoogleToken()` — refreshes via `https://oauth2.googleapis.com/token`
4. Add `syncToGeminiCli()` — writes refreshed tokens back (S46-C pattern)
5. Wire `loginGoogle` into `runAuth()` switch

### `packages/agent/src/llm/provider.ts`

1. Add `resolveGoogleAuth()` — loads OAuth creds with auto-refresh
2. Update `completeGoogle()` to use OAuth bearer token when `auth: oauth`

## Pre-Implementation Research (MUST DO FIRST)

Before coding, confirm these by inspecting actual Gemini CLI behavior:

1. **Credential path** — where does `gemini auth login` store tokens?
   Check `~/.gemini/`, `~/.config/gemini/`, `$XDG_CONFIG_HOME/gemini/`
2. **Credential format** — exact JSON structure (access_token,
   refresh_token, expiry_date, client_id, scope)
3. **Token endpoint** — confirm `https://oauth2.googleapis.com/token`
4. **API auth method** — does Gemini API accept OAuth bearer tokens
   directly, or only API keys?
5. **Client ID** — public or confidential? Can we reuse for refresh?

## Security

Same S46-A/B/C patterns from Phase 1:
- Auth dir `0o700`, credential files `0o600`
- CLI lookup via hardened `findCli()` (no PATH hijacking)
- Refreshed tokens synced back (no split-brain)
- Token values never in logs or status output

## Testing

1. Login delegation: mock `spawnSync`, assert correct CLI invocation
2. Credential reading: mock files in candidate paths
3. Token refresh: mock Google OAuth endpoint, verify format + update
4. Split-brain sync: assert write-back to Gemini CLI credential file
5. Status display: no token values exposed
6. Fallback: apiKey mode unchanged when auth != oauth

## Scope

Phase 2 = Google only. OpenAI/Codex = Phase 3.
