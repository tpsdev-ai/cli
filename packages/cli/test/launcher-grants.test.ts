import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherGrantCovering, realNonoHomeBase, sandboxHomeBase } from "./helpers/launcher-grants.js";

/**
 * Whether a write into the directory under test is refused for want of
 * permission. Only a permission refusal (EACCES/EPERM) on the write attempt
 * counts as enforcement; any other error is rethrown, so an unrelated failure
 * cannot read as evidence that the mode is honoured. A successful attempt's own
 * directory is removed after the decision, not as part of it.
 */
function writeRefusedForPermission(create: () => string): boolean {
  let probe: string;
  try {
    probe = create();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return true;
    throw err;
  }
  rmSync(probe, { recursive: true, force: true });
  return false;
}

/**
 * Whether chmod removing write permission is honoured under the same base a
 * sandbox HOME uses (sandboxHomeBase()). Root, and a filesystem that ignores
 * the mode, can still write into a 0o500 directory, so the
 * non-writable-candidate case cannot exercise its premise there; it registers
 * an explicit skip rather than return without its assertion and pass (cli#637).
 */
function modeRestrictionEnforced(): boolean {
  const dir = mkdtempSync(join(sandboxHomeBase(), "lg-mode-"));
  try {
    chmodSync(dir, 0o500);
    return writeRefusedForPermission(() => mkdtempSync(join(dir, "lg-probe-")));
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

const modeRestrictionEnforcedHere = modeRestrictionEnforced();

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
      const target = realpathSync("/var/tmp");
      try {
        symlinkSync(target, link);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        throw new Error(`cannot set up this case: symlinkSync(${link}) refused with ${code}`);
      }
      expect(sandboxHomeBase([link])).toBe(realpathSync("/var/tmp"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Where chmod does not take effect (root, or a filesystem that ignores the
  // mode) the premise does not hold, so the case skips explicitly. The probe
  // above creates its directory under the same base this case uses, so it sees
  // the same mode enforcement (cli#637).
  test.skipIf(!modeRestrictionEnforcedHere)("skips a non-writable directory candidate and returns the next writable uncovered one", () => {
    const parent = mkdtempSync(join(sandboxHomeBase(), "lg-skip-"));
    const dir = join(parent, "ro");
    const next = join(parent, "rw");
    try {
      mkdirSync(dir);
      mkdirSync(next);
      chmodSync(dir, 0o500);
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

  test("resolves a link outside every grant to the grant its real location sits in", () => {
    const dir = mkdtempSync(join(sandboxHomeBase(), "lg-link-"));
    try {
      // The link's own directory is outside every grant, so a match on the
      // spelled-out path alone cannot pass: only resolving the link reaches /tmp.
      expect(launcherGrantCovering(dir)).toBeNull();
      const link = join(dir, "tmplink");
      try {
        symlinkSync("/tmp", link);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        throw new Error(`cannot set up this case: symlinkSync(${link}) refused with ${code}`);
      }
      expect(launcherGrantCovering(join(link, "a"))).toBe("/tmp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeRefusedForPermission", () => {
  test("reports enforcement when the write attempt is refused for want of permission", () => {
    expect(
      writeRefusedForPermission(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).toBe(true);
  });

  test("rethrows any other error instead of reporting it as enforcement", () => {
    expect(() =>
      writeRefusedForPermission(() => {
        throw Object.assign(new Error("injected write fault"), { code: "EIO" });
      }),
    ).toThrow(/injected write fault/);
  });

  test("reports no enforcement and removes the created directory when the write succeeds", () => {
    const dir = mkdtempSync(join(sandboxHomeBase(), "lg-ok-"));
    try {
      expect(writeRefusedForPermission(() => mkdtempSync(join(dir, "lg-probe-")))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A fake nono that answers `why --json --profile default --path P --op OP`:
 * "allowed" for a path under $FAKE_GRANTED, "denied" otherwise, and a failed
 * query when $FAKE_FAIL is set.
 */
function fakeWhyNono(dir: string): string {
  const bin = join(dir, "nono");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'if [ -n "${FAKE_FAIL:-}" ]; then echo "fake failure" >&2; exit 2; fi',
      'path="$6"',
      'case "$path" in',
      '  "${FAKE_GRANTED:-/nonexistent-prefix}"/*) echo \'{"status":"allowed","reason":"granted_path","granted_path":"\'"$FAKE_GRANTED"\'","access":"read","source":"group:fake_group"}\' ;;',
      '  *) echo \'{"status":"denied","reason":"path_not_granted"}\' ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("realNonoHomeBase", () => {
  test("skips a candidate nono's built-in policy grants and returns the next one", () => {
    const parent = mkdtempSync(join(sandboxHomeBase(), "lg-nono-"));
    try {
      const granted = join(parent, "granted");
      const free = join(parent, "free");
      mkdirSync(granted);
      mkdirSync(free);
      const nono = fakeWhyNono(parent);
      const env = { ...process.env, FAKE_GRANTED: realpathSync(granted) };
      expect(realNonoHomeBase(nono, [granted, free], env)).toBe(realpathSync(free));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("throws, naming the candidate and nono's grant, when no candidate qualifies", () => {
    const parent = mkdtempSync(join(sandboxHomeBase(), "lg-nono-"));
    try {
      const granted = join(parent, "granted");
      mkdirSync(granted);
      const nono = fakeWhyNono(parent);
      const env = { ...process.env, FAKE_GRANTED: realpathSync(granted) };
      expect(() => realNonoHomeBase(nono, [granted, "/tmp"], env)).toThrow(
        /granted: nono's built-in policy grants read via .*granted \(group:fake_group\); \/tmp: inside the launcher's '\/tmp' grant/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a failed nono query throws instead of reading as not granted", () => {
    const parent = mkdtempSync(join(sandboxHomeBase(), "lg-nono-"));
    try {
      const nono = fakeWhyNono(parent);
      expect(() => realNonoHomeBase(nono, [parent], { ...process.env, FAKE_FAIL: "1" })).toThrow(
        /failed \(status 2\): fake failure/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
