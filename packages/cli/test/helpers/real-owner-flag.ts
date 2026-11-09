/**
 * The flags the Docker lane sets to require a lane-only set-runtime case: the
 * root-only real-owner case (cli#801, cli#816) and the second-group case
 * (cli#817).
 */
export const REAL_OWNER_FLAG = "TPS_TEST_REQUIRE_REAL_OWNER";
export const ALT_GROUP_FLAG = "TPS_TEST_REQUIRE_ALT_GROUP";

/**
 * Parse one require flag once, at module load. Unset, "" and "0" mean the case
 * is not required; "1" means it is. Anything else is a typo and throws, so a
 * mistyped value is red instead of a silent skip.
 */
export function parseRequireFlag(env: Record<string, string | undefined>, flag: string): boolean {
  const raw = env[flag];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${flag} accepts only {0,1} (unset, "" and "0" are not required; "1" is required); got ${JSON.stringify(raw)}`);
}

export function parseRequireRealOwner(env: Record<string, string | undefined>): boolean {
  return parseRequireFlag(env, REAL_OWNER_FLAG);
}

export function parseRequireAltGroup(env: Record<string, string | undefined>): boolean {
  return parseRequireFlag(env, ALT_GROUP_FLAG);
}
