/**
 * ops-7x9y — unit tests for office supervision (launchd auto-provisioning).
 *
 * Tests: manifest I/O, plist rendering, port scanning, teardown logic.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateTunnelPlist,
  generateOfficePlist,
  writePlist,
  deletePlist,
  findFreeLaunchdPort,
  writeSupervision,
  readSupervision,
  supervisionExists,
  deleteSupervision,
  teardownSupervision,
} from "../src/commands/office-supervision.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TMP_HOME = join(homedir(), ".tps-test-supervision");
const LAUNCH_AGENTS_DIR = join(TMP_HOME, "Library", "LaunchAgents");
const BRANCH_DIR = join(TMP_HOME, ".tps", "branch-office", "test-branch");
const LOGS_DIR = join(TMP_HOME, ".tps", "logs");

beforeEach(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(BRANCH_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Supervision manifest read/write/round-trip
// ---------------------------------------------------------------------------

describe("supervision manifest", () => {
  test("writes and reads a valid supervision manifest", () => {
    const manifest = {
      tunnel: {
        plistLabel: "ai.tpsdev.tunnel-test-branch",
        plistPath: join(TMP_HOME, "Library", "LaunchAgents", "ai.tpsdev.tunnel-test-branch.plist"),
        localPort: 33744,
        tunnelVia: "tps-reed",
      },
      office: {
        plistLabel: "ai.tpsdev.office-test-branch",
        plistPath: join(TMP_HOME, "Library", "LaunchAgents", "ai.tpsdev.office-test-branch.plist"),
      },
      installedAt: "2026-05-17T14:57:00.000Z",
    };

    writeSupervision("test-branch", manifest, TMP_HOME);

    // Verify file exists
    const manifestPath = join(BRANCH_DIR, "supervision.json");
    expect(existsSync(manifestPath)).toBe(true);

    // Verify mode is 0644 (no secrets)
    const stat = require("node:fs").statSync(manifestPath);
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("644");

    // Verify round-trip
    const read = readSupervision("test-branch", TMP_HOME);
    expect(read).not.toBeNull();
    expect(read!.tunnel.plistLabel).toBe("ai.tpsdev.tunnel-test-branch");
    expect(read!.tunnel.localPort).toBe(33744);
    expect(read!.tunnel.tunnelVia).toBe("tps-reed");
    expect(read!.office.plistLabel).toBe("ai.tpsdev.office-test-branch");
    expect(read!.installedAt).toBe("2026-05-17T14:57:00.000Z");
  });

  test("returns null for missing manifest", () => {
    expect(readSupervision("nonexistent", TMP_HOME)).toBeNull();
    expect(supervisionExists("nonexistent", TMP_HOME)).toBe(false);
  });

  test("deleteSupervision removes the manifest", () => {
    const manifest = {
      tunnel: {
        plistLabel: "ai.tpsdev.tunnel-temp",
        plistPath: join(TMP_HOME, "Library", "LaunchAgents", "x.plist"),
        localPort: 33900,
        tunnelVia: "test",
      },
      office: {
        plistLabel: "ai.tpsdev.office-temp",
        plistPath: join(TMP_HOME, "Library", "LaunchAgents", "y.plist"),
      },
      installedAt: "2026-01-01T00:00:00Z",
    };
    writeSupervision("temp", manifest, TMP_HOME);
    expect(supervisionExists("temp", TMP_HOME)).toBe(true);

    deleteSupervision("temp", TMP_HOME);
    expect(supervisionExists("temp", TMP_HOME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Plist template rendering
// ---------------------------------------------------------------------------

describe("generateTunnelPlist", () => {
  test("renders correct SSH tunnel plist template", () => {
    const plist = generateTunnelPlist({
      name: "test-branch",
      localPort: 33744,
      tunnelVia: "tps-reed",
      home: TMP_HOME,
    });

    // Structure
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain("<!DOCTYPE plist PUBLIC");
    expect(plist).toContain('<plist version="1.0">');

    // Label (canonical: ai.tpsdev.tunnel-<name>)
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>ai.tpsdev.tunnel-test-branch</string>");

    // ProgramArguments: ssh -N -L <port>:127.0.0.1:<port> <tunnel-via>
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>-N</string>");
    expect(plist).toContain("<string>-L</string>");
    expect(plist).toContain("<string>33744:127.0.0.1:33744</string>");
    expect(plist).toContain("<string>tps-reed</string>");

    // KeepAlive (simple true, not a dict with Crashed)
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");

    // RunAtLoad
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");

    // Log paths under ~/.tps/logs/
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain(`<string>${join(LOGS_DIR, "tunnel-test-branch.log")}</string>`);
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain(`<string>${join(LOGS_DIR, "tunnel-test-branch.error.log")}</string>`);
  });

  test("renders different port correctly", () => {
    const plist = generateTunnelPlist({
      name: "branch-b",
      localPort: 33998,
      tunnelVia: "other-host",
      home: TMP_HOME,
    });

    expect(plist).toContain("<string>33998:127.0.0.1:33998</string>");
    expect(plist).toContain("<string>other-host</string>");
    expect(plist).toContain("<string>ai.tpsdev.tunnel-branch-b</string>");
  });
});

describe("generateOfficePlist", () => {
  test("renders correct office connect plist template", () => {
    const plist = generateOfficePlist({ name: "test-branch", home: TMP_HOME });

    // Structure
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain("<!DOCTYPE plist PUBLIC");
    expect(plist).toContain('<plist version="1.0">');

    // Label (canonical: ai.tpsdev.office-<name>)
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>ai.tpsdev.office-test-branch</string>");

    // ProgramArguments: bun run ~/ops/tps/packages/cli/dist/bin/tps.js office connect <name>
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain(`<string>${join(TMP_HOME, "ops/tps/packages/cli/dist/bin/tps.js")}</string>`);
    expect(plist).toContain("<string>office</string>");
    expect(plist).toContain("<string>connect</string>");
    expect(plist).toContain("<string>test-branch</string>");

    // WorkingDirectory: ~/ops/tps
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain(`<string>${join(TMP_HOME, "ops/tps")}</string>`);

    // KeepAlive
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");

    // Logs
    expect(plist).toContain(`<string>${join(LOGS_DIR, "office-test-branch.log")}</string>`);
    expect(plist).toContain(`<string>${join(LOGS_DIR, "office-test-branch.error.log")}</string>`);
  });
});

// ---------------------------------------------------------------------------
// 3. Port scanning
// ---------------------------------------------------------------------------

describe("findFreeLaunchdPort", () => {
  test("returns first port in range when no plists exist", () => {
    const port = findFreeLaunchdPort(TMP_HOME);
    expect(port).toBeGreaterThanOrEqual(33700);
    expect(port).toBeLessThanOrEqual(33999);
  });

  test("skips ports referenced in existing plists", () => {
    // Write a dummy plist claiming port 33700
    const occupyingPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-L</string>
    <string>33700:127.0.0.1:33700</string>
    <string>some-host</string>
  </array>
</dict>
</plist>`;
    writeFileSync(join(LAUNCH_AGENTS_DIR, "ai.tpsdev.tunnel-existing.plist"), occupyingPlist, "utf-8");

    const port = findFreeLaunchdPort(TMP_HOME);
    expect(port).toBe(33701); // 33700 is taken
  });

  test("skips multiple adjacent occupied ports", () => {
    // Occupy 33700 and 33701
    for (let i = 0; i < 2; i++) {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array><string>ssh</string><string>-N</string><string>-L</string><string>${33700 + i}:127.0.0.1:${33700 + i}</string><string>x</string></array>
</dict>
</plist>`;
      writeFileSync(join(LAUNCH_AGENTS_DIR, `ai.tpsdev.tunnel-${i}.plist`), plist, "utf-8");
    }

    const port = findFreeLaunchdPort(TMP_HOME);
    expect(port).toBe(33702);
  });

  test("throws when all ports in range are taken", () => {
    // Fill the entire range — just enough entries to trigger the throw
    const dummyPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ProgramArguments</key><array><string>-L</string><string>X</string></array></dict></plist>`;
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
      writeFileSync(
        join(LAUNCH_AGENTS_DIR, `plist-${p}.plist`),
        dummyPlist.replace("X", `${p}:127.0.0.1:${p}`),
        "utf-8"
      );
    }

    expect(() => findFreeLaunchdPort(TMP_HOME)).toThrow(/No free port/);
  });
});

// PORT_RANGE_START constant for the test above
const PORT_RANGE_START = 33700;
const PORT_RANGE_END = 33999;

// ---------------------------------------------------------------------------
// 4. Atomic plist write/delete
// ---------------------------------------------------------------------------

describe("writePlist / deletePlist", () => {
  test("writes plist atomically to ~/Library/LaunchAgents", () => {
    const label = "ai.tpsdev.tunnel-test-atom";
    const content = `<?xml version="1.0"?>
<plist version="1.0">
<dict><key>Label</key><string>${label}</string></dict>
</plist>`;

    const dest = writePlist(label, content, TMP_HOME);
    expect(existsSync(dest)).toBe(true);

    // Verify no .tmp left behind
    expect(existsSync(dest + ".tmp")).toBe(false);

    // Verify content
    const read = readFileSync(dest, "utf-8");
    expect(read).toBe(content);
  });

  test("deletePlist removes the file", () => {
    const label = "ai.tpsdev.tunnel-test-delete";
    const dest = writePlist(label, "<plist/>", TMP_HOME);
    expect(existsSync(dest)).toBe(true);

    deletePlist(label, TMP_HOME);
    expect(existsSync(dest)).toBe(false);
  });

  test("deletePlist is a no-op for nonexistent plists", () => {
    // Should not throw
    expect(() => deletePlist("nonexistent", TMP_HOME)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Revoke teardown
// ---------------------------------------------------------------------------

describe("teardownSupervision", () => {
  test("removes plist files and manifest on teardown", () => {
    const name = "branch-teardown";

    // Create dummy plist files
    const tunnelLabel = "ai.tpsdev.tunnel-branch-teardown";
    const officeLabel = "ai.tpsdev.office-branch-teardown";
    writePlist(tunnelLabel, `<plist><dict><key>Label</key><string>${tunnelLabel}</string></dict></plist>`, TMP_HOME);
    writePlist(officeLabel, `<plist><dict><key>Label</key><string>${officeLabel}</string></dict></plist>`, TMP_HOME);

    // Create manifest
    const manifest = {
      tunnel: {
        plistLabel: tunnelLabel,
        plistPath: join(LAUNCH_AGENTS_DIR, `${tunnelLabel}.plist`),
        localPort: 33750,
        tunnelVia: "tps-reed",
      },
      office: {
        plistLabel: officeLabel,
        plistPath: join(LAUNCH_AGENTS_DIR, `${officeLabel}.plist`),
      },
      installedAt: "2026-05-17T00:00:00Z",
    };
    writeSupervision(name, manifest, TMP_HOME);

    // Verify fixtures exist
    expect(existsSync(join(LAUNCH_AGENTS_DIR, `${tunnelLabel}.plist`))).toBe(true);
    expect(existsSync(join(LAUNCH_AGENTS_DIR, `${officeLabel}.plist`))).toBe(true);
    expect(supervisionExists(name, TMP_HOME)).toBe(true);

    // Teardown
    const result = teardownSupervision(name, TMP_HOME);
    expect(result).not.toBeNull();
    expect(result!.tunnelLabel).toBe(tunnelLabel);
    expect(result!.officeLabel).toBe(officeLabel);

    // Verify cleanup
    expect(existsSync(join(LAUNCH_AGENTS_DIR, `${tunnelLabel}.plist`))).toBe(false);
    expect(existsSync(join(LAUNCH_AGENTS_DIR, `${officeLabel}.plist`))).toBe(false);
    expect(supervisionExists(name, TMP_HOME)).toBe(false);
  });

  test("returns null when no supervision manifest exists", () => {
    const result = teardownSupervision("nonexistent", TMP_HOME);
    expect(result).toBeNull();
  });
});
