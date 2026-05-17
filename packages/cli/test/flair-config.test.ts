import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readFlairConfigFile,
  writeFlairConfigFile,
  redactUrlCredentials,
  type FlairConfigFile,
} from "../src/commands/flair.js";

describe("flair config (ops-wn6g)", () => {
  let root: string;
  let prevHome: string | undefined;
  let prevRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-flair-config-"));
    prevHome = process.env.HOME;
    prevRoot = process.env.TPS_ROOT;
    process.env.HOME = root;
    process.env.TPS_ROOT = join(root, ".tps");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevRoot === undefined) delete process.env.TPS_ROOT;
    else process.env.TPS_ROOT = prevRoot;
  });

  test("readFlairConfigFile returns hub-less defaults when no file exists", () => {
    const cfg = readFlairConfigFile();
    expect(cfg.hub).toBeNull();
    expect(cfg.auth).toBeNull();
    expect(cfg.localPort).toBe(9926);
  });

  test("writeFlairConfigFile + readFlairConfigFile round-trips", () => {
    const written: FlairConfigFile = {
      hub: "https://flair.example.com",
      auth: { mode: "admin-pass-file", path: "/home/me/.flair/admin-pass" },
      localPort: 19926,
    };
    writeFlairConfigFile(written);
    const read = readFlairConfigFile();
    expect(read).toEqual(written);
  });

  test("writeFlairConfigFile uses atomic .tmp + rename (no partial file visible)", () => {
    writeFlairConfigFile({ hub: "https://x.test", auth: null, localPort: 9926 });
    const tpsDir = process.env.TPS_ROOT!;
    // After successful write, the .tmp file should not exist
    const files = require("node:fs").readdirSync(tpsDir);
    expect(files.some((f: string) => f.startsWith("flair.json.") && f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain("flair.json");
  });

  test("config file is mode 0600 (private)", () => {
    writeFlairConfigFile({ hub: "https://x.test", auth: null, localPort: 9926 });
    const p = join(process.env.TPS_ROOT!, "flair.json");
    const st = statSync(p);
    // Mask off the file-type bits (S_IFREG etc), keep just the perms.
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("readFlairConfigFile tolerates auth field with unknown mode (defaults to null)", () => {
    // Future-proofing: if a newer version writes a mode we don't know,
    // current readers shouldn't blow up — they should treat it as no-auth.
    const tpsDir = process.env.TPS_ROOT!;
    mkdirSync(tpsDir, { recursive: true });
    writeFileSync(
      join(tpsDir, "flair.json"),
      JSON.stringify({
        hub: "https://x.test",
        auth: { mode: "some-future-mode", path: "/x" },
        localPort: 9926,
      }),
    );
    const cfg = readFlairConfigFile();
    expect(cfg.hub).toBe("https://x.test");
    expect(cfg.auth).toBeNull(); // unknown mode → null
  });

  test("readFlairConfigFile handles missing localPort by defaulting to 9926", () => {
    const tpsDir = process.env.TPS_ROOT!;
    mkdirSync(tpsDir, { recursive: true });
    writeFileSync(
      join(tpsDir, "flair.json"),
      JSON.stringify({ hub: "https://x.test" }),
    );
    const cfg = readFlairConfigFile();
    expect(cfg.localPort).toBe(9926);
  });

  test("writeFlairConfigFile creates ~/.tps/ if missing", () => {
    // Fresh tmpdir — no .tps subdir yet
    expect(existsSync(process.env.TPS_ROOT!)).toBe(false);
    writeFlairConfigFile({ hub: null, auth: null, localPort: 9926 });
    expect(existsSync(process.env.TPS_ROOT!)).toBe(true);
    expect(existsSync(join(process.env.TPS_ROOT!, "flair.json"))).toBe(true);
  });

  test("hub-less mode persists across read (Nathan 2026-05-17: hub-less is valid)", () => {
    writeFlairConfigFile({ hub: null, auth: null, localPort: 9926 });
    const cfg = readFlairConfigFile();
    expect(cfg.hub).toBeNull();
    // Verify it serializes as JSON null, not missing key
    const raw = JSON.parse(readFileSync(join(process.env.TPS_ROOT!, "flair.json"), "utf-8"));
    expect(raw).toHaveProperty("hub", null);
  });

  // Round-trip persistence of trimmed URL (Kern nit, PR #284 review)
  test("writeFlairConfigFile preserves the trimmed URL exactly as set", () => {
    // Direct write of a normalized URL — set-hub trims before passing this in.
    writeFlairConfigFile({ hub: "https://flair.example.com", auth: null, localPort: 9926 });
    const cfg = readFlairConfigFile();
    expect(cfg.hub).toBe("https://flair.example.com");
    // No leading/trailing whitespace at rest
    expect(cfg.hub).toBe((cfg.hub as string).trim());
  });
});

describe("redactUrlCredentials (Sherlock nit, PR #284)", () => {
  test("strips user:pass@ from a URL with embedded credentials", () => {
    expect(redactUrlCredentials("https://admin:secret@flair.example.com/path")).toBe(
      "https://flair.example.com/path",
    );
  });

  test("strips username-only (no password)", () => {
    expect(redactUrlCredentials("https://admin@flair.example.com")).toBe(
      "https://flair.example.com/",
    );
  });

  test("leaves a credential-free URL unchanged", () => {
    expect(redactUrlCredentials("https://flair.example.com/path?q=1")).toBe(
      "https://flair.example.com/path?q=1",
    );
  });

  test("returns the input unchanged for non-URL strings", () => {
    expect(redactUrlCredentials("not-a-url")).toBe("not-a-url");
  });
});
