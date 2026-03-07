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
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { FlairClient } from "./flair-client.js";
import type { WorkspaceStateRecord } from "./flair-client.js";
import snooplogg from "snooplogg";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:workspace");


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
        slog(`[workspace] Stashed uncommitted changes: ${stashMsg}`);
      } else {
        // Stash failed — checkpoint to recovery branch instead
        const recoveryBranch = `recovery/${Date.now()}`;
        validateRef(recoveryBranch);
        this.gitOrThrow("checkout", "-b", recoveryBranch);
        this.gitOrThrow("add", "-A");
        this.git("commit", "--author", this.author, "-m", `WIP: recovery before reset`);
        swarn(`[workspace] Stash failed — saved to branch ${recoveryBranch}`);
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
      swarn(`[workspace] ⚠️ ${msg} — proceeding with current state`);
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

// ── FilesystemWorkspaceProvider ─────────────────────────────────────────────

/** Always excluded from snapshots — security-sensitive files (S47-D) */
const ALWAYS_EXCLUDE = [".env", "*.key", "*.pem", "secrets/", ".tps/snapshots/"];

export interface FilesystemWorkspaceConfig {
  snapshotDir?: string;       // default: .tps/snapshots
  maxSnapshots?: number;      // rotation limit, default 10
  excludePatterns?: string[]; // additional glob patterns to skip
  flair?: FlairClient;        // optional — for checkpoint() to write to Flair
  agentId?: string;           // required if flair is provided
}

export class FilesystemWorkspaceProvider implements WorkspaceProvider {
  readonly type = "filesystem";

  private readonly cwd: string;
  private readonly snapshotDir: string;
  private readonly maxSnapshots: number;
  private readonly excludePatterns: string[];
  private readonly flair?: FlairClient;
  private readonly agentId?: string;

  constructor(cwd: string, config: FilesystemWorkspaceConfig = {}) {
    this.cwd = resolve(cwd);
    this.snapshotDir = resolve(cwd, config.snapshotDir ?? ".tps/snapshots");
    this.maxSnapshots = config.maxSnapshots ?? 10;
    this.excludePatterns = [
      ...ALWAYS_EXCLUDE,
      ...(config.excludePatterns ?? []),
    ];
    this.flair = config.flair;
    this.agentId = config.agentId;

    // S47-D: snapshotDir must be inside workspace
    this.assertInsideWorkspace(this.snapshotDir);
    mkdirSync(this.snapshotDir, { recursive: true });
  }

  // ── Security (S47-D) ─────────────────────────────────────────────────────

  private assertInsideWorkspace(p: string): void {
    const resolved = resolve(p);
    if (!resolved.startsWith(this.cwd + "/") && resolved !== this.cwd) {
      throw new Error(`Path traversal blocked: "${p}" is outside workspace "${this.cwd}"`);
    }
  }

  private validateSnapshotRef(ref: string): string {
    // Ref must be a simple filename — no slashes, no .., no absolute paths
    if (ref.includes("/") || ref.includes("\\") || ref.includes("..") || isAbsolute(ref)) {
      throw new Error(`Invalid snapshot ref: "${ref}" — must be a simple filename`);
    }
    const fullPath = join(this.snapshotDir, ref);
    this.assertInsideWorkspace(fullPath);
    return fullPath;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private tarExcludeArgs(): string[] {
    const args: string[] = [];
    // Exclude the snapshot dir relative to cwd
    const relSnapshotDir = relative(this.cwd, this.snapshotDir);
    args.push(`--exclude=${relSnapshotDir}`);
    for (const pattern of this.excludePatterns) {
      args.push(`--exclude=${pattern}`);
    }
    return args;
  }

  private listSnapshots(): string[] {
    if (!existsSync(this.snapshotDir)) return [];
    return readdirSync(this.snapshotDir)
      .filter(f => f.endsWith(".tar.gz"))
      .sort(); // lexicographic = chronological since filenames start with timestamp
  }

  private rotateSnapshots(): void {
    const snapshots = this.listSnapshots();
    const excess = snapshots.length - this.maxSnapshots;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const fullPath = join(this.snapshotDir, snapshots[i]);
      try { unlinkSync(fullPath); } catch {}
    }
  }

  // ── WorkspaceProvider ─────────────────────────────────────────────────────

  async snapshot(label?: string): Promise<WorkspaceState> {
    const ts = new Date().toISOString();
    const safeTs = ts.replace(/[:.]/g, "-");
    const safeLabel = (label ?? "snapshot").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeTs}-${safeLabel}.tar.gz`;
    const fullPath = join(this.snapshotDir, filename);

    const args = [
      "czf", fullPath,
      ...this.tarExcludeArgs(),
      "-C", this.cwd,
      ".",
    ];

    // S47-A: shell: false (spawnSync default)
    const result = spawnSync("tar", args, { encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(`tar snapshot failed: ${result.stderr ?? result.stdout ?? "unknown error"}`);
    }

    this.rotateSnapshots();

    return {
      ref: filename,
      label: label ?? `snapshot-${safeTs}`,
      timestamp: ts,
      provider: "filesystem",
      metadata: { snapshotDir: this.snapshotDir },
    };
  }

  async reset(to: StateRef): Promise<void> {
    const ref = typeof to === "string" ? to : to.ref;
    const fullPath = this.validateSnapshotRef(ref);

    if (!existsSync(fullPath)) {
      throw new Error(`Snapshot not found: ${ref}`);
    }

    // Backup current state before reset
    try {
      await this.snapshot("pre-reset-backup");
    } catch {
      // non-fatal — proceed with reset
    }

    // Extract snapshot over cwd
    const args = [
      "xzf", fullPath,
      "-C", this.cwd,
    ];

    const result = spawnSync("tar", args, { encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(`tar reset failed: ${result.stderr ?? result.stdout ?? "unknown error"}`);
    }
  }

  async checkpoint(label: string, message?: string): Promise<WorkspaceState> {
    const state = await this.snapshot(label);

    // Write to Flair if configured
    if (this.flair && this.agentId) {
      try {
        const record: WorkspaceStateRecord = {
          id: `${this.agentId}-${Date.now()}`,
          agentId: this.agentId,
          ref: state.ref,
          label: state.label ?? label,
          provider: "filesystem",
          timestamp: state.timestamp,
          metadata: message ? JSON.stringify({ message }) : undefined,
          summary: message,
          createdAt: state.timestamp,
        };
        await this.flair.writeWorkspaceState(record);
      } catch (err: any) {
        swarn(`[workspace] Flair checkpoint write failed (non-fatal): ${err.message}`);
      }
    }

    return state;
  }

  async diff(from: StateRef): Promise<WorkspaceChanges> {
    const ref = typeof from === "string" ? from : from.ref;
    const fullPath = this.validateSnapshotRef(ref);

    if (!existsSync(fullPath)) {
      return { summary: `Snapshot ${ref} not found`, files: [] };
    }

    // Extract old snapshot to temp dir
    const tempDir = join(tmpdir(), `tps-diff-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const extractResult = spawnSync("tar", ["xzf", fullPath, "-C", tempDir], { encoding: "utf-8" });
    if (extractResult.status !== 0) {
      return { summary: `Failed to extract snapshot: ${extractResult.stderr}`, files: [] };
    }

    // Diff file trees
    const diffResult = spawnSync("diff", ["-rq", tempDir, this.cwd], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    // Clean up temp dir
    spawnSync("rm", ["-rf", tempDir]);

    const stdout = (diffResult.stdout ?? "").trim();
    const lines = stdout ? stdout.split("\n") : [];

    // Parse diff output: "Files X and Y differ" or "Only in X: file"
    const files: string[] = [];
    for (const line of lines) {
      // Skip snapshot dir entries
      if (line.includes(".tps/snapshots")) continue;
      const onlyIn = line.match(/^Only in (.+): (.+)$/);
      if (onlyIn) {
        const dir = onlyIn[1];
        const name = onlyIn[2];
        const fullFile = join(dir, name);
        const rel = fullFile.startsWith(this.cwd) ? relative(this.cwd, fullFile) : relative(tempDir, fullFile);
        files.push(rel);
      }
      const differ = line.match(/^Files .+ and (.+) differ$/);
      if (differ) {
        const rel = relative(this.cwd, differ[1]);
        files.push(rel);
      }
    }

    return {
      summary: `${files.length} file(s) changed since ${ref}`,
      files,
      details: stdout.slice(0, 10_000) || undefined,
    };
  }

  async baseline(): Promise<WorkspaceState> {
    const snapshots = this.listSnapshots();
    if (snapshots.length > 0) {
      const oldest = snapshots[0];
      return {
        ref: oldest,
        label: `baseline-${oldest}`,
        timestamp: oldest.split("-").slice(0, 3).join("-"), // approximate from filename
        provider: "filesystem",
      };
    }

    // No snapshots yet — snapshot current state as baseline
    return this.snapshot("baseline");
  }
}
