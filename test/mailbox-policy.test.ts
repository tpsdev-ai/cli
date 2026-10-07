import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeCurRecord } from "../packages/agent/src/lib/mailbox-policy.js";

describe("exclusive cur placement", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mailbox-policy-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("a fresh destination is the same file as the source", () => {
    const source = join(root, "new");
    const destination = join(root, "cur");
    writeFileSync(source, "incoming");
    expect(placeCurRecord(source, destination)).toEqual({ status: "placed" });

    // Same FILE, not merely the same bytes: placing the record adds a second
    // name for one inode. Read each name's identity and content through its own
    // open descriptor, so no path is stat'd and then read (CodeQL file-system-race).
    const sourceFd = openSync(source, "r");
    const destinationFd = openSync(destination, "r");
    try {
      const sourceInfo = fstatSync(sourceFd);
      const destinationInfo = fstatSync(destinationFd);
      expect(destinationInfo.dev).toBe(sourceInfo.dev);
      expect(destinationInfo.ino).toBe(sourceInfo.ino);
      expect(sourceInfo.nlink).toBe(2);
      expect(destinationInfo.nlink).toBe(2);
      expect(readFileSync(destinationFd, "utf8")).toBe("incoming");
    } finally {
      closeSync(sourceFd);
      closeSync(destinationFd);
    }
  });

  for (const symlink of [false, true]) {
    test(`an existing ${symlink ? "symlink" : "file"} keeps its bytes`, () => {
      const source = join(root, "new");
      const record = join(root, "record");
      const destination = symlink ? join(root, "cur") : record;
      writeFileSync(source, "incoming");
      writeFileSync(record, "existing");
      if (symlink) symlinkSync(record, destination);
      expect(placeCurRecord(source, destination)).toEqual({ status: "exists" });
      expect(readFileSync(record, "utf8")).toBe("existing");
      expect(readFileSync(source, "utf8")).toBe("incoming");
    });
  }
});
