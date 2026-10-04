import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeCurRecord } from "../packages/agent/src/lib/mailbox-policy.js";

describe("exclusive cur placement", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mailbox-policy-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("a fresh destination is linked to the source", () => {
    const source = join(root, "new");
    const destination = join(root, "cur");
    writeFileSync(source, "incoming");
    expect(placeCurRecord(source, destination)).toEqual({ status: "placed" });
    expect(readFileSync(destination, "utf8")).toBe("incoming");
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
