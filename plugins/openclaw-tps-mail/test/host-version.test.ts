/**
 * host-version.test.ts — cli#402: the HOST OpenClaw runtime floor guard.
 *
 * (a) host < 2026.5.22 + `surfaces["tps-mail"].silentReplyRewrite.direct` unset
 *     → the WARN, naming the key.  (RED on pre-fix main: no warning exists.)
 * (b) host < 2026.5.22 + the key `false` → NO warn (`false` is not "unset").
 * (c) host >= 2026.5.22 → NO warn.
 * (d) host version undeterminable → the "could not check" WARN.  (RED on main.)
 *
 * Plus the version SIGNAL itself: it must come from the RUNNING gateway's own
 * install (the entry script's package root), NOT the plugin's dev dependency —
 * the trap that makes a naive `require("openclaw/package.json")` check report
 * the dev-dep version everywhere and never fire.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SILENT_REPLY_REWRITE_FLOOR,
  SILENT_REPLY_REWRITE_KEY,
  detectHostOpenClawVersion,
  compareOpenClawVersions,
  isSilentReplyRewriteDisabled,
  evaluateHostSilentReplyGuard,
} from "../src/host-version.js";

/** A minimal fake OpenClaw install whose entry script lives at dist/index.js. */
function fakeHost(version: string): { entry: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "flair-host-ver-"));
  const pkg = join(root, "node_modules", "openclaw");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version }));
  const entry = join(pkg, "dist", "index.js");
  writeFileSync(entry, "// entry\n");
  return { entry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CFG_UNSET = {};
const CFG_OFF = { surfaces: { "tps-mail": { silentReplyRewrite: { direct: false } } } };
const CFG_ON = { surfaces: { "tps-mail": { silentReplyRewrite: { direct: true } } } };

describe("detectHostOpenClawVersion — the HOST install, not the dev dependency", () => {
  it("reads the version from the entry script's package root", () => {
    const h = fakeHost("2026.5.3-1");
    try {
      expect(detectHostOpenClawVersion(h.entry)).toBe("2026.5.3-1");
    } finally {
      h.cleanup();
    }
  });

  it("follows the ENTRY it is given, never the plugin's own directory (the dev-dep trap)", () => {
    // A dev-dep openclaw sits beside the plugin dir; the entry points elsewhere.
    const pluginRoot = mkdtempSync(join(tmpdir(), "flair-host-plugin-"));
    const devDep = join(pluginRoot, "node_modules", "openclaw");
    mkdirSync(devDep, { recursive: true });
    writeFileSync(join(devDep, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.5.22" }));

    const host = fakeHost("2026.5.3-1");
    try {
      // From the HOST entry → the host version, not the 2026.5.22 dev dep.
      expect(detectHostOpenClawVersion(host.entry)).toBe("2026.5.3-1");
      // An entry with no openclaw package above it is UNDETERMINABLE — the
      // plugin's own node_modules/openclaw is not consulted.
      const bare = join(pluginRoot, "entry.js");
      writeFileSync(bare, "//\n");
      expect(detectHostOpenClawVersion(bare)).toBe(null);
    } finally {
      host.cleanup();
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("returns null for a missing entry (never a guess)", () => {
    expect(detectHostOpenClawVersion(undefined)).toBe(null);
    expect(detectHostOpenClawVersion("/no/such/file.mjs")).toBe(null);
  });
});

describe("compareOpenClawVersions", () => {
  it("orders by numeric core, ignoring a pre-release/build suffix", () => {
    expect(compareOpenClawVersions("2026.5.3-1", SILENT_REPLY_REWRITE_FLOOR)).toBe(-1);
    expect(compareOpenClawVersions("2026.5.7", SILENT_REPLY_REWRITE_FLOOR)).toBe(-1);
    expect(compareOpenClawVersions("2026.5.22", SILENT_REPLY_REWRITE_FLOOR)).toBe(0);
    expect(compareOpenClawVersions("2026.5.23", SILENT_REPLY_REWRITE_FLOOR)).toBe(1);
    expect(compareOpenClawVersions("2026.6.0", SILENT_REPLY_REWRITE_FLOOR)).toBe(1);
    expect(compareOpenClawVersions("not-a-version", SILENT_REPLY_REWRITE_FLOOR)).toBe(null);
  });
});

describe("isSilentReplyRewriteDisabled — identity test on false", () => {
  it("is true ONLY for an explicit boolean false", () => {
    expect(isSilentReplyRewriteDisabled(CFG_OFF)).toBe(true);
    expect(isSilentReplyRewriteDisabled(CFG_UNSET)).toBe(false);
    expect(isSilentReplyRewriteDisabled(CFG_ON)).toBe(false);
    expect(isSilentReplyRewriteDisabled(undefined)).toBe(false);
  });
});

describe("evaluateHostSilentReplyGuard — the four cases", () => {
  it("(a) host < 2026.5.22 + key unset → WARN naming the key and the host version", () => {
    const d = evaluateHostSilentReplyGuard("2026.5.3-1", CFG_UNSET);
    expect(d.warn).toBe(true);
    expect(d.reason).toBe("rewrite-hazard");
    expect(d.message).toContain(SILENT_REPLY_REWRITE_KEY);
    expect(d.message).toContain("2026.5.3-1");
    expect(d.message).toContain(SILENT_REPLY_REWRITE_FLOOR);
  });

  it("(a') host < 2026.5.22 + key true → also WARN (true is not the safe value)", () => {
    expect(evaluateHostSilentReplyGuard("2026.5.7", CFG_ON).warn).toBe(true);
  });

  it("(b) host < 2026.5.22 + key false → NO warn (false is not 'unset')", () => {
    const d = evaluateHostSilentReplyGuard("2026.5.3-1", CFG_OFF);
    expect(d.warn).toBe(false);
    expect(d.reason).toBe("configured-off");
    expect(d.message).toBe(null);
  });

  it("(c) host >= 2026.5.22 → NO warn", () => {
    for (const v of ["2026.5.22", "2026.5.23", "2026.8.1"]) {
      const d = evaluateHostSilentReplyGuard(v, CFG_UNSET);
      expect(d.warn, `host ${v}`).toBe(false);
      expect(d.reason).toBe("host-current");
    }
  });

  it("(d) host version undeterminable → the 'could not check' WARN", () => {
    const d = evaluateHostSilentReplyGuard(null, CFG_UNSET);
    expect(d.warn).toBe(true);
    expect(d.reason).toBe("unknown-version");
    expect(d.message).toContain("could not determine");
    expect(d.message).toContain(SILENT_REPLY_REWRITE_KEY);
  });

  it("(d') undeterminable but the key is false → NO warn (the rewrite is off)", () => {
    expect(evaluateHostSilentReplyGuard(null, CFG_OFF).warn).toBe(false);
  });

  it("an unparseable host version also warns (could not compare)", () => {
    const d = evaluateHostSilentReplyGuard("weird", CFG_UNSET);
    expect(d.warn).toBe(true);
    expect(d.message).toContain("could not compare");
  });
});

describe("round 2 — malformed / at-floor-suffix versions fail TOWARD the WARN", () => {
  it("compareOpenClawVersions rejects a PARTIAL (prefix) match instead of equalling the floor", () => {
    expect(compareOpenClawVersions("2026.5.22broken", SILENT_REPLY_REWRITE_FLOOR)).toBe(null);
    expect(compareOpenClawVersions("2026.5.22.1", SILENT_REPLY_REWRITE_FLOOR)).toBe(null);
    // the real host strings still parse
    expect(compareOpenClawVersions("2026.5.7", SILENT_REPLY_REWRITE_FLOOR)).toBe(-1);
    expect(compareOpenClawVersions("2026.5.3-1", SILENT_REPLY_REWRITE_FLOOR)).toBe(-1);
    expect(compareOpenClawVersions("2026.8.1", SILENT_REPLY_REWRITE_FLOOR)).toBe(1);
  });

  it("2026.5.22broken → the 'could not check' WARN (never treated as the floor)", () => {
    const d = evaluateHostSilentReplyGuard("2026.5.22broken", CFG_UNSET);
    expect(d.warn).toBe(true);
    expect(d.reason).toBe("unknown-version");
    expect(d.message).toContain("could not compare");
    expect(d.message).toContain(SILENT_REPLY_REWRITE_KEY);
  });

  it("2026.5.22.1 → the 'could not check' WARN", () => {
    const d = evaluateHostSilentReplyGuard("2026.5.22.1", CFG_UNSET);
    expect(d.warn).toBe(true);
    expect(d.reason).toBe("unknown-version");
    expect(d.message).toContain("could not compare");
  });

  it("a suffix whose numeric core EQUALS the floor is NOT provably at the floor → WARN", () => {
    for (const v of ["2026.5.22-1", "2026.5.22-beta.1", "2026.5.22+rev"]) {
      const d = evaluateHostSilentReplyGuard(v, CFG_UNSET);
      expect(d.warn, `host ${v}`).toBe(true);
      expect(d.reason).toBe("rewrite-hazard");
    }
  });

  it("... but an explicit false still suppresses it", () => {
    expect(evaluateHostSilentReplyGuard("2026.5.22-1", CFG_OFF).warn).toBe(false);
  });

  it("a suffix with a core STRICTLY above the floor → no WARN", () => {
    for (const v of ["2026.5.23-1", "2026.6.0-rc.1", "2026.8.1+rev"]) {
      expect(evaluateHostSilentReplyGuard(v, CFG_UNSET).warn, `host ${v}`).toBe(false);
    }
  });

  it("the real host strings: 2026.5.7 → WARN, 2026.5.3-1 → WARN, 2026.8.1 → no WARN", () => {
    expect(evaluateHostSilentReplyGuard("2026.5.7", CFG_UNSET).warn).toBe(true);
    expect(evaluateHostSilentReplyGuard("2026.5.3-1", CFG_UNSET).warn).toBe(true);
    expect(evaluateHostSilentReplyGuard("2026.8.1", CFG_UNSET).warn).toBe(false);
  });
});

describe("the trap, demonstrated", () => {
  it("resolving openclaw from the plugin's OWN directory is the dev dependency, NOT the host", () => {
    // The dev-dep openclaw (used only for types/tests) is present beside this
    // plugin; a check built on require.resolve from here would read ITS version,
    // not the host's. The detection above deliberately does not do that.
    const devDepPkg = join(import.meta.dirname, "..", "node_modules", "openclaw", "package.json");
    const devVersion = JSON.parse(readFileSync(devDepPkg, "utf-8")).version as string;
    expect(typeof devVersion).toBe("string");
    // And the host signal does not consult it: an entry with no openclaw above
    // it resolves to null even though this dev dep exists.
    expect(detectHostOpenClawVersion(join(import.meta.dirname, "host-version.test.ts"))).toBe(null);
  });
});
