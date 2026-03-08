import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { readOpenClawConfig, resolveConfigPath, getAgentList, type OpenClawConfig, type OpenClawAgent } from "../utils/config.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { workspacePath, resolveTeamId } from "../utils/workspace.js";
import { loadHostIdentity, loadHostIdentityId } from "../utils/identity.js";
import { randomUUID } from "node:crypto";

type BackupMode = "backup" | "restore";

interface BackupEntry {
  path: string;
  sha256: string;
  size: number;
}

interface Manifest {
  format: string;
  version: number;
  action: BackupMode;
  agentId: string;
  sourceAgentId?: string;
  backupAt: string;
  sourceHostFingerprint: string;
  sourceHostId: string;
  cliVersion: string;
  files: BackupEntry[];
}

export interface BackupArgs {
  agentId?: string;
  keep?: number;
  schedule?: string;
  from?: string;
  sanitize?: boolean;
  configPath?: string;
}

export interface RestoreArgs {
  agentId: string;
  archivePath: string;
  force?: boolean;
  overwrite?: boolean;
  clone?: boolean;
  configPath?: string;
}

const DEFAULT_KEEP = 7;
const REQUIRED_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];

const SCHEDULE_ON = ["daily", "hourly", "weekly"] as const;

function sha256String(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sanitizeAgentId(agentId: string): string {
  const safe = sanitizeIdentifier(agentId);
  if (safe !== agentId) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
  return safe;
}

function ensureNoTraversal(path: string): void {
  if (path.startsWith("..") || path.includes(`${sep}..${sep}`) || path.includes("/../") || path.includes("\\..\\") || path.startsWith("/")) {
    throw new Error(`Unsafe path in manifest: ${path}`);
  }
}

function isAbsoluteLike(value: string): boolean {
  return /^(?:[a-zA-Z]:\\|\/{2}|\/|~\/)/.test(value);
}

function walkDirectory(root: string, relPrefix = ""): string[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];

  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const next = join(root, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const nested = walkDirectory(next, rel);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function copyDirectoryRecursive(source: string, destination: string): void {
  if (!existsSync(source)) return;
  if (!existsSync(destination)) mkdirSync(destination, { recursive: true });

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const srcPath = join(source, entry.name);
    const dstPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
    }
  }
}

function checksumForText(value: string): string {
  return sha256String(value);
}

function findSensitiveToolPatterns(content: string): string[] {
  const findings: string[] = [];
  const patterns = [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?/g,
    /(?:api[_-]?key|token|secret|password|auth[_-]?token)\s*[:=]\s*[^\s]+/gi,
  ];

  for (const p of patterns) {
    const matches = content.match(p);
    if (matches?.length) {
      findings.push(...matches);
    }
  }

  return Array.from(new Set(findings));
}

function normalizeConfigEntry(entry: OpenClawAgent): OpenClawAgent {
  return {
    ...entry,
    workspace: undefined,
    agentDir: undefined,
  } as OpenClawAgent;
}

async function currentHostFingerprint(): Promise<string> {
  try {
    const id = await loadHostIdentity();
    return id.fingerprint;
  } catch {
    return loadHostIdentityId();
  }
}

function buildArchivePath(agentId: string, backupDir: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return join(backupDir, `${agentId}-${stamp}.tps-backup.tar.gz`);
}

function writeManifest(path: string, manifest: Manifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}

