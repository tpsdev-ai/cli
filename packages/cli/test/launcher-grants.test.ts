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
 * A fake nono for the read probe. `run … -- <cmd…>` is decided by the candidate
 * base the probe's `--profile` file sits under:
 *   - under $FAKE_REFUSED_UNDER: refuses to start (stderr, exit 1, no output);
 *   - under $FAKE_UNKNOWN_UNDER: exits 0 with no output (the CI `why` symptom);
 *   - under $FAKE_GRANTED_UNDER: runs the payload as is, so `cat` prints the nonce;
 *   - anywhere else: runs the payload with a `cat` that is denied, so the
 *     payload's own `||` branch prints the marker.
 * The fake never knows the nonce or the marker: each answer comes from running
 * the probe's own payload.
 */
function fakeProbeNono(dir: string): string {
  const denyBin = join(dir, "deny-bin");
  mkdirSync(denyBin);
  writeFileSync(join(denyBin, "cat"), '#!/bin/sh\necho "cat: $1: Operation not permitted" >&2\nexit 1\n');
  chmodSync(join(denyBin, "cat"), 0o755);
  const bin = join(dir, "nono");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" != "run" ]; then echo "fake nono: unexpected $*" >&2; exit 64; fi',
      'profile=""',
      'while [ $# -gt 0 ] && [ "$1" != "--" ]; do',
      '  if [ "$1" = "--profile" ]; then profile="$2"; shift; fi',
      "  shift",
      "done",
      "shift",
      'under() { [ -n "$1" ] && case "$profile" in "$1"/*) return 0 ;; esac; return 1; }',
      'if under "${FAKE_REFUSED_UNDER:-}"; then echo "nono: Sandbox initialization failed: fake refusal" >&2; exit 1; fi',
      'if under "${FAKE_UNKNOWN_UNDER:-}"; then exit 0; fi',
      'if under "${FAKE_GRANTED_UNDER:-}"; then exec "$@"; fi',
      `PATH="${denyBin}:$PATH" exec "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** A parent dir (outside every launcher grant) with one candidate dir per name. */
function probeCandidates(...names: string[]): { parent: string; dirs: Record<string, string> } {
  const parent = mkdtempSync(join(sandboxHomeBase(), "lg-nono-"));
  const dirs: Record<string, string> = {};
  for (const name of names) {
    dirs[name] = join(parent, name);
    mkdirSync(dirs[name]);
  }
  return { parent, dirs };
}

describe("realNonoHomeBase", () => {
  test("accepts a candidate whose sandboxed read nono denies, and leaves no probe behind", () => {
    const { parent, dirs } = probeCandidates("free");
    try {
      const nono = fakeProbeNono(parent);
      expect(realNonoHomeBase(nono, [dirs.free], process.env)).toBe(realpathSync(dirs.free));
      expect(readdirSync(dirs.free)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a candidate whose sandboxed read nono grants, and returns the next one", () => {
    const { parent, dirs } = probeCandidates("granted", "free");
    try {
      const nono = fakeProbeNono(parent);
      const env = { ...process.env, FAKE_GRANTED_UNDER: realpathSync(dirs.granted) };
      expect(realNonoHomeBase(nono, [dirs.granted, dirs.free], env)).toBe(realpathSync(dirs.free));
      expect(() => realNonoHomeBase(nono, [dirs.granted], env)).toThrow(
        /granted: nono's default policy lets a sandboxed process read a file under it/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a candidate whose probe produces no output with a nonzero exit, quoting its stderr, and returns the next one", () => {
    const { parent, dirs } = probeCandidates("refused", "free");
    try {
      const nono = fakeProbeNono(parent);
      const env = { ...process.env, FAKE_REFUSED_UNDER: realpathSync(dirs.refused) };
      expect(realNonoHomeBase(nono, [dirs.refused, dirs.free], env)).toBe(realpathSync(dirs.free));
      expect(() => realNonoHomeBase(nono, [dirs.refused], env)).toThrow(
        /refused: the probe produced no output and exited nonzero: nono: Sandbox initialization failed: fake refusal/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an unknown answer throws instead of reading as not granted or moving on", () => {
    const { parent, dirs } = probeCandidates("unknown", "free");
    try {
      const nono = fakeProbeNono(parent);
      const env = { ...process.env, FAKE_UNKNOWN_UNDER: realpathSync(dirs.unknown) };
      expect(() => realNonoHomeBase(nono, [dirs.unknown, dirs.free], env)).toThrow(
        /unknown answer, which is never read as "not granted".*exited 0, stdout "", stderr ""/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("names every rejected candidate when none qualifies", () => {
    const { parent, dirs } = probeCandidates("granted", "refused");
    try {
      const nono = fakeProbeNono(parent);
      const env = {
        ...process.env,
        FAKE_GRANTED_UNDER: realpathSync(dirs.granted),
        FAKE_REFUSED_UNDER: realpathSync(dirs.refused),
      };
      const missing = join(parent, "missing");
      expect(() => realNonoHomeBase(nono, [dirs.granted, dirs.refused, "/tmp", missing], env)).toThrow(
        /granted: nono's default policy lets .*; .*refused: the probe produced no output and exited nonzero: .*fake refusal; \/tmp: inside the launcher's '\/tmp' grant; .*missing: not a writable directory/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
