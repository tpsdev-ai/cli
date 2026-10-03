import { join } from "node:path";
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
 * cli#395 — the adapter. `bun:sqlite` under bun, `node:sqlite` (`DatabaseSync`,
 * Node >= 22.13) under node, behind ONE interface (`open`, `run`, `all`). Same
 * file path and same schema, so a host's archive is one database whichever
 * runtime wrote it. Where NEITHER backend exists (a node older than 22.13, or
 * `node:sqlite` disabled) the archive degrades to a visible no-op: one named
 * warning per process, never a crash, never a silent loss without a trace.
 */
interface SqliteAdapter {
  /** Open (creating it if needed) the DB at `dbPath`, set the shared PRAGMAs, apply the schema. */
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

// migration (cli#429): reply-to threading. `CREATE TABLE IF NOT EXISTS` does not
// add a column to a table that already exists, so a pre-#429 archive.db needs an
// explicit ALTER; a fresh DB has no such column either, so the ALTER adds it
// there too. The second call on an already-migrated DB throws "duplicate column
// name", which is the idempotence guard and is swallowed.
const MIGRATE_SQL = "ALTER TABLE archive ADD COLUMN replyToId TEXT";

/**
 * Both runtimes may write the same file, so both set the SAME concurrency
 * settings: WAL (a writer never blocks a reader) and a 5 s busy timeout (a
 * second writer waits rather than failing with SQLITE_BUSY). Best-effort: a
 * transient failure to set them must not drop the event this open exists for.
 */
function applyPragmas(exec: (sql: string) => void): void {
  for (const sql of ["PRAGMA busy_timeout = 5000;", "PRAGMA journal_mode = WAL;"]) {
    try {
      exec(sql);
    } catch {
      /* best effort — the write below still runs */
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
    applyPragmas((sql) => db.exec(sql));
    db.exec(SCHEMA_SQL);
    try {
      db.exec(MIGRATE_SQL);
    } catch {
      /* column already present */
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
    applyPragmas((sql) => db.exec(sql));
    db.exec(SCHEMA_SQL);
    try {
      db.exec(MIGRATE_SQL);
    } catch {
      /* column already present */
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
  } catch {
    bunSqlite = null;
  }
  return bunSqlite as ReturnType<typeof loadBunSqlite>;
}

let nodeSqlite: unknown | null | undefined;
function loadNodeSqlite(): { DatabaseSync: new (path: string) => SqliteHandle } | null {
  if (nodeSqlite !== undefined) return nodeSqlite as ReturnType<typeof loadNodeSqlite>;
  try {
    nodeSqlite = createRequire(import.meta.url)("node:sqlite");
  } catch {
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
  if (node?.DatabaseSync) return new NodeSqliteAdapter(node.DatabaseSync);
  return null;
}

// ONE stderr line per process, however many entry points hit the degraded path:
// the audit gap must be visible, never silent — but it must not flood logs.
let warnedArchiveUnavailable = false;

const ARCHIVE_UNAVAILABLE_WARNING =
  "tps-mail archive: no sqlite backend in this runtime (neither bun:sqlite nor node:sqlite); mail events are not being logged";

function warnArchiveUnavailable(): void {
  if (warnedArchiveUnavailable) return;
  warnedArchiveUnavailable = true;
  console.error(ARCHIVE_UNAVAILABLE_WARNING);
}

function archiveDbPath(): string {
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  mkdirSync(dir, { recursive: true });
  return join(dir, "archive.db");
}

export function logEvent(event: Omit<ArchiveEvent, "timestamp">, body?: string): void {
  const adapter = createAdapter();
  if (adapter === null) {
    warnArchiveUnavailable();
    return;
  }
  try {
    adapter.open(archiveDbPath());
    adapter.run(
      `INSERT INTO archive (event, timestamp, sender, recipient, messageId, replyToId, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [event.event, new Date().toISOString(), event.from, event.to, event.messageId, event.replyToId ?? null, body || null],
    );
  } catch {
    // Best-effort audit logging.
  } finally {
    adapter.close();
  }
}

export function queryArchive(query: ArchiveQuery = {}): ArchiveEvent[] {
  const adapter = createAdapter();
  if (adapter === null) {
    warnArchiveUnavailable();
    return [];
  }
  try {
    adapter.open(archiveDbPath());
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
  } catch {
    return [];
  } finally {
    adapter.close();
  }
}
