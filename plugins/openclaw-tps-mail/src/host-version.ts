/**
 * host-version.ts — the HOST OpenClaw version + the startup silent-reply guard
 * (cli#402).
 *
 * THE PROBLEM. On an OpenClaw host older than 2026.5.22, a tps-mail session key
 * (`agent:<id>:tps-mail:direct:<sender>`) classifies as the "direct" conversation
 * type, whose silent-reply defaults are policy "disallow" WITH rewrite ON. An
 * exact `NO_REPLY` final is therefore REWRITTEN into a canned phrase (e.g.
 * "Nothing to add right now.") BEFORE `deliver` runs. The plugin's token guard
 * (`isPostableFinalText`) matches the raw TOKENS only, so it cannot tell that
 * rewritten phrase from a real reply — it gets POSTED and discharges the reply
 * obligation. 2026.5.22 suppresses an exact `NO_REPLY` natively (before deliver);
 * 2026.8.1 removed the rewrite. The host-side fix is
 * `surfaces["tps-mail"].silentReplyRewrite.direct = false`.
 *
 * THE VERSION TRAP. `require("openclaw/package.json")` — or an `import.meta`
 * resolve — from the plugin's OWN directory resolves the plugin's DEV
 * DEPENDENCY (openclaw 2026.5.22 under plugins/openclaw-tps-mail/node_modules),
 * NOT the host that is running the plugin. A floor check built that way reports
 * 2026.5.22 everywhere and can never fire. The host signal used here is the
 * running gateway's OWN install: walk up from the entry script
 * (`process.argv[1]`) to the nearest `package.json` named "openclaw".
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The OpenClaw version that suppresses an exact `NO_REPLY` before deliver. */
export const SILENT_REPLY_REWRITE_FLOOR = "2026.5.22";

/** The channel/surface id whose config key this guard names. */
export const SURFACE_ID = "tps-mail";

/** The one config key a host sets to disable the rewrite for this surface. */
export const SILENT_REPLY_REWRITE_KEY = `surfaces["${SURFACE_ID}"].silentReplyRewrite.direct`;

/**
 * Resolve the HOST OpenClaw version from the RUNNING gateway's own install:
 * from `entry` (default `process.argv[1]`, the script the gateway was launched
 * with), walk up to the nearest `package.json` named "openclaw" and read its
 * `version`. Returns null when it cannot be determined (never a guess — the
 * caller warns rather than staying silent).
 */
export function detectHostOpenClawVersion(entry: string | undefined = process.argv[1]): string | null {
  if (!entry) return null;
  let dir: string;
  try {
    dir = dirname(realpathSync(entry));
  } catch {
    return null;
  }
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg && pkg.name === "openclaw" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        /* unreadable / invalid JSON: keep walking up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parse an OpenClaw version into its numeric `major.minor.patch` core plus
 *  whether it carried a pre-release/build suffix. A FULL match is required:
 *  a malformed string such as `2026.5.22broken` or `2026.5.22.1` must NOT
 *  parse — a prefix match would compare EQUAL to the floor and SUPPRESS the
 *  warning, exactly the fail-open this guard exists to avoid. */
function parseVersion(v: string): { core: [number, number, number]; suffix: boolean } | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?\s*$/.exec(v);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], suffix: m[4] !== undefined };
}

function compareCore(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Compare two OpenClaw versions by their numeric core. Returns -1/0/1, or
 *  null when either side is not a full, well-formed version. */
export function compareOpenClawVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return compareCore(pa.core, pb.core);
}

const FLOOR_CORE: [number, number, number] = parseVersion(SILENT_REPLY_REWRITE_FLOOR)!.core;

/**
 * Classify a host version against the floor, failing TOWARD the warning. A
 * version that carries a suffix AND whose numeric core EQUALS the floor (e.g.
 * `2026.5.22-1`, `2026.5.22-beta.1`) is NOT provably at or above the floor — it
 * could be a pre-release of the fix — so it counts as BELOW. A core strictly
 * above the floor with any suffix (`2026.5.23-1`) is fine. An unparseable
 * string is `unparseable` (the caller warns).
 */
