import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { HireCommand } from "../src/cli/hire.js";

describe("hire onboarding mail UI", () => {
  let root: string;
  let emptyKeys: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-hire-mail-ui-"));
    emptyKeys = join(root, "empty-keys");
    mkdirSync(join(root, ".openclaw"), { recursive: true });
    mkdirSync(emptyKeys, { recursive: true });
    writeFileSync(join(root, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [] } }));
    savedEnv = {};
    for (const name of ["HOME", "TPS_AGENT_ID", "TPS_TEST_KEYS_DIR", "TPS_MAIL_DIR"]) {
      savedEnv[name] = process.env[name];
    }
    process.env.HOME = root;
    process.env.TPS_AGENT_ID = "host";
    process.env.TPS_TEST_KEYS_DIR = emptyKeys;
    process.env.TPS_MAIL_DIR = join(root, ".tps", "mail");
    // findOpenClawConfig walks up from the cwd to $HOME; run from inside the
    // throwaway HOME so that walk ends here and never reaches the invoking
    // host's ~/.openclaw/openclaw.json (cli#478).
    savedCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("a missing signing key leaves hire successful but marks onboarding mail FAILED with the named refusal", async () => {
    const mailDir = join(root, ".tps", "mail");
    const stdout = new PassThrough() as PassThrough & { columns: number };
    stdout.columns = 160;
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const instance = render(React.createElement(HireCommand, {
      reportPath: "developer",
      name: "MissingKey",
      dryRun: false,
      jsonOutput: false,
    }), { stdout: stdout as any, exitOnCtrlC: false });

    for (let attempt = 0; attempt < 100 && !output.includes("FAILED:"); attempt++) {
      await Bun.sleep(10);
    }
    instance.unmount();

    expect(output).toContain('❌ Sending onboarding mail — FAILED: no Ed25519 private key for agent "host"');
    expect(output).toContain(join(emptyKeys, "host.key"));
    expect(output).not.toContain("✅ Sending onboarding mail");
    expect(output).toContain("✅ Agent config injected into openclaw.json");

    const inbox = join(mailDir, "missingkey", "new");
    expect(existsSync(inbox) ? readdirSync(inbox) : []).toHaveLength(0);
  });
});