function readManifestFromArchive(tmpDir: string): Manifest {
  const manifestPath = join(tmpDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Invalid backup: manifest.json missing");
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new Error("Invalid backup: manifest is not valid JSON");
  }

  if (manifest.format !== "tps-backup") {
    throw new Error("Invalid backup format");
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error("Invalid backup manifest: files");
  }

  for (const entry of manifest.files) {
    ensureNoTraversal(entry.path);
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid checksum for ${entry.path}`);
    }
    if (typeof entry.size !== "number") {
      throw new Error(`Missing size for ${entry.path}`);
    }
    if (entry.path.includes("..")) throw new Error(`Unsafe manifest path: ${entry.path}`);
  }

  return manifest;
}

function runTarCreate(stagingDir: string, archivePath: string): void {
  const cmd = ["tar", "-czf", archivePath, "-C", stagingDir, "."];
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf-8" });
  // GNU tar exits 1 for "file changed as we read it" — archive is still valid
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`tar create failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
}

function runTarList(archivePath: string): string[] {
  const res = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`Failed to list backup archive: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function runTarExtract(archivePath: string, targetDir: string): void {
  const res = spawnSync("tar", ["-xzf", archivePath, "-C", targetDir], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`tar extract failed: ${res.stderr || res.stdout}`);
  }
}

function findOpenClawAgentEntry(config: OpenClawConfig, agentId: string): OpenClawAgent | undefined {
  const agents = getAgentList(config);
  return agents.find((a) => a.id === agentId);
}

function upsertConfigAgent(configPath: string, agent: OpenClawAgent, workspace: string, targetAgentId: string): void {
  const config: OpenClawConfig = existsSync(configPath) ? readOpenClawConfig(configPath) : {};
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.workspace = workspace;

  const list = config.agents.list ?? [];
  const normalized: OpenClawAgent = {
    ...agent,
    id: targetAgentId,
    workspace,
    agentDir: workspace,
  };

  const existingIdx = list.findIndex((a) => a.id === targetAgentId);
  if (existingIdx >= 0) {
    list[existingIdx] = normalized;
  } else {
    list.push(normalized);
  }

  config.agents.list = list;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function workspaceArchiveFiles(workspace: string, includePattern: string[]): string[] {
  const present: string[] = [];
  for (const file of includePattern) {
    const path = join(workspace, file);
    if (existsSync(path)) {
      present.push(file);
    }
  }

  // memory/*.md
  const memoryDir = join(workspace, "memory");
  if (existsSync(memoryDir) && lstatSync(memoryDir).isDirectory()) {
    for (const rel of walkDirectory(memoryDir)) {
      if (rel.endsWith(".md")) {
        present.push(`memory/${rel}`);
      }
    }
  }

  return Array.from(new Set(present));
}

function stageFile(sourceRoot: string, sourceRel: string, stagingRoot: string, archiveRel?: string): BackupEntry {
  const sourcePath = join(sourceRoot, sourceRel);
  const targetRel = archiveRel ?? sourceRel;
  const targetPath = join(stagingRoot, targetRel);
  if (!existsSync(sourcePath)) {
    throw new Error(`Required path missing: ${sourceRel}`);
  }

  const content = readFileSync(sourcePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
  return {
    path: targetRel,
    size: content.length,
    sha256: sha256String(content.toString("utf-8")),
  };
}

function stageFromString(stagingRoot: string, archiveRel: string, content: string): BackupEntry {
  const p = join(stagingRoot, archiveRel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf-8");
  return {
    path: archiveRel,
    size: Buffer.byteLength(content, "utf-8"),
    sha256: checksumForText(content),
  };
}

function readCronEntries(): string[] {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf-8" });
  if (r.status !== 0) return [];
  return (r.stdout || "").split("\n").filter(Boolean);
}

function writeCronEntries(lines: string[]): void {
  const payload = lines.join("\n") + (lines.length ? "\n" : "");
  const r = spawnSync("crontab", ["-"], {
    encoding: "utf-8",
    input: payload,
  });
  if (r.status !== 0) {
    throw new Error(`Failed to update crontab: ${r.stderr || r.stdout}`);
  }
}

function scheduleLine(agentId: string, keep: number): string {
  const safeId = sanitizeIdentifier(agentId);
  const keepArg = Number.isFinite(keep) && keep > 0 ? Math.trunc(keep) : DEFAULT_KEEP;
  const nodePath = process.execPath;
  const cliPath = process.argv[1] ?? "tps";
  const line = `0 3 * * * ${nodePath} ${JSON.stringify(cliPath)} backup ${safeId} --keep ${keepArg}`;
  return `${line} # tps-backup:${safeId}`;
}

async function ensureVaultForSchedule(): Promise<void> {
  if (!process.env.TPS_VAULT_KEY) {
    throw new Error("Cannot schedule backups without TPS_VAULT_KEY in environment");
  }
  await loadHostIdentity();
}

function configureSchedule(agentId: string, action: "on" | "off", keep: number): void {
  const safeId = sanitizeIdentifier(agentId);
  const marker = `# tps-backup:${safeId}`;
  const existing = readCronEntries().filter((line) => !line.includes(marker));

  if (action === "off") {
    writeCronEntries(existing);
    return;
  }

  existing.push(scheduleLine(safeId, keep));
  writeCronEntries(existing);
}

function archiveHash(archivePath: string): string {
  return sha256File(archivePath);
}

function validateBackupFilesFromManifest(tmpDir: string, manifest: Manifest): void {
  for (const entry of manifest.files) {
    const extractedPath = join(tmpDir, entry.path);
    if (!existsSync(extractedPath)) {
      throw new Error(`Missing archived file: ${entry.path}`);
    }

    const data = readFileSync(extractedPath);
    if (sha256String(data.toString("utf-8")) !== entry.sha256) {
      throw new Error(`Checksum mismatch: ${entry.path}`);
    }

    if (data.length !== entry.size) {
      throw new Error(`Size mismatch: ${entry.path}`);
    }
  }
}

function parseSensitiveFindings(content?: string): string[] {
  if (!content) return [];
  return findSensitiveToolPatterns(content);
}

function applyCloneIdentityReplacements(root: string, newAgentId: string): void {
  const soul = join(root, "SOUL.md");
  const identity = join(root, "IDENTITY.md");

  if (existsSync(soul)) {
    const lines = readFileSync(soul, "utf-8").split(/\r?\n/);
    const rewritten = lines.map((line) => {
      if (line.startsWith("**Name:**")) {
        return `**Name:** ${newAgentId}`;
      }
      return line;
    });
    writeFileSync(soul, rewritten.join("\n"), "utf-8");
  }

  if (existsSync(identity)) {
    const lines = readFileSync(identity, "utf-8").split(/\r?\n/);
    const rewritten = lines.map((line) => {
      if (line.startsWith("**Name:**")) {
        return `**Name:** ${newAgentId}`;
      }
      if (line.startsWith("name:")) {
        return `name: ${newAgentId}`;
      }
      return line;
    });
    writeFileSync(identity, rewritten.join("\n"), "utf-8");
  }
}

function restoreWorkspaceFromArchive(targetWorkspace: string, extracted: string, manifest: Manifest, overwrite: boolean, clone: boolean): void {
  // Start with fresh workspace and restore file set.
  copyDirectoryRecursive(join(extracted, "workspace"), targetWorkspace);

  for (const item of manifest.files) {
    if (!item.path.startsWith("workspace/")) continue;

    const rel = item.path.substring("workspace/".length);
    const sourcePath = join(extracted, item.path);
    const destPath = join(targetWorkspace, rel);
    mkdirSync(dirname(destPath), { recursive: true });

    if (!overwrite && existsSync(destPath)) {
      continue;
    }

    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, destPath);
    }
  }

  if (clone) {
    // Clone identity replacement is handled by caller with target agent id.
  }
}