export function classifyHostAgainstFloor(hostVersion: string): "at-or-above" | "below" | "unparseable" {
  const p = parseVersion(hostVersion);
  if (!p) return "unparseable";
  const cmp = compareCore(p.core, FLOOR_CORE);
  if (cmp > 0) return "at-or-above";
  if (cmp < 0) return "below";
  return p.suffix ? "below" : "at-or-above";
}

/**
 * True when the effective config DISABLES the silent-reply rewrite for this
 * surface. Read with an identity test on `false` — a truthiness test would
 * treat `false` as "unset", which is exactly the value that means "safe".
 */
export function isSilentReplyRewriteDisabled(cfg: any): boolean {
  return cfg?.surfaces?.[SURFACE_ID]?.silentReplyRewrite?.direct === false;
}

export interface HostSilentReplyGuard {
  /** True when the caller should log the message at WARN level. */
  warn: boolean;
  /** Why: newer host, explicitly configured, the rewrite hazard, or unknown. */
  reason: "host-current" | "configured-off" | "rewrite-hazard" | "unknown-version";
  /** The exact line to log (null when warn is false). */
  message: string | null;
}

/**
 * Decide the startup guard. WARN, never refuse: a refusal would take mail down
 * on a gateway that otherwise works. An undeterminable host version also warns
 * — silence would hide the hazard on exactly the hosts most likely to have it.
 */
export function evaluateHostSilentReplyGuard(
  hostVersion: string | null,
  cfg: any,
): HostSilentReplyGuard {
  // An explicit `false` disables the rewrite regardless of host version, so
  // there is no hazard to name. (Checked FIRST: `false` is the safe value, and
  // a truthiness test would mistake it for "unset".)
  if (isSilentReplyRewriteDisabled(cfg)) {
    return { warn: false, reason: "configured-off", message: null };
  }

  if (hostVersion === null) {
    return {
      warn: true,
      reason: "unknown-version",
      message:
        `openclaw-tps-mail: could not determine the HOST OpenClaw version, so the ` +
        `NO_REPLY-rewrite hazard could not be checked. On a host older than ` +
        `${SILENT_REPLY_REWRITE_FLOOR} an exact NO_REPLY final is rewritten to a canned phrase ` +
        `before deliver and gets posted. If this host may be that old, set ` +
        `${SILENT_REPLY_REWRITE_KEY} = false in the host config.`,
    };
  }

  const floorClass = classifyHostAgainstFloor(hostVersion);
  if (floorClass === "unparseable") {
    // Present but not a full, well-formed version — treat like "could not
    // check", naming what we saw. (NEVER fall through to "at the floor": a
    // prefix match on a malformed string would silently suppress the warning.)
    return {
      warn: true,
      reason: "unknown-version",
      message:
        `openclaw-tps-mail: could not compare the HOST OpenClaw version ` +
        `("${hostVersion}") against the ${SILENT_REPLY_REWRITE_FLOOR} floor, so the ` +
        `NO_REPLY-rewrite hazard could not be checked. If this host is older than ` +
        `${SILENT_REPLY_REWRITE_FLOOR}, set ${SILENT_REPLY_REWRITE_KEY} = false.`,
    };
  }

  // At or above the floor: NO_REPLY is suppressed natively (no rewrite).
  if (floorClass === "at-or-above") {
    return { warn: false, reason: "host-current", message: null };
  }

  return {
    warn: true,
    reason: "rewrite-hazard",
    message:
      `openclaw-tps-mail: HOST OpenClaw ${hostVersion} is older than ` +
      `${SILENT_REPLY_REWRITE_FLOOR}. A tps-mail session key ` +
      `(agent:<id>:tps-mail:direct:<sender>) classifies as "direct", whose ` +
      `silent-reply defaults are policy "disallow" with REWRITE ON, so an exact ` +
      `NO_REPLY final is rewritten to a canned phrase BEFORE deliver — the plugin's ` +
      `token guard cannot tell that phrase from a real reply, so it is posted and ` +
      `discharges the reply obligation. Set ${SILENT_REPLY_REWRITE_KEY} = false in the ` +
      `host config, or upgrade the host to >= ${SILENT_REPLY_REWRITE_FLOOR} (which ` +
      `suppresses NO_REPLY natively).`,
  };
}
