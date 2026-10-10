import { describe, expect, test } from "bun:test";
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
    expect(sandboxHomeBase(["/tmp", "/var/tmp"])).toBe("/var/tmp");
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
});
