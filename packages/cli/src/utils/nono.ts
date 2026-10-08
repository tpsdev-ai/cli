/**
 * nono integration — wraps TPS CLI commands in nono process isolation.
 *
 * When nono is available on PATH, TPS commands run with kernel-level
 * filesystem and network restrictions defined by per-command JSON profiles.
 *
 * If nono is not installed:
 *   - Default (warn) mode: logs a warning and runs unprotected
 *   - Strict mode (TPS_NONO_STRICT=1): exits non-zero immediately
 *
 * Profiles (cli#341 S1b). A profile is JSON (nono 0.70+ shape) with `extends`.
 * A profile that is MISSING or fails `nono profile validate --strict` is a
 * FAILURE — the run stops (EX_CONFIG). There is no warn-and-continue path for
 * an unloadable sandbox.
 *
 * Launch-path control (cli#341 S1a) — fail-closed, no env escape hatch:
 *   - The old `TPS_FORCE_NO_NONO` environment bypass is GONE. No environment
 *     variable can make the launcher forget that nono exists.
 *   - `--no-sandbox` (the only human escape hatch) is honoured ONLY from an
 *     interactive TTY (stdin AND stdout). Anywhere else it is refused.
 *   - A non-interactive invocation that launches an agent MUST carry
 *     `--sandbox-required`; a launcher that dropped it is refused rather than
 *     silently running unsandboxed. See `evaluateLaunchControl`.
 *   - CLI selected runtime runners require launcher release or an interactive
 *     TTY `--no-sandbox` opt-out. `--sandbox-required` conflicts with that opt-out.
 *   - Under `--sandboxed` the child must hold the launcher's release for a live
 *     nono session bound to its own pid (cli#350 round 4e): see
 *     `launch-attestation.ts`. `--sandboxed` means "my launcher released me" —
 *     never "trust me": it is refused everywhere without that release, TTY or
 *     not (cli#350 r4f). The interactive opt-out stays `--no-sandbox` (with its
 *     warning).
 *
 * Profile locations (searched in order):
 *   1. ~/.config/nono/profiles/<name>.json
 *   2. <tps-install-dir>/nono-profiles/<name>.json
 *
 * Usage:
 *   import { withNono } from "./nono.js";
 *   await withNono("tps-hire", { workdir: targetWorkspace }, async () => {
 *     // ... perform hire logic ...
 *   });
 */

import meow from "meow";
import { launchFlagDefinitions } from "./cli-flags.js";
export { launchFlagDefinitions } from "./cli-flags.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { providerAuthPath, runtimeCredentialFiles, runtimeProviders, type CredentialRuntime } from "./runtime-credentials.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type NonoProfile =
  | "tps-hire"
  | "tps-roster"
  | "tps-review-local"
  | "tps-review-deep"
  | "tps-bootstrap"
  | "tps-backup"
  | "tps-restore"
  | "tps-status"
  | "tps-agent-run"
  | "tps-agent-run-claude-code"
  | "tps-agent-run-codex"
  | "tps-agent-run-gemini";

export interface NonoOptions {
  cwd?: string;
  /** Override workdir for the nono sandbox (--workdir flag) */
  workdir?: string;
  /** Extra read-only paths to allow */
  read?: string[];
  /**
   * Extra read-only FILE paths (nono `--read-file`) — single files, e.g. an
   * agent's own identity key. Use this rather than a directory read grant so a
   * sandboxed agent can read exactly its own key, not every sibling's (cli#351
   * r4; nono's read model is an allow-list, no directory deny is needed).
   */
  readFiles?: string[];
  /** Extra read-write paths to allow */
  allow?: string[];
  allowFiles?: string[];
}

/**
 * Find the nono binary on PATH. Returns the resolved path or null.
 */
