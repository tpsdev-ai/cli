/**
 * durable-file.test.ts — the persistence steps behind every durable store
 * write, in order: a uniquely named temp file is created exclusively, written
 * and fsync'ed, renamed over the store, and the directory is fsync'ed; a
 * failing step fails the write and removes the temp file. A newly created
 * audit log also fsyncs its directory. (A crash or power loss cannot be
 * simulated here; these tests pin the steps the durability claim rests on.)
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonLine, writeJsonStore } from "../src/durable-file.js";

// The real implementations, captured before any spy replaces them.
const realOpen = fs.openSync.bind(fs);
const realFsync = fs.fsyncSync.bind(fs);
const realRename = fs.renameSync.bind(fs);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-durable-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("durable-file — fsync of the file, atomic rename, fsync of the directory", () => {
  test("writeJsonStore: write + fsync(temp), close, rename over the store, then fsync(directory)", () => {
    const file = join(root, "store.json");
    const steps: string[] = [];
    const fdPath = new Map<number, string>();
    const name = (p: string) => (p === root ? "<dir>" : p.replace(root, "").replace(/^\/store\.json\.\d+\.[0-9a-f]{24}\.tmp$/, "/store.json.<unique>.tmp"));
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags ?? "r", mode);
      fdPath.set(fd, String(p));
      steps.push(`open ${name(String(p))} ${String(flags)}`);
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      steps.push(`fsync ${name(fdPath.get(fd)!)}`);
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    const rename = spyOn(fs, "renameSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      steps.push(`rename ${name(String(a))} -> ${name(String(b))}`);
      realRename(a, b);
    }) as typeof fs.renameSync);
    try {
      writeJsonStore(file, { latches: [] });
    } finally {
      open.mockRestore();
      fsync.mockRestore();
      rename.mockRestore();
    }
    expect(steps).toEqual([
      "open /store.json.<unique>.tmp wx",
      "fsync /store.json.<unique>.tmp",
      "rename /store.json.<unique>.tmp -> /store.json",
      "open <dir> r",
      "fsync <dir>",
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ latches: [] });
  });

  test("a failing fsync fails the write, and the store keeps its previous contents", () => {
    const file = join(root, "store.json");
    writeJsonStore(file, { v: 1 });
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }) as typeof fs.fsyncSync);
    try {
      expect(() => writeJsonStore(file, { v: 2 })).toThrow("EIO");
    } finally {
      fsync.mockRestore();
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1 });
    // The failed write left no temp file behind.
    expect(fs.readdirSync(root)).toEqual(["store.json"]);
  });

  test("every replacement uses its OWN temp name, created exclusively — a leftover or concurrent temp file is never reused", () => {
    const file = join(root, "store.json");
    const temps: string[] = [];
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (String(p).endsWith(".tmp")) temps.push(`${String(p)} ${String(flags)}`);
      return realOpen(p, flags ?? "r", mode);
    }) as typeof fs.openSync);
    try {
      // A stale fixed-name temp file from an older writer is left untouched.
      fs.writeFileSync(`${file}.tmp`, "stale");
      writeJsonStore(file, { v: 1 });
      writeJsonStore(file, { v: 2 });
    } finally {
      open.mockRestore();
    }
    expect(temps.length).toBe(2);
    expect(new Set(temps).size).toBe(2);
    for (const t of temps) expect(t.endsWith(" wx")).toBe(true);
    expect(readFileSync(`${file}.tmp`, "utf8")).toBe("stale");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 2 });
  });

  test("TWO WRITERS: A creates the log and stalls before its directory fsync; B appends — B does not return before a directory fsync", () => {
    const file = join(root, "audit.jsonl");
    const events: string[] = [];
    const paths = new Map<number, string>();
    let stalled = false;
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (String(p) === root && !stalled) {
        // Writer A is about to fsync the directory: stall it here and let B run.
        stalled = true;
        events.push("A stalls before its directory fsync");
        appendJsonLine(file, { writer: "B" });
        events.push("B returned");
      }
      const fd = realOpen(p, flags ?? "r", mode);
      paths.set(fd, String(p));
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      events.push(paths.get(fd) === root ? "fsync dir" : "fsync log");
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    try {
      appendJsonLine(file, { writer: "A" });
    } finally {
      open.mockRestore();
      fsync.mockRestore();
    }
    const stall = events.indexOf("A stalls before its directory fsync");
    const bReturned = events.indexOf("B returned");
    expect(stall).toBeGreaterThanOrEqual(0);
    expect(events.slice(stall, bReturned)).toContain("fsync dir");
    expect(readFileSync(file, "utf8")).toBe('{"writer":"A"}\n{"writer":"B"}\n');
  });

  test("appendJsonLine fsyncs the log AND its directory before EVERY append returns", () => {
    const file = join(root, "audit.jsonl");
    const synced: string[] = [];
    const paths = new Map<number, string>();
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags ?? "r", mode);
      paths.set(fd, String(p));
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      synced.push(paths.get(fd) === root ? "dir" : "log");
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    try {
      appendJsonLine(file, { a: 1 });
      expect(synced).toEqual(["log", "dir"]);
      appendJsonLine(file, { a: 2 });
      expect(synced).toEqual(["log", "dir", "log", "dir"]);
    } finally {
      open.mockRestore();
      fsync.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"a":2}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
