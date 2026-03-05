/**
 * workspace-provider.ts — Workspace lifecycle abstraction (OPS-47 Phase 1)
 *
 * Provides a provider interface for workspace state management.
 * Phase 1 ships GitWorkspaceProvider; filesystem and API providers come later.
 *
 * Security:
 *   S47-A: All git ops use spawnSync with shell: false, array args, ref validation
 *   S47-B: failureMode controls baseline() failure behavior (warn vs hard)
 *   S47-C: State is agent-scoped — no cross-agent reset()
 */

import { spawnSync } from "node:child_process";

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface WorkspaceState {
  ref: string;                         // opaque reference (git SHA, snapshot ID)
  label?: string;                      // human-readable ("pre-task-42")
  timestamp: string;                   // ISO 8601
  provider: string;                    // "git" | "filesystem" | "api"
  metadata?: Record<string, unknown>;  // provider-specific
}

export interface WorkspaceChanges {
  summary: string;       // human-readable diff summary
  files?: string[];      // changed file paths
  details?: string;      // full diff or change log
}

export type StateRef = string | WorkspaceState;

export interface WorkspaceProvider {
  readonly type: string;

  /** Capture current workspace state. Non-destructive. */
  snapshot(label?: string): Promise<WorkspaceState>;

  /** Reset workspace to a known state. Destructive. */
  reset(to: StateRef): Promise<void>;

  /** Save current state with a label (like git commit). */
  checkpoint(label: string, message?: string): Promise<WorkspaceState>;

  /** What changed since a given state ref. */
  diff(from: StateRef): Promise<WorkspaceChanges>;

  /** Get the "known good" baseline state (e.g. origin/main). */
  baseline(): Promise<WorkspaceState>;
}

// ── Ref validation (S47-A) ─────────────────────────────────────────────────

const SAFE_REF_RE = /^[a-zA-Z0-9._\/-]+$/;

function validateRef(ref: string): void {
  if (!SAFE_REF_RE.test(ref)) {
    throw new Error(`Invalid ref: "${ref}" — must match ${SAFE_REF_RE}`);
  }
}

function resolveRef(to: StateRef): string {
  const ref = typeof to === "string" ? to : to.ref;
  validateRef(ref);
  return ref;
}

// ── GitWorkspaceProvider ───────────────────────────────────────────────────

export interface GitWorkspaceConfig {
  remote?: string;                       // default: "origin"
  baseBranch?: string;                   // default: "main"
  author?: string;                       // "Ember <ember@tps.dev>"
  failureMode?: "warn" | "hard";         // baseline() failure behavior
}

export class GitWorkspaceProvider implements WorkspaceProvider {
  readonly type = "git";

  private readonly cwd: string;
  private readonly remote: string;
  private readonly baseBranch: string;
  private readonly author: string;
  private readonly failureMode: "warn" | "hard";

  /** Track refs we've produced — only accept our own refs (S47-A) */
  private readonly knownRefs = new Set<string>();

