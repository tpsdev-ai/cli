import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

export interface ArchiveEvent {
  event: "sent" | "read" | "listed";
  timestamp: string;
  from: string;
  to: string;
  messageId: string;
  /** cli#429: the signed messageId this message replies to, when it is a reply. */
  replyToId?: string;
  body?: string;
  bodyPreview?: string;
}

export interface ArchiveQuery {
  agent?: string;
  since?: string;
  until?: string;
  event?: "sent" | "read" | "listed";
  search?: string;
  limit?: number;
}

/**
 * The mail archive is a best-effort audit log backed by SQLite.
 *
 * cli#394 — the scheme is NOT part of this module's static graph. A static
 * `import { Database } from "bun:sqlite"` made any runtime whose ESM loader does
 * not know `bun:` — i.e. NODE, which is what the OpenClaw gateway runs the
 * tps-mail plugin under — refuse to load this module, and with it every
 * importer. The binding is resolved lazily and synchronously below, so the
 * module graph stays loadable under both `import()` and `require()`.
 *
 * cli#395 — resolves `bun:sqlite` or `node:sqlite` at runtime.
 * Missing bindings produce one warning per process.
 */
interface SqliteAdapter {
  /** Open `dbPath`, attempt and verify the shared PRAGMAs, apply the schema. */
  open(dbPath: string): void;
  /** Run one parameterised write statement. */
  run(sql: string, params: readonly unknown[]): void;
  /** Run one parameterised read statement; returns its rows. */
  all(sql: string, params: readonly unknown[]): Record<string, unknown>[];
  /** Close the handle. */
  close(): void;
}

