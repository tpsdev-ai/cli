import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherGrantCovering, sandboxHomeBase } from "./helpers/launcher-grants.js";

describe("sandboxHomeBase", () => {
  test("refuses when every existing candidate is inside a launcher grant, naming TMPDIR and the grant", () => {
    expect(() => sandboxHomeBase(["/tmp", "/tmp/x"])).toThrow(/TMPDIR=/);
    expect(() => sandboxHomeBase(["/tmp", "/tmp/x"])).toThrow(/'\/tmp'/);
  });

  test("suggests /var/tmp when it was not among the rejected candidates", () => {
    expect(() => sandboxHomeBase(["/tmp"])).toThrow(/for example \/var\/tmp/);
  });

  test("returns a candidate that lies outside every grant", () => {
    expect(launcherGrantCovering("/var/tmp")).toBeNull();
    expect(sandboxHomeBase(["/tmp", "/var/tmp"])).toBe(realpathSync("/var/tmp"));
  });

  test("returns the real path of a candidate reached through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-link-"));
    try {
      const link = join(dir, "link");
      try {
        symlinkSync(realpathSync("/var/tmp"), link);
      } catch (err) {
        console.warn(`symlink creation refused, case skipped: ${err}`);
        return;
      }
      expect(sandboxHomeBase([link])).toBe(realpathSync("/var/tmp"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips a non-writable directory candidate and returns the next writable uncovered one", () => {
    const parent = mkdtempSync(join(sandboxHomeBase(), "lg-skip-"));
    const dir = join(parent, "ro");
    const next = join(parent, "rw");
    try {
      mkdirSync(dir);
      mkdirSync(next);
      chmodSync(dir, 0o500);
      let writable = false;
      try {
        rmSync(mkdtempSync(join(dir, "w-")), { recursive: true });
        writable = true;
      } catch {}
      if (writable) {
        console.warn("a 0o500 directory is still writable (running as root?), case skipped");
        return;
      }
      expect(sandboxHomeBase([dir, next])).toBe(realpathSync(next));
    } finally {
      chmodSync(dir, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("skips a candidate that is a regular file and returns the next writable directory", () => {
    const parent = mkdtempSync(join(sandboxHomeBase(), "lg-file-"));
    try {
      const file = join(parent, "file");
      const next = join(parent, "dir");
      writeFileSync(file, "");
      mkdirSync(next);
      expect(sandboxHomeBase([file, next])).toBe(realpathSync(next));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("names the missing candidates when none of them exists", () => {
    const missing = ["/var/tmp/launcher-grants-missing-a", "/var/tmp/launcher-grants-missing-b"];
    expect(() => sandboxHomeBase(missing)).toThrow(/no usable base directory exists/);
    expect(() => sandboxHomeBase(missing)).toThrow(/missing-a, \/var\/tmp\/launcher-grants-missing-b/);
    expect(() => sandboxHomeBase(missing)).not.toThrow(/'null'/);
  });
});

describe("launcherGrantCovering", () => {
  test("returns the grant for a path under it and null across the prefix boundary", () => {
    expect(launcherGrantCovering("/tmp/a")).toBe("/tmp");
    expect(launcherGrantCovering("/tmpfoo")).toBeNull();
  });

  test("recognises a path under a symlink to /tmp as covered by /tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "lg-link-"));
    try {
      const link = join(dir, "tmplink");
      try {
        symlinkSync("/tmp", link);
      } catch (err) {
        console.warn(`symlink creation refused, case skipped: ${err}`);
        return;
      }
      expect(launcherGrantCovering(join(link, "a"))).toBe("/tmp");
      expect(launcherGrantCovering(realpathSync("/tmp"))).toBe("/tmp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
