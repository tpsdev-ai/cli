import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OFFICE = resolve(import.meta.dir, "../dist/src/commands/office.js");
let home: string;
let fakeBin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-fed-exit-750-"));
  fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  const branch = join(home, ".tps", "branch-office", "agent-a");
  mkdirSync(branch, { recursive: true });
  writeFileSync(join(branch, "supervision.json"), JSON.stringify({
    tunnel: { plistLabel: "test-tunnel", localPort: 33700, tunnelVia: "branch-host", plistPath: "test-tunnel.plist" },
    office: { plistLabel: "test-office", plistPath: "test-office.plist" },
    installedAt: new Date().toISOString(),
  }));
  const authPath = join(home, "admin-pass");
  writeFileSync(authPath, "test-password");
  writeFileSync(join(home, ".tps", "flair.json"), JSON.stringify({
    hub: "https://flair.example",
    auth: { mode: "admin-pass-file", path: authPath },
    localPort: 9926,
  }));
  writeFileSync(join(fakeBin, "ssh"), `#!/bin/sh
shift 2
case "$*" in
  *"test -d ~/.flair"*) echo NO ;;
  "uname -s") echo "$FAKE_OS" ;;
  printf*) echo /home/agent-a ;;
  *"systemctl --user is-enabled"*) echo NOT_FOUND ;;
  *"flair sync --once"*) echo attempted > "$HOME/sync-attempted"; exit "$FAKE_SYNC_EXIT" ;;
esac
exit 0
`);
  chmodSync(join(fakeBin, "ssh"), 0o755);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function provision(os: string, syncExit: string) {
  const proc = Bun.spawn(["bun", "--eval", `
    const { provisionFlairIfRequested } = await import(${JSON.stringify(OFFICE)});
    await provisionFlairIfRequested({ tunnelVia: "branch-host" }, "agent-a");
  `], {
    cwd: home,
    env: { HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_OS: os, FAKE_SYNC_EXIT: syncExit },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  const manifest = JSON.parse(readFileSync(join(home, ".tps", "branch-office", "agent-a", "supervision.json"), "utf8"));
  return { status, stdout, stderr, fed: manifest.fedSync };
}

test("Linux initial federation sync failure exits 1", async () => {
  const result = await provision("Linux", "1");
  expect(readFileSync(join(home, "sync-attempted"), "utf8")).toContain("attempted");
  expect(result.fed.lastSync).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("initial sync failed");
  expect(result.status).toBe(1);
});

test("Linux initial federation sync success exits 0", async () => {
  const result = await provision("Linux", "0");
  expect(readFileSync(join(home, "sync-attempted"), "utf8")).toContain("attempted");
  expect(result.fed.lastSync).toEqual(expect.any(String));
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("macOS manual federation setup exits 0 with no initial sync", async () => {
  const result = await provision("Darwin", "1");
  expect(() => readFileSync(join(home, "sync-attempted"))).toThrow();
  expect(result.fed.lastSync).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("initial sync failed");
  expect(result.status).toBe(0);
});
