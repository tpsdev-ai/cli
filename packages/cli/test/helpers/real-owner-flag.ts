/** The flag the Docker lane sets to require the root-only set-runtime owner case (cli#801, cli#816). */
export const REAL_OWNER_FLAG = "TPS_TEST_REQUIRE_REAL_OWNER";

/**
 * Parse the flag once, at module load. Unset, "" and "0" mean the case is not
 * required; "1" means it is. Anything else is a typo and throws, so a mistyped
 * value is red instead of a silent skip.
 */
export function parseRequireRealOwner(env: Record<string, string | undefined>): boolean {
  const raw = env[REAL_OWNER_FLAG];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${REAL_OWNER_FLAG} accepts only {0,1} (unset, "" and "0" are not required; "1" is required); got ${JSON.stringify(raw)}`);
}