// Same schema on both backends: `archive` plus its FTS5 mirror and triggers.
// Every object is created with IF NOT EXISTS — a single idempotent statement,
// never DROP+CREATE — so two connections (one per runtime) that open the same
// file concurrently cannot race a CREATE against the other's DROP.
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT,
      timestamp TEXT,
      sender TEXT,
      recipient TEXT,
      messageId TEXT,
      body TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(body, content='archive', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS archive_ai AFTER INSERT ON archive BEGIN
      INSERT INTO archive_fts(rowid, body) VALUES (new.id, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS archive_ad AFTER DELETE ON archive BEGIN
      INSERT INTO archive_fts(archive_fts, rowid, body) VALUES('delete', old.id, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS archive_au AFTER UPDATE ON archive BEGIN
      INSERT INTO archive_fts(archive_fts, rowid, body) VALUES('delete', old.id, old.body);
      INSERT INTO archive_fts(rowid, body) VALUES (new.id, new.body);
    END;
`;

// cli#429: add reply threading; only a duplicate-column error is ignored.
const MIGRATE_SQL = "ALTER TABLE archive ADD COLUMN replyToId TEXT";

function applyPragmas(db: SqliteHandle, dbPath: string): void {
  for (const [setting, expected] of [["busy_timeout", 5000], ["journal_mode", "wal"]] as const) {
    try {
      db.exec(`PRAGMA ${setting} = ${expected};`);
      const row = db.prepare(`PRAGMA ${setting}`).all()[0];
      const actual = row && Object.values(row)[0];
      if (actual !== expected) {
        throw Object.assign(new Error(`expected ${expected}, read ${String(actual)}`), { code: "PRAGMA_MISMATCH" });
      }
    } catch (error) {
      warnArchiveError(dbPath, setting, error);
    }
  }
}

// The synchronous shape BOTH bindings expose: exec (multi-statement DDL),
// prepare(...).run(...) for a write and prepare(...).all(...) for a read.
interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}

class BunSqliteAdapter implements SqliteAdapter {
  private db: SqliteHandle | null = null;
  constructor(private readonly Database: new (path: string, opts: { create: true }) => SqliteHandle) {}
  open(dbPath: string): void {
    const db = new this.Database(dbPath, { create: true });
    this.db = db;
    applyPragmas(db, dbPath);
    db.exec(SCHEMA_SQL);
    try {
      db.exec(MIGRATE_SQL);
    } catch (error) {
      if (!isDuplicateColumn(error, "bun")) throw error;
    }
  }
  run(sql: string, params: readonly unknown[]): void {
    this.db?.prepare(sql).run(...params);
  }
  all(sql: string, params: readonly unknown[]): Record<string, unknown>[] {
    return this.db?.prepare(sql).all(...params) ?? [];
  }
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// `node:sqlite` — the same synchronous shape (DatabaseSync / StatementSync) since
// Node 22.13. Types come from the runtime; `createRequire` returns `any`.
class NodeSqliteAdapter implements SqliteAdapter {
  private db: SqliteHandle | null = null;
  constructor(private readonly DatabaseSync: new (path: string) => SqliteHandle) {}
  open(dbPath: string): void {
    const db = new this.DatabaseSync(dbPath);
    this.db = db;
    applyPragmas(db, dbPath);
    db.exec(SCHEMA_SQL);
    try {
      db.exec(MIGRATE_SQL);
    } catch (error) {
      if (!isDuplicateColumn(error, "node")) throw error;
    }
  }
  run(sql: string, params: readonly unknown[]): void {
    this.db?.prepare(sql).run(...params);
  }
  all(sql: string, params: readonly unknown[]): Record<string, unknown>[] {
    return this.db?.prepare(sql).all(...params) ?? [];
  }
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// `undefined` = not tried yet; `null` = tried, unavailable in this runtime.
let bunSqlite: unknown | null | undefined;
function loadBunSqlite(): { Database: new (path: string, opts: { create: true }) => SqliteHandle } | null {
  if (bunSqlite !== undefined) return bunSqlite as ReturnType<typeof loadBunSqlite>;
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
    bunSqlite = null;
    return null;
  }
  try {
    // bun resolves its own `bun:` builtins through require(); node never reaches this.
    bunSqlite = createRequire(import.meta.url)("bun:sqlite");
  } catch (error) {
    if (!isAbsentBinding(error, "bun:sqlite")) throw error;
    bunSqlite = null;
  }
  return bunSqlite as ReturnType<typeof loadBunSqlite>;
}

let nodeSqlite: unknown | null | undefined;
function loadNodeSqlite(): { DatabaseSync: new (path: string) => SqliteHandle } | null {
  if (nodeSqlite !== undefined) return nodeSqlite as ReturnType<typeof loadNodeSqlite>;
  try {
    nodeSqlite = createRequire(import.meta.url)("node:sqlite");
  } catch (error) {
    if (!isAbsentBinding(error, "node:sqlite")) throw error;
    nodeSqlite = null;
  }
  return nodeSqlite as ReturnType<typeof loadNodeSqlite>;
}

/**
 * Pick the runtime's SQLite binding. bun wins when present; otherwise
 * `node:sqlite`; `null` when neither exists (the visible no-op path).
 */
function createAdapter(): SqliteAdapter | null {
  const bun = loadBunSqlite();
  if (bun) return new BunSqliteAdapter(bun.Database);
  const node = loadNodeSqlite();
  if (node) return new NodeSqliteAdapter(node.DatabaseSync);
  return null;
}

let warnedArchiveUnavailable = false;

const ARCHIVE_UNAVAILABLE_WARNING =
  "tps-mail archive: no sqlite backend in this runtime (neither bun:sqlite nor node:sqlite); mail events are not being logged";

function warnArchiveUnavailable(): void {
  if (warnedArchiveUnavailable) return;
  warnedArchiveUnavailable = true;
  console.error(ARCHIVE_UNAVAILABLE_WARNING);
}

function isAbsentBinding(error: unknown, binding: string): boolean {
  const err = error as { code?: string; message?: string };
  return (err?.code === "ERR_UNKNOWN_BUILTIN_MODULE" && err.message === `No such built-in module: ${binding}`)
    || (err?.code === "MODULE_NOT_FOUND" && err.message?.startsWith(`Cannot find module '${binding}'`) === true);
}

function isDuplicateColumn(error: unknown, backend: "bun" | "node"): boolean {
  const err = error as { code?: string; errno?: number; errcode?: number; message?: string };
  const matchesBackend = backend === "bun" ? err?.errno === 1 : err?.code === "ERR_SQLITE_ERROR" && err.errcode === 1;
  return matchesBackend && err.message === "duplicate column name: replyToId";
}

const warnedArchiveErrors = new Set<string>();
function warnArchiveError(dbPath: string, operation: string, error: unknown): void {
  const err = error as { code?: string; errno?: number; errcode?: number; message?: string };
  const sqliteCode = err?.errno ?? err?.errcode;
  const code = err?.code ?? (sqliteCode === undefined ? "UNKNOWN_ERROR" : `SQLITE_ERRNO_${sqliteCode}`);
  const kind = `${operation}:${code}`;
  if (warnedArchiveErrors.has(kind)) return;
  warnedArchiveErrors.add(kind);
  console.error(`tps-mail archive: ${dbPath}: ${operation} [${code}]: ${err?.message ?? String(error)}`);
}

function archiveDbPath(): string {
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  return join(dir, "archive.db");
}

function closeAdapter(adapter: SqliteAdapter | null, dbPath: string): void {
  try {
    adapter?.close();
  } catch (error) {
    warnArchiveError(dbPath, "close", error);
  }
}

export function logEvent(event: Omit<ArchiveEvent, "timestamp">, body?: string): void {
  const dbPath = archiveDbPath();
  let adapter: SqliteAdapter | null = null;
  try {
    adapter = createAdapter();
    if (adapter === null) {
      warnArchiveUnavailable();
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    adapter.open(dbPath);
    adapter.run(
      `INSERT INTO archive (event, timestamp, sender, recipient, messageId, replyToId, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [event.event, new Date().toISOString(), event.from, event.to, event.messageId, event.replyToId ?? null, body || null],
    );
  } catch (error) {
    warnArchiveError(dbPath, "write", error);
  } finally {
    closeAdapter(adapter, dbPath);
  }
}

export function queryArchive(query: ArchiveQuery = {}): ArchiveEvent[] {
  const dbPath = archiveDbPath();
  let adapter: SqliteAdapter | null = null;
  try {
    adapter = createAdapter();
    if (adapter === null) {
      warnArchiveUnavailable();
      return [];
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    adapter.open(dbPath);
    let sql = "SELECT archive.event, archive.timestamp, archive.sender as 'from', archive.recipient as 'to', archive.messageId, archive.replyToId, archive.body FROM archive";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.search) {
      sql += " JOIN archive_fts ON archive.id = archive_fts.rowid";
      conditions.push("archive_fts MATCH ?");
      params.push(query.search);
    }
    if (query.agent) {
      conditions.push("(archive.sender = ? OR archive.recipient = ?)");
      params.push(query.agent, query.agent);
    }
    if (query.event) {
      conditions.push("archive.event = ?");
      params.push(query.event);
    }
    if (query.since) {
      conditions.push("archive.timestamp >= ?");
      params.push(query.since);
    }
    if (query.until) {
      conditions.push("archive.timestamp <= ?");
      params.push(query.until);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY archive.timestamp DESC";

    if (query.limit && query.limit > 0) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    return adapter.all(sql, params).map((r) => ({
      ...r,
      bodyPreview: r.body ? (String(r.body).length > 100 ? String(r.body).slice(0, 100) + "..." : String(r.body)) : undefined,
    })) as ArchiveEvent[];
  } catch (error) {
    warnArchiveError(dbPath, "read", error);
    return [];
  } finally {
    closeAdapter(adapter, dbPath);
  }
}
