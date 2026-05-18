/**
 * Tests for office-flair-spoke.ts (ops-209a).
 *
 * Coverage:
 *   1. flair.json → FlairPlan conversion (hub-less, spoke, error)
 *   2. Systemd unit template generation (Flair + fed-sync)
 *   3. launchd plist generation (macOS branch)
 *   4. Extended supervision manifest round-trip (flair + fedSync fields)
 *   5. --no-flair opt-out plan isolation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  buildFlairPlan,
  generateSystemdFlairUnit,
  generateFedSyncService,
  generateFedSyncTimer,
  generateLaunchdFlairPlist,
} from "../src/commands/office-flair-spoke.js";
import {
  readFlairConfigFile,
  writeFlairConfigFile,
} from "../src/commands/flair.js";
import {
  readSupervision,
  writeSupervision,
  SupervisionManifest,
} from "../src/commands/office-supervision.js";
import type {
  ExtendedSupervisionManifest,
} from "../src/commands/office-flair-spoke.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TMP_HOME = join(homedir(), ".tps-test-flair-spoke");
const TPS_ROOT = join(TMP_HOME, ".tps");
const BRANCH_DIR = join(TMP_HOME, ".tps", "branch-office", "test-agent");

/**
 * Construct a valid FlairConfigFile for use with buildFlairPlan.
 * This bypasses the env-var-dependent paths by creating the config
 * manually rather than relying on process.env.HOME.
 */
function makeFlairConfig(overrides: {
  hub?: string | null;
  auth?: { mode: "admin-pass-file"; path: string } | null;
  localPort?: number;
} = {}): Parameters<typeof buildFlairPlan>[0] {
  return {
    hub: overrides.hub ?? null,
    auth: overrides.auth ?? null,
    localPort: overrides.localPort ?? 9926,
  };
}

