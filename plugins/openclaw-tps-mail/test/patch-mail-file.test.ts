import { afterAll, afterEach, describe, expect, test, mock } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFs = { ...fs };
let removeAfterRead: string | undefined;
mock.module("node:fs", () => ({
  ...realFs,
  readFileSync: (...args: any[]) => {
    const result = (realFs.readFileSync as any)(...args);
    if (args[0] === removeAfterRead) {
      realFs.unlinkSync(removeAfterRead!);
      removeAfterRead = undefined;
    }
    return result;
  },
}));

const { patchMailFile } = await import("../src/index.js");
const root = realFs.mkdtempSync(join(tmpdir(), "patch-mail-"));
const path = join(root, "record.json");

afterEach(() => {
  removeAfterRead = undefined;
  realFs.rmSync(path, { force: true });
});

afterAll(() => realFs.rmSync(root, { recursive: true, force: true }));

describe("patchMailFile", () => {
  test("patches an existing record", () => {
    realFs.writeFileSync(path, JSON.stringify({ id: "inbound", body: "hello" }));
    expect(patchMailFile(path, { read: true })).toBe(true);
    expect(JSON.parse(realFs.readFileSync(path, "utf-8"))).toEqual({ id: "inbound", body: "hello", read: true });
  });

  test("reports a missing record without creating it", () => {
    expect(patchMailFile(path, { read: true })).toBe(false);
    expect(realFs.existsSync(path)).toBe(false);
  });

  test("reports a record removed after the read without recreating it", () => {
    realFs.writeFileSync(path, JSON.stringify({ id: "inbound", body: "hello" }));
    removeAfterRead = path;
    expect(patchMailFile(path, { ackedAt: "receipt", read: true })).toBe(false);
    expect(removeAfterRead).toBeUndefined();
    expect(realFs.existsSync(path)).toBe(false);
  });
});