  constructor(cwd: string, config: GitWorkspaceConfig = {}) {
    this.cwd = cwd;
    this.remote = config.remote ?? "origin";
    this.baseBranch = config.baseBranch ?? "main";
    this.author = config.author ?? "Agent <agent@tps.dev>";
    this.failureMode = config.failureMode ?? "warn";
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private git(...args: string[]): { stdout: string; stderr: string; ok: boolean } {
    const result = spawnSync("git", args, {
      cwd: this.cwd,
      encoding: "utf-8",
      // S47-A: shell: false is the default for spawnSync — never override
    });
    return {
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      ok: result.status === 0,
    };
  }

  private gitOrThrow(...args: string[]): string {
    const r = this.git(...args);
    if (!r.ok) {
      throw new Error(`git ${args[0]} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  private isClean(): boolean {
    return this.git("status", "--porcelain").stdout === "";
  }

  private headSha(): string {
    return this.gitOrThrow("rev-parse", "HEAD");
  }

  private currentBranch(): string | null {
    const r = this.git("rev-parse", "--abbrev-ref", "HEAD");
    return r.ok && r.stdout !== "HEAD" ? r.stdout : null;
  }

  private registerRef(ref: string): void {
    this.knownRefs.add(ref);
  }

  private assertKnownRef(ref: string): void {
    if (!this.knownRefs.has(ref)) {
      throw new Error(
        `Ref "${ref}" was not produced by this provider. ` +
        `Only refs from snapshot(), checkpoint(), or baseline() are accepted (S47-A).`
      );
    }
  }

  // ── WorkspaceProvider ──────────────────────────────────────────────────

  async snapshot(label?: string): Promise<WorkspaceState> {
    const sha = this.headSha();
    const branch = this.currentBranch();
    const dirty = !this.isClean();

    this.registerRef(sha);

    return {
      ref: sha,
      label: label ?? (dirty ? `snapshot-dirty-${sha.slice(0, 7)}` : `snapshot-${sha.slice(0, 7)}`),
      timestamp: new Date().toISOString(),
      provider: "git",
      metadata: {
        branch,
        dirty,
      },
    };
  }

  async reset(to: StateRef): Promise<void> {
    const ref = resolveRef(to);
    this.assertKnownRef(ref);

    // Auto-stash uncommitted work (S47: reset() finds uncommitted work)
    if (!this.isClean()) {
      const stashMsg = `auto-stash: pre-reset ${new Date().toISOString()}`;
      const stash = this.git("stash", "push", "-m", stashMsg);
      if (stash.ok) {
        console.log(`[workspace] Stashed uncommitted changes: ${stashMsg}`);
      } else {
        // Stash failed — checkpoint to recovery branch instead
        const recoveryBranch = `recovery/${Date.now()}`;
        validateRef(recoveryBranch);
        this.gitOrThrow("checkout", "-b", recoveryBranch);
        this.gitOrThrow("add", "-A");
        this.git("commit", "--author", this.author, "-m", `WIP: recovery before reset`);
        console.warn(`[workspace] Stash failed — saved to branch ${recoveryBranch}`);
      }
    }

    // S47-A: double-dash separator prevents ref/path ambiguity
    // Use checkout for SHA refs
    const result = this.git("checkout", ref, "--");
    if (!result.ok) {
      // reset() failure → fail hard (Kern's review)
      throw new Error(`workspace reset failed: ${result.stderr}`);
    }
  }

  async checkpoint(label: string, message?: string): Promise<WorkspaceState> {
    // No-op if working tree is clean
    if (this.isClean()) {
      const sha = this.headSha();
      this.registerRef(sha);
      return {
        ref: sha,
        label,
        timestamp: new Date().toISOString(),
        provider: "git",
        metadata: { branch: this.currentBranch(), noop: true },
      };
    }

    this.gitOrThrow("add", "-A");
    this.gitOrThrow("commit", "--author", this.author, "-m", message ?? label);

    const sha = this.headSha();
    this.registerRef(sha);

    return {
      ref: sha,
      label,
      timestamp: new Date().toISOString(),
      provider: "git",
      metadata: { branch: this.currentBranch() },
    };
  }

  async diff(from: StateRef): Promise<WorkspaceChanges> {
    const ref = resolveRef(from);

    // --name-only for file list
    const nameOnly = this.git("diff", "--name-only", `${ref}..HEAD`);
    const files = nameOnly.ok ? nameOnly.stdout.split("\n").filter(Boolean) : [];

    // --stat for summary
    const stat = this.git("diff", "--stat", `${ref}..HEAD`);
    const summary = stat.ok ? stat.stdout : `${files.length} file(s) changed`;

    // full diff for details (truncate if huge)
    const full = this.git("diff", `${ref}..HEAD`);
    const details = full.ok ? full.stdout.slice(0, 10_000) : undefined;

    return { summary, files, details };
  }

  async baseline(): Promise<WorkspaceState> {
    const remoteRef = `${this.remote}/${this.baseBranch}`;
    validateRef(remoteRef);

    // Fetch from origin
    const fetch = this.git("fetch", this.remote, this.baseBranch);
    if (!fetch.ok) {
      const msg = `Could not fetch baseline (${remoteRef}): ${fetch.stderr}`;
      if (this.failureMode === "hard") {
        throw new Error(msg);
      }
      // warn mode: proceed with last known state
      console.warn(`[workspace] ⚠️ ${msg} — proceeding with current state`);
      const sha = this.headSha();
      this.registerRef(sha);
      return {
        ref: sha,
        label: `fallback-current-${sha.slice(0, 7)}`,
        timestamp: new Date().toISOString(),
        provider: "git",
        metadata: { fallback: true, fetchError: fetch.stderr },
      };
    }

    // Resolve the remote ref SHA
    const sha = this.gitOrThrow("rev-parse", remoteRef);
    this.registerRef(sha);

    return {
      ref: sha,
      label: `baseline-${remoteRef}`,
      timestamp: new Date().toISOString(),
      provider: "git",
      metadata: { remote: this.remote, baseBranch: this.baseBranch },
    };
  }
}
