/**
 * durable-file.test.ts — the persistence steps behind every durable store
 * write, in order: the temp file is written and fsync'ed, renamed over the
 * store, and the directory is fsync'ed; a failing step fails the write. (A
 * crash or power loss cannot be simulated here; these tests pin the steps the
 * durability claim in durable-file.ts rests on.)
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
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags ?? "r", mode);
      fdPath.set(fd, String(p));
      steps.push(`open ${String(p) === root ? "<dir>" : String(p).replace(root, "")}`);
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      steps.push(`fsync ${fdPath.get(fd) === root ? "<dir>" : fdPath.get(fd)!.replace(root, "")}`);
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    const rename = spyOn(fs, "renameSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      steps.push(`rename ${String(a).replace(root, "")} -> ${String(b).replace(root, "")}`);
      realRename(a, b);
    }) as typeof fs.renameSync);
    try {
      writeJsonStore(file, { latches: [] });
    } finally {
      open.mockRestore();
      fsync.mockRestore();
      rename.mockRestore();
    }
    expect(steps).toEqual(["open /store.json.tmp", "fsync /store.json.tmp", "rename /store.json.tmp -> /store.json", "open <dir>", "fsync <dir>"]);
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
  });

  test("appendJsonLine fsyncs the log it appends to", () => {
    const file = join(root, "audit.jsonl");
    const fsync = spyOn(fs, "fsyncSync");
    try {
      appendJsonLine(file, { a: 1 });
      appendJsonLine(file, { a: 2 });
      expect(fsync.mock.calls.length).toBe(2);
    } finally {
      fsync.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"a":2}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