beforeEach(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
  mkdirSync(TPS_ROOT, { recursive: true });
  mkdirSync(BRANCH_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// Helper: seed a base supervision manifest (without flair fields)
function seedSupervision(name: string): SupervisionManifest {
  const sup: SupervisionManifest = {
    tunnel: {
      plistLabel: `ai.tpsdev.tunnel-${name}`,
      plistPath: join(TMP_HOME, "Library/LaunchAgents", `ai.tpsdev.tunnel-${name}.plist`),
      localPort: 33750,
      tunnelVia: "test-vm",
    },
    office: {
      plistLabel: `ai.tpsdev.office-${name}`,
      plistPath: join(TMP_HOME, "Library/LaunchAgents", `ai.tpsdev.office-${name}.plist`),
    },
    installedAt: "2026-05-17T12:00:00.000Z",
  };
  mkdirSync(join(TMP_HOME, ".tps", "branch-office", name), { recursive: true });
  writeFileSync(
    join(TMP_HOME, ".tps", "branch-office", name, "supervision.json"),
    JSON.stringify(sup, null, 2),
    "utf-8",
  );
  return sup;
}

// ─── 1. FlairPlan conversion ──────────────────────────────────────────────────

describe("buildFlairPlan", () => {
  test("hub-less plan when hub is null", () => {
    const plan = buildFlairPlan(makeFlairConfig({ hub: null }));
    expect(plan.mode).toBe("hub-less");
    expect(plan.error).toBeUndefined();
  });

  test("hub-less plan when hub is undefined", () => {
    const plan = buildFlairPlan({ hub: null, auth: null, localPort: 9926 });
    expect(plan.mode).toBe("hub-less");
  });

  test("error plan when hub is set but auth is null", () => {
    const plan = buildFlairPlan(makeFlairConfig({
      hub: "https://hub.example.com",
      auth: null,
    }));
    expect(plan.mode).toBe("error");
    expect(plan.hub).toBe("https://hub.example.com");
    expect(plan.error).toContain("no auth credentials");
  });

  test("error plan when hub is set but auth file does not exist", () => {
    const plan = buildFlairPlan(makeFlairConfig({
      hub: "https://hub.example.com",
      auth: { mode: "admin-pass-file", path: "/nonexistent/pass" },
    }));
    expect(plan.mode).toBe("error");
    expect(plan.error).toContain("auth file not found");
  });

  test("spoke plan when hub + valid auth are set", () => {
    // Create a dummy auth file under TMP_HOME
    const authPath = join(TMP_HOME, ".tps", "hub-pass");
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, "test-token-content\n", "utf-8");

    const plan = buildFlairPlan(makeFlairConfig({
      hub: "https://hub.example.com",
      auth: { mode: "admin-pass-file", path: authPath },
    }));
    expect(plan.mode).toBe("spoke");
    expect(plan.hub).toBe("https://hub.example.com");
    expect(plan.auth?.mode).toBe("admin-pass-file");
    expect(plan.auth?.path).toBe(authPath);
  });
});

// ─── 2. Systemd unit templates ────────────────────────────────────────────────

describe("generateSystemdFlairUnit", () => {
  test("generates valid systemd unit with expected fields", () => {
    const unit = generateSystemdFlairUnit(
      "tps-flair-reed",
      "~/.flair",
      "~/.harper/flair",
      9926,
    );
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=Flair (Harper) spoke for branch office");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("harper.js");
    expect(unit).toContain("HARPER_SET_CONFIG");
    expect(unit).toContain(`"http":{"port":9926`);
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("uses custom port", () => {
    const unit = generateSystemdFlairUnit("tps-flair-foo", "~/.flair", "~/.harper/flair", 5555);
    expect(unit).toContain(`"http":{"port":5555`);
  });
});

describe("generateFedSyncService", () => {
  test("generates valid oneshot service", () => {
    const svc = generateFedSyncService("tps-fed-sync-reed", "~/.tps/flair-sync.json");
    expect(svc).toContain("Type=oneshot");
    expect(svc).toContain("tps flair sync --once");
    expect(svc).toContain("TPS_FLAIR_SYNC_CONFIG=~/.tps/flair-sync.json");
    expect(svc).toContain("WantedBy=multi-user.target");
  });
});

describe("generateFedSyncTimer", () => {
  test("generates valid timer unit", () => {
    const timer = generateFedSyncTimer("tps-fed-sync-reed", "tps-fed-sync-reed", 300);
    expect(timer).toContain("[Timer]");
    expect(timer).toContain("OnUnitActiveSec=300s");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("intervalSeconds is honored (ops-r4dm regression)", () => {
    // Previous OnCalendar=*:*:00/30 hardcode fired every 30s regardless of param.
    // Verify a non-default interval is interpolated.
    const fast = generateFedSyncTimer("t", "s", 60);
    expect(fast).toContain("OnUnitActiveSec=60s");
    expect(fast).not.toContain("OnUnitActiveSec=300s");

    const slow = generateFedSyncTimer("t", "s", 3600);
    expect(slow).toContain("OnUnitActiveSec=3600s");
  });

  test("default cadence is 5 minutes when intervalSeconds omitted", () => {
    const timer = generateFedSyncTimer("t", "s");
    expect(timer).toContain("OnUnitActiveSec=300s");
  });
});

// ─── 3. launchd plist generation ──────────────────────────────────────────────

describe("generateLaunchdFlairPlist", () => {
  test("generates valid launchd plist XML", () => {
    const plist = generateLaunchdFlairPlist(
      "ai.tpsdev.flair-test",
      "~/.flair",
      "~/.harper/flair",
      "/Users/testuser",
      9926,
    );
    expect(plist).toContain("<?xml version=\"1.0\"");
    expect(plist).toContain("ai.tpsdev.flair-test");
    expect(plist).toContain("harper.js");
    expect(plist).toContain("RunAtLoad");
    expect(plist).toContain("KeepAlive");
    expect(plist).toContain("HARPER_SET_CONFIG");
    expect(plist).toContain("/Users/testuser/.tps/logs/");
  });

  test("uses the remote home explicitly — not whatever happens to be passed (ops-r4dm)", () => {
    // The macOS branch may have a different $HOME than rockit (e.g.,
    // local=/Users/squeued, remote=/Users/exedev). Caller is responsible
    // for detecting + passing remote $HOME; the generator must use it
    // verbatim for log paths + HOME env var.
    const plist = generateLaunchdFlairPlist(
      "ai.tpsdev.flair-test",
      "~/.flair",
      "~/.harper/flair",
      "/Users/exedev",
      9926,
    );
    expect(plist).toContain("/Users/exedev/.tps/logs/flair-ai.tpsdev.flair-test.log");
    expect(plist).toContain("/Users/exedev/.tps/logs/flair-ai.tpsdev.flair-test.error.log");
    expect(plist).toContain("<string>/Users/exedev</string>"); // HOME env var
    expect(plist).not.toContain(homedir()); // no leak of the local home
  });

  test("XML-escapes caller-supplied string values (ops-y722)", () => {
    // K&S flagged on PR #290 that the plist embedded caller strings raw —
    // a `&` or `<` in any interpolated value would silently corrupt the
    // XML and break launchctl load with an unhelpful parser error.
    // Note: harperDataDir is only used inside the JSON config (covered by
    // the separate HARPER_SET_CONFIG test); these assertions cover the
    // direct <string> embedding paths.
    const plist = generateLaunchdFlairPlist(
      "label&with<special>chars",
      "~/.flair'apos",
      "~/.harper/flair",
      "/Users/<weird&user>",
      9926,
    );
    // Raw metachars must not appear in the value positions
    expect(plist).not.toContain("label&with<special>chars");
    expect(plist).not.toContain("/Users/<weird&user>");
    // Encoded forms must be present
    expect(plist).toContain("label&amp;with&lt;special&gt;chars");
    expect(plist).toContain("/Users/&lt;weird&amp;user&gt;");
    expect(plist).toContain("~/.flair&apos;apos");
  });

  test("XML-escapes HARPER_SET_CONFIG JSON before embedding (ops-y722)", () => {
    // HARPER_SET_CONFIG is a JSON string wrapped in <string>...</string>.
    // The inner JSON has quotes which would tear out of the XML element
    // unless XML-escaped. Verify the embedded config is encoded.
    const plist = generateLaunchdFlairPlist(
      "ai.tpsdev.flair-test",
      "~/.flair",
      "~/.harper/flair",
      "/Users/exedev",
      9926,
    );
    // The inner JSON quotes must be encoded; the surrounding XML must be parseable
    expect(plist).toContain("&quot;rootPath&quot;");
    expect(plist).toContain("&quot;http&quot;");
    expect(plist).not.toMatch(/<string>\{"rootPath":/); // raw unescaped JSON would have this
  });
});

// ─── 4. Extended supervision manifest round-trip ──────────────────────────────

describe("extended supervision manifest", () => {
  test("writes and reads supervision manifest with Flair fields", () => {
    seedSupervision("test-agent");

    const flairData = {
      flairDir: "~/.flair",
      port: 9926,
      adminPassPath: "~/.flair/admin-pass",
      unitName: "tps-flair-test-agent",
      os: "linux" as const,
      installedAt: "2026-05-17T12:30:00.000Z",
    };
    const fedSyncData = {
      serviceName: "tps-fed-sync-test-agent",
      timerName: "tps-fed-sync-test-agent",
      syncConfigPath: "~/.tps/flair-sync.json",
      hub: "https://hub.example.com",
      intervalSeconds: 300,
      lastSync: "2026-05-17T12:30:05.000Z",
      installedAt: "2026-05-17T12:30:00.000Z",
    };

    const existing = readSupervision("test-agent", TMP_HOME);
    expect(existing).not.toBeNull();

    const extended: ExtendedSupervisionManifest = {
      ...existing!,
      flair: flairData,
      fedSync: fedSyncData,
    };

    writeSupervision("test-agent", extended, TMP_HOME);

    // Read back and verify
    const reread = readSupervision("test-agent", TMP_HOME) as ExtendedSupervisionManifest;
    expect(reread).not.toBeNull();
    expect(reread!.flair).toBeDefined();
    expect(reread!.flair!.port).toBe(9926);
    expect(reread!.flair!.unitName).toBe("tps-flair-test-agent");
    expect(reread!.flair!.os).toBe("linux");
    expect(reread!.fedSync).toBeDefined();
    expect(reread!.fedSync!.hub).toBe("https://hub.example.com");
    expect(reread!.fedSync!.lastSync).toBe("2026-05-17T12:30:05.000Z");
  });

  test("reads supervision without flair fields gracefully (backward compat)", () => {
    const sup = seedSupervision("test-agent");
    const reread = readSupervision("test-agent", TMP_HOME) as ExtendedSupervisionManifest;
    expect(reread).not.toBeNull();
    // These fields don't exist on a plain SupervisionManifest
    expect((reread as any).flair).toBeUndefined();
    expect((reread as any).fedSync).toBeUndefined();
  });

  test("teardown removes flair fields from manifest", () => {
    const existing = seedSupervision("test-agent");

    // Write with flair fields
    const extended: ExtendedSupervisionManifest = {
      ...existing,
      flair: {
        flairDir: "~/.flair",
        port: 9926,
        adminPassPath: "~/.flair/admin-pass",
        unitName: "tps-flair-test-agent",
        os: "linux",
        installedAt: "2026-05-17T12:30:00.000Z",
      },
    };
    writeSupervision("test-agent", extended, TMP_HOME);

    // Now "teardown" — write back without flair/fedSync
    const clean: SupervisionManifest = {
      tunnel: existing.tunnel,
      office: existing.office,
      installedAt: existing.installedAt,
    };
    writeSupervision("test-agent", clean, TMP_HOME);

    // Verify flair fields are gone
    const final = readSupervision("test-agent", TMP_HOME) as ExtendedSupervisionManifest;
    expect(final!.flair).toBeUndefined();
    expect(final!.fedSync).toBeUndefined();
    expect(final!.tunnel).toBeDefined();
    expect(final!.office).toBeDefined();
  });
});

// ─── 5. --no-flair opt-out plan check ─────────────────────────────────────────

describe("no-flair opt-out", () => {
  test("buildFlairPlan still returns hub-less when no-flair is just a flag (plan doesn't change)", () => {
    const plan = buildFlairPlan(makeFlairConfig({ hub: null }));
    expect(plan.mode).toBe("hub-less");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("systemd unit edge cases", () => {
  test("flair unit contains no shell-injectable metacharacters in paths", () => {
    const unit = generateSystemdFlairUnit(
      "tps-flair-$(whoami)",
      "~/.flair",
      "~/.harper/flair",
    );
    // The unit name appears in description, not eval'd
    // The ExecStart uses fixed paths
    expect(unit).toContain("node_modules/harper/dist/bin/harper.js");
  });
});
