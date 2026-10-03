import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const deadline = 30_000;
const nodeHasSqlite = spawnSync("node", ["-e", "require('node:sqlite')"], { timeout: deadline }).status === 0;

for (const runtime of ["bun", "node"]) {
  describe(`${runtime} archive diagnostics`, () => {
    function run(setup: string, calls = `a.logEvent({ event: "sent", from: "a", to: "b", messageId: "1" }); a.queryArchive();`) {
      const root = mkdtempSync(join(tmpdir(), "archive-errors-"));
      const archivePath = join(root, "archive.db");
      const modulePath = resolve(import.meta.dir, runtime === "bun" ? "../src/utils/archive.ts" : "../dist/src/utils/archive.js");
      const script = `
        import { writeFileSync, mkdirSync } from "node:fs";
        const path = ${JSON.stringify(archivePath)};
        const { ${runtime === "bun" ? "Database: Database" : "DatabaseSync: Database"} } = await import(${JSON.stringify(runtime === "bun" ? "bun:sqlite" : "node:sqlite")});
        ${setup}
        const a = await import(${JSON.stringify(modulePath)});
        ${calls}
        console.log("COMPLETED");
      `;
      try {
        const result = spawnSync(runtime, ["--input-type=module", "-e", script], {
          encoding: "utf8", timeout: deadline, env: { ...process.env, TPS_MAIL_DIR: root },
        });
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("COMPLETED");
        return { ...result, archivePath };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const enabled = runtime === "bun" || nodeHasSqlite;
    for (const [kind, setup] of [
      ["corrupt", 'writeFileSync(path, "not a database");'],
      ["unwritable", "mkdirSync(path);"],
    ]) {
      test.if(enabled)(`${kind} archive reports its path and error code without throwing`, () => {
        const result = run(setup!);
        expect(result.stderr).toContain(result.archivePath);
        expect(result.stderr).toMatch(/\[(?:SQLITE_[A-Z_]+|ERR_SQLITE_ERROR)\]/);
        expect(result.stderr).not.toContain("no sqlite backend");
      });
    }

    test.if(enabled)("non-duplicate migration errors are reported", () => {
      const result = run(`
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          if (sql.startsWith("ALTER TABLE")) throw Object.assign(new Error("migration denied"), { code: "SQLITE_AUTH" });
          return exec.call(this, sql);
        };
      `, `a.logEvent({ event: "sent", from: "a", to: "b", messageId: "1" }); a.logEvent({ event: "sent", from: "a", to: "b", messageId: "2" });`);
      expect(result.stderr).toContain(result.archivePath);
      expect(result.stderr).toContain("[SQLITE_AUTH]");
      expect(result.stderr).toContain("migration denied");
      expect(result.stderr.split("migration denied")).toHaveLength(2);
    });

    test.if(enabled)("the same failure is reported at each archive path", () => {
      const result = run(`
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          if (sql.startsWith("ALTER TABLE")) throw Object.assign(new Error("migration denied"), { code: "SQLITE_AUTH" });
          return exec.call(this, sql);
        };
      `, `
        a.logEvent({ event: "sent", from: "a", to: "b", messageId: "1" });
        a.logEvent({ event: "sent", from: "a", to: "b", messageId: "2" });
        process.env.TPS_MAIL_DIR += "/second";
        a.logEvent({ event: "sent", from: "a", to: "b", messageId: "3" });
        a.logEvent({ event: "sent", from: "a", to: "b", messageId: "4" });
      `);
      const warnings = result.stderr.split("\n").filter((line) => line.includes("migration denied"));
      expect(warnings).toEqual([
        `tps-mail archive: ${result.archivePath}: write [SQLITE_AUTH]: migration denied`,
        `tps-mail archive: ${join(result.archivePath, "..", "second", "archive.db")}: write [SQLITE_AUTH]: migration denied`,
      ]);
    });

    test.if(enabled)("native non-duplicate migration errors retain their backend code", () => {
      const result = run(`
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          return exec.call(this, sql.startsWith("ALTER TABLE") ? "ALTER TABLE missing ADD COLUMN replyToId TEXT" : sql);
        };
      `);
      expect(result.stderr).toContain(result.archivePath);
      expect(result.stderr).toContain("no such table: missing");
      // bun reports this error as SQLITE_ERRNO_1 or SQLITE_ERROR (the Docker lane reports SQLITE_ERROR).
      expect(result.stderr).toMatch(runtime === "bun" ? /\[SQLITE_(ERRNO_1|ERROR)\]/ : /\[ERR_SQLITE_ERROR\]/);
    });

    test.if(enabled)("PRAGMA values are read back on each open", () => {
      const result = run(`
        const opens = new WeakMap();
        let nextOpen = 0;
        const prepare = Database.prototype.prepare;
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          if (/^PRAGMA (journal_mode|busy_timeout)$/.test(sql)) {
            if (!opens.has(this)) opens.set(this, ++nextOpen);
            const open = opens.get(this);
            const all = statement.all;
            statement.all = function(...args) {
              const rows = all.apply(this, args);
              console.log("OPEN=" + open + " " + sql + "=" + JSON.stringify(rows));
              return rows;
            };
          }
          return statement;
        };
      `);
      const readbacks = result.stdout.split("\n").filter((line) => line.startsWith("OPEN="));
      expect(readbacks).toEqual([
        'OPEN=1 PRAGMA busy_timeout=[{"timeout":5000}]',
        'OPEN=1 PRAGMA journal_mode=[{"journal_mode":"wal"}]',
        'OPEN=2 PRAGMA busy_timeout=[{"timeout":5000}]',
        'OPEN=2 PRAGMA journal_mode=[{"journal_mode":"wal"}]',
      ]);
      expect(result.stderr).not.toContain("tps-mail archive:");
    });

    test.if(enabled)("PRAGMA mismatches name the path and setting", () => {
      const result = run(`
        const prepare = Database.prototype.prepare;
        Database.prototype.prepare = function(sql) {
          if (sql === "PRAGMA journal_mode") return { all: () => [{ journal_mode: "delete" }] };
          if (sql === "PRAGMA busy_timeout") return { all: () => [{ timeout: 0 }] };
          return prepare.call(this, sql);
        };
      `);
      expect(result.stderr).toContain(result.archivePath);
      expect(result.stderr).toContain("journal_mode");
      expect(result.stderr).toContain("busy_timeout");
      expect(result.stderr).toContain("[PRAGMA_MISMATCH]");
    });

    test.if(enabled)("PRAGMA execution errors name the path and setting", () => {
      const result = run(`
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          if (sql.startsWith("PRAGMA journal_mode")) throw Object.assign(new Error("pragma denied"), { code: "SQLITE_AUTH" });
          return exec.call(this, sql);
        };
      `);
      expect(result.stderr).toContain(result.archivePath);
      expect(result.stderr).toContain("journal_mode [SQLITE_AUTH]");
    });

    test.if(enabled)("close errors are reported without throwing", () => {
      const result = run(`
        const close = Database.prototype.close;
        Database.prototype.close = function() {
          close.call(this);
          throw Object.assign(new Error("close denied"), { code: "SQLITE_IOERR" });
        };
      `);
      expect(result.stderr).toContain(result.archivePath);
      expect(result.stderr).toContain("close [SQLITE_IOERR]");
    });

    if (runtime === "node") {
      for (const code of ["EACCES", "MODULE_NOT_FOUND"]) {
        test.if(enabled)(`binding load ${code} errors are not treated as an absent binding`, () => {
          const result = run(`
            const { default: Module } = await import("node:module");
            const load = Module._load;
            Module._load = function(name, ...args) {
              if (name === "node:sqlite") throw Object.assign(new Error("binding denied"), { code: ${JSON.stringify(code)} });
              return load.call(this, name, ...args);
            };
          `);
          expect(result.stderr).toContain(result.archivePath);
          expect(result.stderr).toContain(`[${code}]`);
          expect(result.stderr).not.toContain("no sqlite backend");
        });
      }
    }

    test.if(enabled)("write and read failures emit distinct diagnostics", () => {
      const result = run(`
        const prepare = Database.prototype.prepare;
        Database.prototype.prepare = function(sql) {
          if (sql.startsWith("INSERT INTO archive") || sql.startsWith("SELECT archive.event")) {
            const fail = () => { throw Object.assign(new Error("I/O denied"), { code: "SQLITE_IOERR" }); };
            return { run: fail, all: fail };
          }
          return prepare.call(this, sql);
        };
      `);
      expect(result.stderr).toContain(result.archivePath);
      expect(result.stderr).toContain("write [SQLITE_IOERR]");
      expect(result.stderr).toContain("read [SQLITE_IOERR]");
    });
  });
}