export function findNono(): string | null {
  const result = spawnSync("which", ["nono"], {
    encoding: "utf-8",
    env: process.env, // explicitly pass so PATH mutations in tests are respected
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return null;
}

/**
 * Check if strict mode is enabled (TPS_NONO_STRICT=1).
 * In strict mode, TPS exits if nono is not available.
 */
export function isNonoStrict(): boolean {
  return process.env.TPS_NONO_STRICT === "1";
}

// ---------------------------------------------------------------------------
// Profile loading (cli#341 S1b) — validate-or-FAIL, never warn-and-continue
// ---------------------------------------------------------------------------

/** First nono release with the JSON profile schema and `nono profile`. */
export const NONO_MIN_VERSION = "0.70.0";

/** sysexits.h EX_CONFIG — the configuration (here: the profile) is wrong. */
export const EX_CONFIG = 78;

/**
 * Resolve a profile name to a JSON file on disk, or null.
 * Searches ~/.config/nono/profiles/ then the bundled nono-profiles/ directory.
 */
export function resolveProfilePath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || homedir() || "/tmp";
  const candidates = [
    join(home, ".config", "nono", "profiles", `${name}.json`),
    join(findBundledProfilesDir(), `${name}.json`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** `nono --version` → "x.y.z", or null if it cannot be parsed. */
export function nonoVersion(bin: string): string | null {
  const result = spawnSync(bin, ["--version"], { encoding: "utf-8", env: process.env });
  if (result.status !== 0 || !result.stdout) return null;
  const m = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Semver-ish >= for the version floor (no prerelease handling needed). */
export function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.split(".").map((n) => Number.parseInt(n, 10));
  const b = min.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? a[i]! : 0;
    const y = Number.isFinite(b[i]) ? b[i]! : 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface ProfileCheck {
  ok: boolean;
  /** Resolved profile path when found. */
  path?: string;
  /** Human-readable reason when not ok. */
  reason?: string;
}

/**
 * Validate-or-FAIL. The profile must exist AND pass `nono profile validate
 * --strict`. Anything else is a refusal: a sandbox that cannot be loaded stops
 * the run. Returns the resolved path on success.
 *
 * `bin` is injectable for tests; pass null to check existence only (used when
 * nono is absent and the caller's nono policy handles that separately).
 */
export function checkProfileLoadable(
  name: string,
  bin: string | null = findNono(),
  env: NodeJS.ProcessEnv = process.env
): ProfileCheck {
  const path = resolveProfilePath(name, env);
  if (!path) {
    return {
      ok: false,
      reason:
        `profile ${name}.json was not found in ~/.config/nono/profiles/ or the bundled ` +
        `nono-profiles/ directory`,
    };
  }
  if (!bin) return { ok: true, path };

  const version = nonoVersion(bin);
  if (version && !versionAtLeast(version, NONO_MIN_VERSION)) {
    return {
      ok: false,
      path,
      reason: `nono ${version} at ${bin} is below the ${NONO_MIN_VERSION} floor — it predates JSON profiles`,
    };
  }

  const validate = spawnSync(bin, ["profile", "validate", "--strict", path], {
    encoding: "utf-8",
    env,
  });
  if (validate.status !== 0) {
    const detail = `${validate.stdout ?? ""}${validate.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-6)
      .join("\n");
    return {
      ok: false,
      path,
      reason: `\`nono profile validate --strict ${path}\` exited ${validate.status}:\n${detail}`,
    };
  }
  return { ok: true, path };
}

/**
 * System read roots. Replaces the old blanket `--read /`: a root grant is
 * refused by nono 0.70+, so the harness grants the toolchain roots explicitly.
 * Kern validated the macOS set; the Linux set is its equivalent.
 */
export function systemReadPaths(): string[] {
  return process.platform === "darwin"
    ? ["/opt/homebrew", "/usr", "/bin", "/sbin", "/Library", "/private/etc/ssl"]
    : // NOTE: /etc is deliberately NOT granted on Linux (Landlock cannot express
      // deny-within-allow with the tps-base /etc/* denies), but /etc/ssl carries
      // the TLS CA bundle git/openssl need and has no deny under it — it is
      // granted via tps-base's read list (and /private/etc/ssl on macOS, where
      // /etc is a symlink and the real path is what the kernel resolves).
      ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt"];
}

/** System FILES the harness reads (nono `--read-file`), where /etc as a whole
 * cannot be granted on Linux (see above), filtered to what exists on this host
 * (a --read-file on an absent path is skipped by nono with a warning).
 *
 * `/etc/gitconfig` is the SYSTEM git config (cli#351 r5b): where it exists,
 * git reads it as part of "reading the configuration files", and an unreadable
 * one is FATAL, not ignorable — on the ubuntu CI runner `git ls-remote` died
 * with `warning: unable to access '/etc/gitconfig': Permission denied` +
 * `fatal: unknown error occurred while reading the configuration files`
 * (exit 128) while the same command passed on macOS (no /etc/gitconfig; the
 * homebrew git's config sits under the granted /opt/homebrew). The probe in
 * scripts/check-nono-profiles.sh pins this: the resolver is fine inside the
 * sandbox (resolv.conf's /run/stub target is readable and `getent hosts
 * github.com` resolves) — the missing grant is this file. */
/**
 * The candidate system read files for a platform, before the exists-filter.
 * Exported so the supervisor launch path (a shell script that cannot import
 * this module) can be asserted EQUAL to it by a test — the two launch points
 * must not drift (cli#352 r).
 */
export function systemReadFileCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin"
    ? ["/etc/hosts", "/etc/resolv.conf", "/etc/gitconfig"]
    : ["/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/gitconfig"];
}

/**
 * The system read files that exist on this host, granted by name at launch.
 */
export function systemReadFiles(): string[] {
  return systemReadFileCandidates().filter((f) => existsSync(f));
}

/**
 * Read grants every TPS harness family needs: the agent identity dir, the bun
 * cache, the running interpreter's own directory, plus the system roots. One
 * definition so `agent start` and `mail watch` cannot drift apart (cli#341 S1b).
 */
export function harnessReadPaths(): string[] {
  // NOTE: no identity directory here. The identity dir holds every agent's key
  // on a shared-UID host; granting it read would let one agent read all others.
  // The launch grants exactly the launching agent's own key via
  // harnessReadFiles(agentId) → --read-file (cli#351 r4).
  return [join(homedir(), ".bun"), dirname(process.execPath), ...systemReadPaths()];
}

/**
 * The launching agent's OWN identity files (read-only): its signing key, and
 * the public key beside it (the runtime resolves `~/.tps/identity/<id>.key`;
 * the `.pub` is granted too since it is the same agent's own material).
 */
export function harnessReadFiles(agentId?: string): string[] {
  const files = [...systemReadFiles()];
  if (agentId) {
    const idDir = join(homedir(), ".tps", "identity");
    files.push(join(idDir, `${agentId}.key`), join(idDir, `${agentId}.pub`));
  }
  return files;
}

export function runtimeNonoProfile(runtime?: string): NonoProfile {
  return runtime === "claude-code" || runtime === "codex" || runtime === "gemini"
    ? `tps-agent-run-${runtime}`
    : "tps-agent-run";
}

export function runtimeNonoOptions(
  runtime?: string,
  env: NodeJS.ProcessEnv = process.env,
): NonoOptions {
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  let allow: string[] = [];
  let allowFiles: string[] = [];
  if (runtime === "claude-code") {
    allow = [env.CLAUDE_CONFIG_DIR || join(home, ".claude"), join(home, ".claude")];
    allowFiles = [join(home, ".claude.json"), join(home, ".claude.lock")];
  } else if (runtime === "codex") {
    allow = [env.CODEX_HOME || join(home, ".codex"), join(home, ".config", "codex")];
    allowFiles = [providerAuthPath(runtimeProviders.codex, env)];
  } else if (runtime === "gemini") {
    allow = [join(home, ".gemini"), join(xdg, "gemini")];
  }
  return { allow: [...new Set(allow)], allowFiles };
}

function runtimeDirVariables(
  runtime: string | undefined,
  env: NodeJS.ProcessEnv,
): Array<{ variable: string; path: string }> {
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  if (runtime === "claude-code") {
    return env.CLAUDE_CONFIG_DIR ? [{ variable: "CLAUDE_CONFIG_DIR", path: env.CLAUDE_CONFIG_DIR }] : [];
  }
  if (runtime === "codex") {
    return env.CODEX_HOME ? [{ variable: "CODEX_HOME", path: env.CODEX_HOME }] : [];
  }
  if (runtime === "gemini") {
    return env.XDG_CONFIG_HOME ? [{ variable: "XDG_CONFIG_HOME", path: join(xdg, "gemini") }] : [];
  }
  return [];
}

function tpsCredentialRoots(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ label: string; path: string }> {
  const home = env.HOME || homedir();
  return (["auth", "identity", "secrets"] as const).map((dir) => ({
    label: `~/.tps/${dir}`,
    path: join(home, ".tps", dir),
  }));
}

function caseInsensitivePath(p: string): boolean {
  let ancestor = p;
  for (;;) {
    try {
      if (!statSync(ancestor).isDirectory()) ancestor = dirname(ancestor);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw err;
      ancestor = parent;
    }
  }
  const toggleCase = (name: string) => name.replace(/[a-zA-Z]/, (c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  let parent = ancestor;
  let names = readdirSync(parent);
  let name = names.find((entry) => toggleCase(entry) !== entry);
  if (!name) {
    parent = dirname(ancestor);
    if (parent === ancestor || statSync(parent).dev !== statSync(ancestor).dev) return true;
    name = basename(ancestor);
    if (toggleCase(name) === name) return caseInsensitivePath(parent);
    names = readdirSync(parent);
  }
  const alternateName = toggleCase(name);
  if (names.includes(alternateName)) return false;
  const probe = join(parent, name);
  const original = lstatSync(probe);
  try {
    const alternate = lstatSync(join(parent, alternateName));
    return original.dev === alternate.dev && original.ino === alternate.ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function appendUnresolved(ancestor: string, tail: string[]): string {
  if (!tail.length) return ancestor;
  const components = caseInsensitivePath(ancestor) ? tail.map((part) => part.toLowerCase()) : tail;
  return join(ancestor, ...components);
}

function canonicalPath(p: string, cwd: string = process.cwd(), links = 0): string {
  if (links > 40) throw new Error(`cannot resolve ${p}: too many symbolic links`);
  let cur = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return appendUnresolved(real, tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          const target = canonicalPath(readlinkSync(cur), dirname(cur), links + 1);
          return appendUnresolved(target, tail.reverse());
        }
      } catch (linkErr) {
        const linkCode = (linkErr as NodeJS.ErrnoException).code;
        if (linkCode !== "ENOENT" && linkCode !== "ENOTDIR") throw linkErr;
      }
      const parent = dirname(cur);
      if (parent === cur) throw err;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function pathContainsOrEquals(dir: string, p: string): boolean {
  if (dir === p) return true;
  return p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function pathsOverlap(a: string, b: string): boolean {
  return pathContainsOrEquals(a, b) || pathContainsOrEquals(b, a);
}

export function approveRuntimeNonoOptions(
  runtime: string | undefined,
  grants: NonoOptions,
  env: NodeJS.ProcessEnv = process.env,
  agentId?: string,
): { options: NonoOptions; runtimeDirectories: string[]; refusal: string | null } {
  const options: NonoOptions = {};
  const runtimeDirectories: string[] = [];
  const result = (refusal: string | null) => ({ options, runtimeDirectories, refusal });
  const resolved = new Map<string, string>();
  const canonical = (p: string): string => {
    if (!resolved.has(p)) resolved.set(p, canonicalPath(p));
    return resolved.get(p)!;
  };
  const comparisonPaths = new Map<string, string>();
  const comparisonPath = (p: string): string => {
    if (!comparisonPaths.has(p)) comparisonPaths.set(p, caseInsensitivePath(p) ? p.toLowerCase() : p);
    return comparisonPaths.get(p)!;
  };
  const overlaps = (a: string, b: string) => pathsOverlap(comparisonPath(a), comparisonPath(b));
  const contains = (a: string, b: string) => pathContainsOrEquals(comparisonPath(a), comparisonPath(b));
  const equals = (a: string, b: string) => comparisonPath(a) === comparisonPath(b);
  try {
    const roots = tpsCredentialRoots(env).map((r) => {
      try {
        return { ...r, canon: canonical(r.path) };
      } catch (err) {
        throw new Error(`cannot resolve TPS credential root ${r.label} (${r.path}): ${(err as Error).message}`);
      }
    });

    for (const { variable, path } of runtimeDirVariables(runtime, env)) {
      let canon: string;
      try {
        canon = canonical(path);
      } catch (err) {
        const root = roots.find((r) => pathsOverlap(resolve(path).toLowerCase(), resolve(r.path).toLowerCase()));
        return result(
          `${variable}=${path} cannot be resolved` +
          (root ? ` at TPS credential root ${root.label} (${root.path})` : "") +
          `: ${(err as Error).message}`,
        );
      }
      const hit = roots.find((r) => overlaps(canon, r.canon));
      if (hit) {
        return result(
          `${variable}=${path} overlaps the TPS credential root ${hit.label} (${hit.path}) — ` +
          `the runtime profile would grant it read-write access to a credential root`
        );
      }
    }

    const dirGrants: Array<{ label: string; path: string }> = [];
    if (grants.workdir) dirGrants.push({ label: "the workdir grant", path: grants.workdir });
    if (grants.cwd) dirGrants.push({ label: "the current-directory grant", path: grants.cwd });
    for (const p of grants.read ?? []) dirGrants.push({ label: `the read grant '${p}'`, path: p });
    for (const p of grants.allow ?? []) dirGrants.push({ label: `the writable grant '${p}'`, path: p });
    for (const p of runtimeNonoOptions(runtime, env).allow ?? []) {
      runtimeDirectories.push(canonical(p));
      dirGrants.push({ label: `the runtime directory '${p}'`, path: p });
    }

    const runtimes = Object.keys(runtimeProviders) as CredentialRuntime[];
    const foreignFiles = runtimes
      .filter((rt) => rt !== runtime)
      .flatMap((rt) => [...runtimeCredentialFiles(rt, env), providerAuthPath(runtimeProviders[rt], env)])
      .map((f) => ({ path: f, canon: canonical(f) }));

    for (const grant of dirGrants) {
      const canon = canonical(grant.path);
      const root = roots.find((r) => overlaps(canon, r.canon));
      if (root) {
        return result(
          `${grant.label} (${grant.path}) overlaps the TPS credential root ${root.label} (${root.path}) — ` +
          (grant.label === "the current-directory grant"
            ? `launch from a workspace directory outside the credential roots`
            : grant.label === "the workdir grant"
              ? `set the workspace to a directory outside the credential roots`
              : `remove or narrow this grant to a directory outside the credential roots`)
        );
      }
      const foreign = foreignFiles.find((f) => contains(canon, f.canon));
      if (foreign) {
        return result(
          `${grant.label} (${grant.path}) covers ${foreign.path}, another runtime's credential file`
        );
      }
    }
    const identityRoot = roots.find((r) => r.label === "~/.tps/identity")!.canon;
    const ownIdentity = agentId
      ? [join(identityRoot, `${agentId}.key`), join(identityRoot, `${agentId}.pub`)]
      : [];
    const ownAuth = runtime === "codex"
      ? [join(roots.find((r) => r.label === "~/.tps/auth")!.canon, `${runtimeProviders.codex}.json`)]
      : [];
    const ownFiles = runtimes.includes(runtime as CredentialRuntime)
      ? [...runtimeCredentialFiles(runtime as CredentialRuntime, env), ...(runtimeNonoOptions(runtime, env).allowFiles ?? [])]
      : [];
    const ownTargets = ownFiles.map((p) => join(canonical(dirname(resolve(p))), basename(p)));
    const systemTargets = systemReadFiles().map(canonical);
    const fileGrants = [
      ...(grants.readFiles ?? []).map((p) => ({ path: p, label: `the read-file grant '${p}'`, readOnly: true })),
      ...(grants.allowFiles ?? []).map((p) => ({ path: p, label: `the writable-file grant '${p}'`, readOnly: false })),
    ];
    for (const grant of fileGrants) {
      const canon = canonical(grant.path);
      const foreign = foreignFiles.find((f) => equals(f.canon, canon));
      if (foreign) return result(`${grant.label} targets ${foreign.path}, another runtime's credential file`);
      const root = roots.find((r) => overlaps(canon, r.canon));
      const permittedTpsFile = ownAuth.some((p) => equals(p, canon)) || (grant.readOnly && ownIdentity.some((p) => equals(p, canon)));
      if (root && !permittedTpsFile) {
        return result(`${grant.label} (${canon}) overlaps the TPS credential root ${root.label} (${root.path})`);
      }
      if (!root && !ownTargets.some((p) => equals(p, canon)) && !(grant.readOnly && systemTargets.some((p) => equals(p, canon)))) {
        return result(`${grant.label} (${canon}) is not a permitted file for runtime '${runtime}'`);
      }
    }
    for (const key of ["workdir", "cwd"] as const) {
      if (grants[key]) options[key] = canonical(grants[key]);
    }
    for (const key of ["read", "allow", "readFiles", "allowFiles"] as const) {
      options[key] = (grants[key] ?? []).map(canonical);
    }
    return result(null);
  } catch (err) {
    const settings = runtimeDirVariables(runtime, env).map(({ variable, path }) => `${variable}=${path}`).join(", ");
    return result(`cannot resolve launch grants${settings ? ` for ${settings}` : ""}: ${(err as Error).message}`);
  }
}

export function runtimeDirCredentialRefusal(
  runtime: string | undefined,
  grants: NonoOptions,
  env: NodeJS.ProcessEnv = process.env,
  agentId?: string,
): string | null {
  return approveRuntimeNonoOptions(runtime, grants, env, agentId).refusal;
}

/**
 * Build the nono command args for a given profile and subcommand.
 *
 * Returns: ["nono", "run", "--profile", name, ...options, "--", ...cmd]
 */
export function buildNonoArgs(
  profile: NonoProfile,
  options: NonoOptions,
  cmd: string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  // Pass the RESOLVED path, not the bare name (cli#351 r2, MEDIUM 3).
  // checkProfileLoadable validates resolveProfilePath(name) (user dir, then
  // bundled), but nono resolves a bare name against its own search path
  // (the user dir). Passing the path makes what we validate the artifact that
  // actually runs.
  const profilePath = resolveProfilePath(profile, env) ?? profile;
  const args = ["run", "--profile", profilePath];
  if (options.cwd) args.push("--allow", options.cwd);
  else args.push("--allow-cwd");

  if (options.workdir) {
    args.push("--workdir", options.workdir);
  }

  for (const p of options.read ?? []) {
    args.push("--read", p);
  }

  for (const p of options.readFiles ?? []) {
    args.push("--read-file", p);
  }

  for (const p of options.allowFiles ?? []) {
    args.push("--allow-file", p);
  }

  for (const p of options.allow ?? []) {
    args.push("--allow", p);
  }

  args.push("--", ...cmd);
  return args;
}

/**
 * Run a function wrapped in nono isolation.
 *
 * If nono is unavailable:
 *   - strict mode → throws (exits non-zero)
 *   - warn mode (default) → logs warning and runs fn directly
 *
 * The callback receives the nono binary path (or null if unavailable).
 * In most cases you won't need it — this wrapper handles invocation.
 *
 * Note: This wrapper is for use when TPS itself is the process being
 * sandboxed. The more common case is calling `runUnderNono()` to spawn
 * a subprocess under nono.
 */
export async function withNono(
  profile: NonoProfile,
  _options: NonoOptions,
  fn: () => Promise<void>
): Promise<void> {
  const nono = findNono();

  if (!nono) {
    if (isNonoStrict()) {
      console.error(
        `❌ nono is not installed but TPS_NONO_STRICT=1. Install nono from https://nono.sh`
      );
      process.exit(1);
    } else {
      console.warn(
        `⚠️  nono not found — running ${profile} WITHOUT isolation. Install nono for security: https://nono.sh`
      );
      return fn();
    }
  }

  // nono is available — but only proceed if the profile can actually load.
  // Validate-or-FAIL: an unloadable sandbox stops the run (cli#341 S1b).
  const check = checkProfileLoadable(profile, nono);
  if (!check.ok) {
    console.error(
      `❌ nono profile failed to load — refusing to run outside the sandbox (cli#341):\n` +
        `   profile: ${profile}\n   reason:  ${check.reason}`
    );
    process.exit(EX_CONFIG);
  }

  // nono is available — run the callback directly (the current process IS already
  // being run via nono by the calling shell, or we re-exec under nono).
  // For TPS's architecture, we use runCommandUnderNono() for subprocess isolation.
  return fn();
}

/**
 * Spawn an external command under nono isolation.
 *
 * Returns the exit code of the wrapped command.
 * Throws if nono is unavailable and strict mode is on.
 */
export function runCommandUnderNono(
  profile: NonoProfile,
  options: NonoOptions,
  cmd: string[]
): number {
  const nono = findNono();

  if (!nono) {
    if (isNonoStrict()) {
      console.error(
        `❌ nono is not installed but TPS_NONO_STRICT=1. Install nono from https://nono.sh`
      );
      return 1;
    }
    console.warn(
      `⚠️  nono not found — running WITHOUT isolation: ${cmd.join(" ")}`
    );
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      stdio: "inherit",
      encoding: "utf-8",
      env: process.env,
    });
    return result.status ?? 1;
  }

  // Validate-or-FAIL before we depend on the profile (cli#341 S1b): a missing
  // or invalid profile is a refusal, never a warn-and-continue.
  const check = checkProfileLoadable(profile, nono);
  if (!check.ok) {
    console.error(
      `❌ nono profile failed to load — refusing to run without isolation (cli#341):\n` +
        `   profile: ${profile}\n   reason:  ${check.reason}`
    );
    return EX_CONFIG;
  }

  const args = buildNonoArgs(profile, options, cmd);
  const result = spawnSync(nono, args, {
    stdio: "inherit",
    encoding: "utf-8",
    // TPS_NONO_ACTIVE is the double-wrap guard the CLI UIs read; setting it on
    // every nono child keeps one launch path (cli#351 r2). GIT_CONFIG_GLOBAL is
    // set for the same reason: one launch path, no $HOME/.gitconfig read
    // (cli#351 r5c) — see sandboxChildEnv().
    env: sandboxChildEnv(),
  });
  return result.status ?? 1;
}

/**
 * Environment every nono-sandboxed child gets — and therefore every tool the
 * agent shells out to (git, bun, sh) inherits it.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` (cli#351 r5c): under a REAL launch git reads
 * its USER config from $HOME, and the sandbox deliberately does NOT grant the
 * agent's HOME (it holds ~/.tps/secrets, ~/.tps/identity, keys). An existing
 * but unreadable `~/.gitconfig` is FATAL to git, not ignorable —
 * `fatal: unable to access '~/.gitconfig': Operation not permitted` (macOS) /
 * `Permission denied` (Linux), exit 128, so `git ls-remote` and friends died
 * inside the sandbox the moment the agent's HOME had a git config. Point git's
 * global config at /dev/null (granted read-write by tps-base) instead of
 * exposing HOME.
 *
 * `GIT_CONFIG_SYSTEM` is deliberately NOT overridden: where `/etc/gitconfig`
 * exists it is granted read by name (cli#351 r5b), which keeps the system
 * config's semantics instead of silently discarding it.
 */
export function sandboxChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    // TPS_NONO_ACTIVE is the double-wrap guard the CLI UIs read (cli#351 r2).
    TPS_NONO_ACTIVE: "1",
    // Never let the sandboxed child read (or write) $HOME/.gitconfig.
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

function findBundledProfilesDir(): string {
  const candidates = [
    join(__dirname, "..", "..", "nono-profiles"),          // dist/src/utils -> nono-profiles
    join(__dirname, "..", "..", "..", "nono-profiles"),     // deeper nesting
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(__dirname, "..", "..", "nono-profiles"); // fallback
}

/** sha256 of a file's bytes — the content hash installNonoProfiles compares. */
function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Install the bundled nono profiles into `~/.config/nono/profiles/`
 * (or `targetDir`). Called during `tps install` / first-run setup.
 *
 * MIGRATION (cli#341 S1b, spec v1/v2 — the window-closer):
 *   - Overwrite an installed TPS profile whenever the bundled content differs
 *     (content-hash versioned). nono resolves `extends` BY NAME across locations
 *     (~/.config first), so a stale `~/.config/.../tps-base.json` SHADOWS the
 *     bundled deny list for every child everywhere — a changed deny list MUST
 *     propagate, not be masked by an if-not-exists copy.
 *   - Retire a stale TPS-named `*.toml` profile (the pre-2.0 dialect).
 *   - Never touch user-authored NON-TPS profiles: everything is keyed on the set
 *     of names we ship, not a blanket glob of the directory.
 *   - validate-or-FAIL when nono supports JSON profiles: an unloadable profile
 *     is never installed silently.
 */
export function installNonoProfiles(targetDir?: string, silent?: boolean): void {
  const home = process.env.HOME || homedir() || "/tmp";
  const profilesDir = targetDir ?? join(home, ".config", "nono", "profiles");

  // Source: bundled profiles shipped with TPS
  const bundledDir = findBundledProfilesDir();

  if (!existsSync(bundledDir)) {
    if (!silent) console.warn(`⚠️  No bundled nono profiles found at ${bundledDir}`);
    return;
  }

  mkdirSync(profilesDir, { recursive: true });

  const bundled = readdirSync(bundledDir).filter((f) => f.endsWith(".json"));
  const shippedNames = new Set(bundled.map((f) => f.replace(/\.json$/, "")));

  // (b) Retire stale TPS-named *.toml (only names we ship — user files stay).
  for (const entry of readdirSync(profilesDir)) {
    if (!entry.endsWith(".toml")) continue;
    if (!shippedNames.has(entry.replace(/\.toml$/, ""))) continue;
    unlinkSync(join(profilesDir, entry));
    if (!silent) console.log(`  ✓ Retired stale nono profile: ${entry}`);
  }

  // ── Pass 1: copy/overwrite the FULL set (no validation yet) ────────────────
  // Copy and validate must be separate passes: `readdirSync` order is
  // filesystem-arbitrary, so validating a child (e.g. tps-office extends
  // tps-base) before its parent has been copied aborts mid-install and leaves
  // exactly the partial state the migration exists to prevent (cli#351 r3).
  for (const file of bundled) {
    const src = join(bundledDir, file);
    const dst = join(profilesDir, file);
    const present = existsSync(dst);
    if (!present || fileSha256(src) !== fileSha256(dst)) {
      copyFileSync(src, dst);
      if (!silent) console.log(`  ✓ ${present ? "Updated" : "Installed"} nono profile: ${file}`);
    }
  }

  // ── Pass 2: validate the complete set; fail closed only now ────────────────
  const bin = findNono();
  // Validate only when nono is new enough to have JSON profiles at all. An
  // absent/too-old nono cannot load them either way; the *launch* path
  // (checkProfileLoadable) is where an unsupported nono is refused.
  const version = bin ? nonoVersion(bin) : null;
  const canValidate = Boolean(bin && version && versionAtLeast(version, NONO_MIN_VERSION));
  if (canValidate) {
    for (const file of bundled) {
      const name = file.replace(/\.json$/, "");
      const check = checkProfileLoadable(name, bin);
      if (!check.ok) {
        console.error(
          `❌ installed nono profile fails validation — refusing to continue (cli#341):\n` +
            `   profile: ${join(profilesDir, file)}\n   reason:  ${check.reason}`
        );
        process.exit(EX_CONFIG);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Launch-path sandbox control (cli#341 S1a)
// ---------------------------------------------------------------------------
//
// This is the control that decides whether a *launcher* is allowed to start an
// agent, and under what isolation. It is deliberately small and dependency-free
// so it can be unit tested with injected TTY/supervisor state.

/** Asserted by every generated unit that launches an agent. */
export const SANDBOX_REQUIRED_FLAG = "--sandbox-required";

/** The only human escape hatch. Interactive TTY only. */
export const NO_SANDBOX_FLAG = "--no-sandbox";

/**
 * The launcher's private "I am already inside a nono session the launcher
 * started" assertion. Honoured only when the process HOLDS THE LAUNCHER'S
 * RELEASE for a live nono session bound to its own pid (`launch-attestation.ts`,
 * cli#350 round 4e); a caller that types the flag — TTY or not — or plants a
 * marker, shadows `ps`, or names itself `nono`, is refused like `--no-sandbox`.
 * It is an INTERNAL flag: it means "I was released by my launcher", never
 * "trust me" (cli#350 r4f); the interactive opt-out stays `--no-sandbox`. The
 * marker / parent check are HINTS only, never proof.
 */
export const SANDBOXED_FLAG = "--sandboxed";

/** Hint nono sets for its own child (nono >= 0.7x). Never used as proof. */
export const NONO_CHILD_ENV = "NONO_CAP_FILE";

/**
 * Set by generated units (launchd/systemd) in their environment. A refusal then
 * exits 0 instead of 78 — see the KeepAlive coupling note below.
 */
export const SUPERVISED_ENV = "TPS_SUPERVISED";

/** Exit code for a refusal when NOT running under a supervisor (sysexits: EX_CONFIG). */
export const REFUSAL_EXIT_CODE = 78;

/**
 * KeepAlive coupling (measured, Sherlock):
 *   - `{Crashed:true}` restarts only on *signal* death — `exit 78` gives 1 launch.
 *   - `{SuccessfulExit:false}` + `exit 78` gives 13 relaunches in 12 s.
 * Generated agent units therefore pair `{SuccessfulExit:false}` with "the
 * launcher logs the refusal and exits 0" (`${SUPERVISED_ENV}=1`). A refusal is a
 * clean exit 0 → no relaunch storm; a genuine crash is non-zero/signal → relaunch.
 */
export const SUPERVISED_REFUSAL_EXIT_CODE = 0;

/** `--quiet-nono-check` (renamed from `--nonono`): only skips the loud check. */
export const QUIET_NONO_CHECK_FLAG = "--quiet-nono-check";
/** Deprecated hidden alias, kept for one release. */
export const LEGACY_NONONO_FLAG = "--nonono";

export function isInteractiveTty(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout
): boolean {
  // Both ends must be a terminal: a piped stdin with a TTY stdout (or vice
  // versa) is scripted, not a human at the keyboard.
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPERVISED_ENV] === "1";
}

/**
 * HINT ONLY — never proof. The marker nono sets (any non-empty value is
 * forgeable by the caller) or a parent literally named nono (also forgeable:
 * `exec -a nono …`, or a shadowed `ps`). Used only for refusal wording.
 * Hardened where cheap: absolute `/bin/ps` and an exact comm match (no PATH
 * resolution, no substring).
 */
export function nonoLaunchHint(
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid
): boolean {
  if (env[NONO_CHILD_ENV]) return true;
  try {
    if (readFileSync(`/proc/${ppid}/comm`, "utf-8").trim() === "nono") return true;
  } catch {
    // not Linux, or /proc unreadable — fall back to ps
  }
  const ps = spawnSync("/bin/ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf-8" });
  return (ps.stdout ?? "").trim() === "nono";
}

/**
 * PROOF OF CONFINEMENT is the LAUNCHER's, verified from outside the sandbox
 * (cli#350 round 4e). The child cannot attest its own confinement: nono 0.74.0
 * exposes no in-sandbox validation and strips inherited fds, and every
 * in-process signal (a marker, a parent's name, a denied filesystem write) is
 * either forgeable or absent on the plain launch. Under `--sandboxed` the
 * child therefore holds the launcher's release, over a launcher-owned unix
 * socket, for a LIVE nono session bound to the pid the launcher spawned AND to
 * the pid this process reports. `attestConfinement()` in
 * `launch-attestation.ts` performs that handshake; the gate only consumes the
 * verdict.
 */
export interface ConfinementVerdict {
  released: boolean;
  /** Why the release is absent (used in the refusal wording). */
  reason?: string;
}

/**
 * Commands that hand control to an agent. These are exactly the commands that
 * generated units invoke, and the ones that must assert `--sandbox-required`
 * when there is no TTY to ask.
 */
export function launchesAgent(command: string | undefined, rest: readonly string[] = []): boolean {
  const sub = rest[0];
  if (command === "agent") return sub === "start";
  if (command === "mail") return sub === "watch";
  if (command === "office") return sub === "connect";
  return false;
}

export function readLaunchFlags(argv: readonly string[], parsedFlags?: Record<string, unknown>): {
  sandboxRequired: boolean; noSandbox: boolean; refusal?: string;
} {
  const title = process.title;
  const parse = (args: readonly string[], flags: typeof launchFlagDefinitions | Record<string, never>) =>
    meow("", { importMeta: import.meta, argv: [...args], flags, autoHelp: false, autoVersion: false }).flags;
  const booleanValue = (value: unknown): boolean => {
    if (value === undefined || value === false || value === "false") return false;
    if (value === true || value === "true") return true;
    throw new Error("cannot interpret sandbox flag value");
  };
  try {
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--") break;
      if (!arg.startsWith("--")) continue;
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const raw = parse([name], {});
      if (!["sandboxRequired", "noSandbox", "sandbox", "noSandboxRequired", "sandboxed", "noSandboxed"]
        .some(key => Object.hasOwn(raw, key))) continue;
      const next = argv[i + 1];
      const value = equals !== -1 ? arg.slice(equals + 1)
        : next !== undefined && (!next.startsWith("-") || /^-\d/.test(next)) ? next : undefined;
      if (value !== undefined && value !== "true" && value !== "false") {
        throw new Error(`${name} accepts only 'true' or 'false'; received ${JSON.stringify(value)}`);
      }
    }
    const flags = parsedFlags ?? parse(argv.slice(2), launchFlagDefinitions);
    const noSandbox = booleanValue(flags.noSandbox);
    return {
      sandboxRequired: booleanValue(flags.sandboxRequired),
      noSandbox: flags.sandbox === false || noSandbox,
    };
  } catch (error) {
    return { sandboxRequired: false, noSandbox: false,
      refusal: `cannot interpret sandbox flag: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    process.title = title;
  }
}

export interface LaunchControlInput {
  /** Top-level command word (argv[2]). */
  command?: string;
  /** Remaining words after the command. */
  rest?: readonly string[];
  /** Full argv (defaults to process.argv). */
  argv?: readonly string[];
  /** Override TTY detection (tests). */
  interactiveTty?: boolean;
  parsedFlags?: Record<string, unknown>;
  /** Override supervisor detection (tests). */
  supervised?: boolean;
  /** The launcher's release verdict (see `launch-attestation.ts`). Absent when
   * this process never asked — anything but a release is a refusal. */
  confinement?: ConfinementVerdict;
}

export interface LaunchControlResult {
  allowed: boolean;
  /** Human-readable refusal naming the flag and the reason. */
  refusal?: string;
  /** Process exit code to use for the refusal (0 when supervised). */
  refusalExitCode: number;
}

export function evaluateLaunchControl(input: LaunchControlInput = {}): LaunchControlResult {
  const argv = input.argv ?? process.argv;
  const tty = input.interactiveTty ?? isInteractiveTty();
  const supervised = input.supervised ?? isSupervised();
  const refusalExitCode = supervised ? SUPERVISED_REFUSAL_EXIT_CODE : REFUSAL_EXIT_CODE;
  const deny = (refusal: string): LaunchControlResult => ({ allowed: false, refusal, refusalExitCode });

  const flags = readLaunchFlags(argv, input.parsedFlags);
  if (flags.refusal) return deny(flags.refusal);
  if (flags.sandboxRequired && flags.noSandbox) {
    return deny(`${SANDBOX_REQUIRED_FLAG} conflicts with ${NO_SANDBOX_FLAG}; remove ${NO_SANDBOX_FLAG} to require isolation.`);
  }

  // (1) --no-sandbox is honoured only from an interactive TTY.
  if (flags.noSandbox && !tty) {
    return deny(
      `${NO_SANDBOX_FLAG} is refused: it is only honoured from an interactive TTY ` +
        "(stdin AND stdout must both be terminals). This invocation is not interactive, " +
        "so the agent must launch under nono. Remove the flag, or run it yourself in a terminal.",
    );
  }

  // (1b) --sandboxed claims "already inside nono". Honour it only when the
  // LAUNCHER released this process (a live nono session bound to the pid it
  // spawned and to this pid, with enforcement verified behaviourally). The TTY
  // is irrelevant (cli#350 r4f): an un-released `--sandboxed` is refused
  // everywhere, because the interactive opt-out is `--no-sandbox`.
  if (argv.includes(SANDBOXED_FLAG) && !(input.confinement?.released ?? false)) {
    const hint = nonoLaunchHint();
    return deny(
      `${SANDBOXED_FLAG} is refused: no launcher released this process` +
        (input.confinement?.reason ? ` (${input.confinement.reason})` : "") +
        ". `" +
        SANDBOXED_FLAG +
        "` is a claim that a launcher holds a live nono session bound to this pid; nothing " +
        "in this process can establish that for itself, and " +
        (hint
          ? "the nono marker/parent hint is present but is not proof. "
          : "no launcher socket is in reach. ") +
        "Only a launch through the launcher — which starts nono itself, verifies it from " +
        "outside, and releases the child over its own socket — may assert it.",
    );
  }

  // (2) Non-interactive agent launch must assert --sandbox-required.
  if (launchesAgent(input.command, input.rest) && !tty && !flags.sandboxRequired) {
    const sub = input.rest?.[0] ?? "";
    return deny(
      `${SANDBOX_REQUIRED_FLAG} is required: this non-interactive context is launching an agent ` +
        `(\`${input.command} ${sub}\`) and the launcher did not assert it. A hand-edited plist, ` +
        `a stale wrapper or a dropped argument would otherwise run the agent unsandboxed. ` +
        `Refusing to launch.`,
    );
  }

  return { allowed: true, refusalExitCode: 0 };
}

/**
 * Apply `evaluateLaunchControl` to the current process: log and exit on refusal.
 * Safe to call unconditionally at the top of the launcher.
 */
export function enforceLaunchControl(input: LaunchControlInput = {}): void {
  const result = evaluateLaunchControl(input);
  if (result.allowed || !result.refusal) return;
  console.error(`❌ ${result.refusal}`);
  process.exit(result.refusalExitCode);
}