function ensureNoSensitiveTools(toolsPath: string): void {
  const data = readFileSync(toolsPath, "utf-8");
  const findings = parseSensitiveFindings(data);
  if (findings.length) {
    console.warn(`⚠️  Potentially sensitive content in TOOLS.md: ${findings.join(", ")}`);
  }
}

function backupFilesWithManifest(workspace: string, entry: OpenClawAgent | null, backupState: string | null, doSanitize: boolean, tempDir: string): BackupEntry[] {
  const entries: BackupEntry[] = [];
  const required = workspaceArchiveFiles(workspace, REQUIRED_FILES);

  for (const rel of required) {
    const item = stageFile(workspace, rel, tempDir, `workspace/${rel}`);
    entries.push(item);

    if (rel === "TOOLS.md" && doSanitize) {
      ensureNoSensitiveTools(join(tempDir, `workspace/${rel}`));
    }
  }

  if (entry) {
    const clean = normalizeConfigEntry(entry);
    const openclawContent = JSON.stringify(clean, null, 2);
    entries.push(stageFromString(tempDir, "openclaw.agent.json", openclawContent));
    entries.push(stageFromString(tempDir, "roster-entry.json", openclawContent));
  }

  if (backupState) {
    entries.push(stageFromString(tempDir, "bootstrap-state.json", backupState));
  }

  return entries;
}

