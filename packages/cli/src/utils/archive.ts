import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
// @ts-ignore
import { Database } from "bun:sqlite";

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

function getDb(): any {
  const dir = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "archive.db");
  const db = new Database(dbPath, { create: true });
  
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
