import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

export interface ArchiveEvent {
  event: "sent" | "read" | "listed";
  timestamp: string;
  from: string;
  to: string;
  messageId: string;
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
 * The mail archive is a best-effort audit log backed by `bun:sqlite`.
 *
 * It used to be a STATIC `import { Database } from "bun:sqlite"`. That made the
 * scheme part of this module's static graph, so any runtime whose ESM loader
 * does not know `bun:` — i.e. NODE, which is what the OpenClaw gateway runs the
 * tps-mail plugin under — refused to load this module. Because utils/mail.ts
 * imports this file eagerly (and the plugin imports utils/mail), a single
 * unconditional `bun:` import took down every importer: the gateway started
 * with the plugin missing and reviewer mail was dead. Every test ran under
 * `bun test`, where `bun:sqlite` resolves, so nothing caught it.
 *
 * Resolve the sqlite binding ONLY when a bun runtime is actually present, so
 * the module graph is portable and the archive is a genuinely optional
 * dependency at runtime. Under bun nothing changes: same DB path, same schema,
 * same behaviour. Under node the archive degrades to a visible no-op (below).
 */
let bunSqlite: any | null = null;
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  // @ts-ignore — `bun:sqlite` has no type declarations outside the bun runtime.
  bunSqlite = await import("bun:sqlite");
}

// ONE stderr line per process, however many entry points hit the degraded path:
// the audit gap must be visible, never silent — but it must not flood logs.
let warnedArchiveUnavailable = false;

function warnArchiveUnavailable(): void {
  if (warnedArchiveUnavailable) return;
  warnedArchiveUnavailable = true;
  console.error(
    "mail archive unavailable under this runtime (no bun:sqlite); events are not being logged",
  );
}

function getDb(): any | null {
  if (bunSqlite === null) {
    warnArchiveUnavailable();
    return null;
  }
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "archive.db");
  const db = new bunSqlite.Database(dbPath, { create: true });

  db.exec(`
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
    
    DROP TRIGGER IF EXISTS archive_ai;
    CREATE TRIGGER archive_ai AFTER INSERT ON archive BEGIN
      INSERT INTO archive_fts(rowid, body) VALUES (new.id, new.body);
    END;
    
    DROP TRIGGER IF EXISTS archive_ad;
    CREATE TRIGGER archive_ad AFTER DELETE ON archive BEGIN
      INSERT INTO archive_fts(archive_fts, rowid, body) VALUES('delete', old.id, old.body);
    END;
    
    DROP TRIGGER IF EXISTS archive_au;
    CREATE TRIGGER archive_au AFTER UPDATE ON archive BEGIN
      INSERT INTO archive_fts(archive_fts, rowid, body) VALUES('delete', old.id, old.body);
      INSERT INTO archive_fts(rowid, body) VALUES (new.id, new.body);
    END;
  `);

  return db;
}

export function logEvent(event: Omit<ArchiveEvent, "timestamp">, body?: string): void {
  let db: any | null = null;
  try {
    db = getDb();
    if (db === null) return; // archive unavailable under this runtime (note emitted once)
    const stmt = db.prepare(`
      INSERT INTO archive (event, timestamp, sender, recipient, messageId, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(event.event, new Date().toISOString(), event.from, event.to, event.messageId, body || null);
  } catch (err) {
    // Best-effort audit logging.
  } finally {
    db?.close();
  }
}

export function queryArchive(query: ArchiveQuery = {}): ArchiveEvent[] {
  let db: any | null = null;
  try {
    db = getDb();
    if (db === null) return []; // archive unavailable under this runtime (note emitted once)
    let sql = "SELECT archive.event, archive.timestamp, archive.sender as 'from', archive.recipient as 'to', archive.messageId, archive.body FROM archive";
    const conditions: string[] = [];
    const params: any[] = [];

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

    const stmt = db.prepare(sql);
    const results = stmt.all(...params) as any[];

    return results.map(r => ({
      ...r,
      bodyPreview: r.body ? (r.body.length > 100 ? r.body.slice(0, 100) + "..." : r.body) : undefined
    })) as ArchiveEvent[];
  } catch (err) {
    return [];
  } finally {
    db?.close();
  }
}