export async function runBackup(args: BackupArgs): Promise<void> {
  const safeId = sanitizeAgentId(args.agentId);
  const workspace = workspacePath(safeId);

  if (!existsSync(workspace)) {
    throw new Error(`Workspace not found for ${safeId}`);
  }

  const configPath = args.configPath ?? resolveConfigPath();
  let config: OpenClawConfig | null = null;
  let agentEntry: OpenClawAgent | null = null;
  if (configPath) {
    config = readOpenClawConfig(configPath);
    agentEntry = findOpenClawAgentEntry(config, safeId) ?? null;
  }

  if (!agentEntry) {
    agentEntry = { id: safeId, name: safeId, workspace };
  }

  const backupBase = join(process.env.HOME || "/", ".tps", "backups", safeId);
  mkdirSync(backupBase, { recursive: true });
  const archivePath = buildArchivePath(safeId, backupBase);

  const stagingDir = mkdtempSync(join(tmpdir(), "tps-backup-"));
  const finalArchiveTmp = join(stagingDir, `${safeId}.tps-backup.tar.gz`);

  try {
    const toolsPath = join(workspace, "TOOLS.md");
    const shouldSanitize = args.sanitize !== false;

    if (shouldSanitize && existsSync(toolsPath)) {
      const content = readFileSync(toolsPath, "utf-8");
      const findings = parseSensitiveFindings(content);
      if (findings.length) {
        console.warn(`⚠️  Possible sensitive values in TOOLS.md: ${findings.join(", ")}`);
      }
    }

    // Bootstrap state marker outside workspace.
    const teamId = resolveTeamId(safeId);
    const sourceMarker = join(process.env.HOME || "/", ".tps", "bootstrap-state", teamId, ".bootstrap-complete");
    const markerData = existsSync(sourceMarker)
      ? readFileSync(sourceMarker, "utf-8")
      : null;

    const staged = backupFilesWithManifest(workspace, agentEntry, markerData, shouldSanitize, stagingDir);

    const manifest: Manifest = {
      format: "tps-backup",
      version: 1,
      action: "backup",
      agentId: safeId,
      backupAt: new Date().toISOString(),
      sourceHostFingerprint: await currentHostFingerprint(),
      sourceHostId: await loadHostIdentityId(),
      cliVersion: process.env.npm_package_version || "0.1.0",
      files: staged,
    };

    if (manifest.files.some((entry) => isAbsoluteLike(entry.path) || entry.path.startsWith("../") || entry.path.includes("/../"))) {
      throw new Error("Manifest contains absolute path entries");
    }

    const manifestPath = join(stagingDir, "manifest.json");
    writeManifest(manifestPath, manifest);

    const file = stageFromString(stagingDir, "manifest.json", JSON.stringify(manifest, null, 2));
    // keep manifest in manifest list (checksum included as part of validation)
    manifest.files.push(file);

    runTarCreate(stagingDir, finalArchiveTmp);
    chmodSync(finalArchiveTmp, 0o600);

    // Validate archive by listing and reading checksum from manifest.
    const listing = runTarList(finalArchiveTmp);
    if (listing.length === 0) throw new Error("Tar archive is empty");

    copyFileSync(finalArchiveTmp, archivePath);
    chmodSync(archivePath, 0o600);

    // rotate old backups
    const keep = Number.isFinite(args.keep || 0) ? Math.max(1, Math.trunc(args.keep!)) : DEFAULT_KEEP;
    const backups = readdirSync(backupBase)
      .filter((file) => file.endsWith(".tps-backup.tar.gz"))
      .filter((file) => file.startsWith(`${safeId}-`))
      .map((file) => ({ file, path: join(backupBase, file) }))
      .map((entry) => ({ ...entry, stats: statSync(entry.path) }))
      .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

    if (backups.length > keep) {
      for (const old of backups.slice(keep)) {
        rmSync(old.path, { force: true });
      }
    }

    if (args.schedule) {
      if (args.schedule === "off") {
        configureSchedule(safeId, "off", keep);
        console.log(`Removed scheduled backup for ${safeId}`);
      } else {
        if (!SCHEDULE_ON.includes(args.schedule as never)) {
          throw new Error(`Invalid schedule: ${args.schedule}`);
        }
        await ensureVaultForSchedule();
        configureSchedule(safeId, "on", keep);
        console.log(`Scheduled ${args.schedule} backup for ${safeId}`);
      }
    }

export async function runBackupSecrets(): Promise<void> {
  const home = homedir();
  const backupDir = join(home, ".tps", "backups");
  mkdirSync(backupDir, { recursive: true });

  const archivePath = join(backupDir, `backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  const includedFiles = Array.from(new Set([
    ...globSync(".tps/identity/*.key", { cwd: home }),
    ...globSync(".tps/secrets/**/*", { cwd: home }),
    ...globSync(".tps/agents/*/agent.yaml", { cwd: home }),
    ...globSync(".codex/auth.json", { cwd: home }),
  ])).filter((relativePath) => {
    const absolutePath = join(home, relativePath);
    return existsSync(absolutePath) && lstatSync(absolutePath).isFile();
  }).sort();

  if (includedFiles.length === 0) {
    console.log("No TPS backup files found.");
    return;
  }

  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const tarArgs = includedFiles.map(shellQuote).join(" ");
  execSync(`tar czf ${shellQuote(archivePath)} -C ${shellQuote(home)} ${tarArgs}`, {
    stdio: "pipe",
  });
  chmodSync(archivePath, 0o600);

  for (const relativePath of includedFiles) {
    console.log(relativePath);
  }

  console.log(`Archive: ${archivePath} (${statSync(archivePath).size} bytes)`);
}

export async function runRestore(args: RestoreArgs): Promise<void> {
  const safeTarget = sanitizeAgentId(args.agentId);
  const archive = resolve(args.archivePath);

  if (!existsSync(archive)) {
    throw new Error(`Backup archive not found: ${archive}`);
  }

  const entries = runTarList(archive);
  for (const entry of entries) ensureNoTraversal(entry);

  const tmpDir = mkdtempSync(join(tmpdir(), "tps-restore-"));
  try {
    runTarExtract(archive, tmpDir);

    const manifest = readManifestFromArchive(tmpDir);

    if (manifest.action !== "backup") {
      throw new Error("Invalid manifest action");
    }

    const hostFp = await currentHostFingerprint();
    if (manifest.sourceHostFingerprint !== hostFp && !args.force) {
      throw new Error(`Host fingerprint mismatch (${manifest.sourceHostFingerprint} != ${hostFp}); use --force to proceed`);
    }

    if (manifest.agentId !== safeTarget && !args.force && !args.clone && !args.overwrite) {
      throw new Error(`Manifest agent mismatch (${manifest.agentId} != ${safeTarget}); use --force or --clone`);
    }

    validateBackupFilesFromManifest(tmpDir, manifest);
    const targetWorkspace = workspacePath(safeTarget);

    const configPath = args.configPath ?? resolveConfigPath();
    const rosterPath = join(tmpDir, "roster-entry.json");
    const roster = existsSync(rosterPath) ? (JSON.parse(readFileSync(rosterPath, "utf-8")) as OpenClawAgent) : undefined;

    if (existsSync(targetWorkspace)) {
      const backupWs = `${targetWorkspace}.backup-${randomUUID()}`;
      renameSync(targetWorkspace, backupWs);

      let restoreSuccessful = false;
      try {
        mkdirSync(targetWorkspace, { recursive: true });
        copyDirectoryRecursive(backupWs, targetWorkspace);
        restoreWorkspaceFromArchive(targetWorkspace, tmpDir, manifest, args.overwrite ?? false, args.clone ?? false);

        if (args.clone) {
          applyCloneIdentityReplacements(targetWorkspace, safeTarget);
        }

        const gatewayCheck = spawnSync("openclaw", ["gateway", "status"], {
          stdio: "ignore",
          encoding: "utf-8",
          cwd: targetWorkspace,
          env: process.env,
        });
        if (gatewayCheck.status !== 0) {
          throw new Error("Bootstrap health check failed after restore");
        }

        rmSync(backupWs, { recursive: true, force: true });
        restoreSuccessful = true;

        if (roster && configPath) {
          upsertConfigAgent(configPath, args.clone ? { ...roster, id: safeTarget } : roster, targetWorkspace, safeTarget);
        }

        if (manifest.agentId !== safeTarget && args.clone) {
          // Keep clone identity in marker and manifest context
        }

        const restoreStateDir = join(process.env.HOME || "/", ".tps", "restore-state");
        mkdirSync(restoreStateDir, { recursive: true });

        const marker = {
          archive: archive,
          sourceAgentId: manifest.agentId,
          restoredAgentId: safeTarget,
          restoredAt: new Date().toISOString(),
          archiveHash: archiveHash(archive),
          clone: Boolean(args.clone),
          force: Boolean(args.force),
        };
        writeFileSync(
          join(restoreStateDir, `${safeTarget}.restore-complete`),
          JSON.stringify(marker, null, 2) + "\n",
          "utf-8"
        );

        console.log(`✅ Restore complete for ${safeTarget}`);
      } finally {
        if (!restoreSuccessful) {
          rmSync(targetWorkspace, { recursive: true, force: true });
          renameSync(backupWs, targetWorkspace);
        }
      }
    } else {
      mkdirSync(targetWorkspace, { recursive: true });
      restoreWorkspaceFromArchive(targetWorkspace, tmpDir, manifest, true, args.clone ?? false);

      if (args.clone) {
        applyCloneIdentityReplacements(targetWorkspace, safeTarget);
      }

      const gatewayCheck = spawnSync("openclaw", ["gateway", "status"], {
        stdio: "ignore",
        encoding: "utf-8",
        cwd: targetWorkspace,
        env: process.env,
      });
      if (gatewayCheck.status !== 0) {
        throw new Error("Bootstrap health check failed after restore");
      }

      if (roster && configPath) {
        upsertConfigAgent(configPath, args.clone ? { ...roster, id: safeTarget } : roster, targetWorkspace, safeTarget);
      }

      const restoreStateDir = join(process.env.HOME || "/", ".tps", "restore-state");
      mkdirSync(restoreStateDir, { recursive: true });
      writeFileSync(
        join(restoreStateDir, `${safeTarget}.restore-complete`),
        JSON.stringify({
          archive,
          sourceAgentId: manifest.agentId,
          restoredAgentId: safeTarget,
          restoredAt: new Date().toISOString(),
          archiveHash: archiveHash(archive),
          clone: Boolean(args.clone),
          force: Boolean(args.force),
        }, null, 2) + "\n",
        "utf-8"
      );

      console.log(`✅ Restore complete for ${safeTarget}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
