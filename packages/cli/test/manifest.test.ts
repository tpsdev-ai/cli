import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, discoverManifests, matchesFilter } from "../src/utils/manifest.js";

let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("loadManifest", () => {
  test("returns null for missing file", () => {
    expect(loadManifest("/non-existent/tps.yaml")).toBeNull();
  });

  test("returns null for invalid YAML", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const yamlPath = join(tmp, "tps.yaml");
    writeFileSync(yamlPath, "invalid: : yaml");
    expect(loadManifest(yamlPath)).toBeNull();
  });

  test("returns null for missing name field", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const yamlPath = join(tmp, "tps.yaml");
    writeFileSync(yamlPath, "description: no name");
    expect(loadManifest(yamlPath)).toBeNull();
  });

  test("parses minimal valid manifest", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const yamlPath = join(tmp, "tps.yaml");
    writeFileSync(yamlPath, "name: test-agent");
    const m = loadManifest(yamlPath);
    expect(m).not.toBeNull();
    expect(m?.name).toBe("test-agent");
  });

  test("applies defaults", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const yamlPath = join(tmp, "tps.yaml");
    writeFileSync(yamlPath, "name: test-agent\ncapabilities:\n  mail_handler: {}\n");
    const m = loadManifest(yamlPath);
    expect(m?.capabilities?.mail_handler?.priority).toBe(100);
    expect(m?.capabilities?.mail_handler?.timeout).toBe(30);
    expect(m?.capabilities?.mail_handler?.needs_roster).toBe(false);
    expect(m?.capabilities?.mail_handler?.enabled).toBe(true);
  });

  test("resolves exec path relative to manifest dir", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const yamlPath = join(tmp, "tps.yaml");
    writeFileSync(yamlPath, "name: test-agent\ncapabilities:\n  mail_handler:\n    exec: ./script.sh");
    const m = loadManifest(yamlPath);
    expect(m?.capabilities?.mail_handler?.exec).toBe(join(tmp, "script.sh"));
  });

  test("returns null if exec path escapes agent directory", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const yamlPath = join(tmp, "tps.yaml");
    writeFileSync(yamlPath, "name: test-agent\ncapabilities:\n  mail_handler:\n    exec: ../outside.sh");
    expect(loadManifest(yamlPath)).toBeNull();
  });
});

describe("discoverManifests", () => {
  test("returns [] for empty agentsDir", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    expect(discoverManifests(tmp)).toEqual([]);
  });

  test("discovers tps.yaml files in subdirectories", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(join(tmp, "agent1"), { recursive: true });
    writeFileSync(join(tmp, "agent1", "tps.yaml"), "name: agent1");
    const ms = discoverManifests(tmp);
    expect(ms.length).toBe(1);
    expect(ms[0].name).toBe("agent1");
  });

  test("sorts by priority ascending", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(join(tmp, "agent1"), { recursive: true });
    mkdirSync(join(tmp, "agent2"), { recursive: true });
    writeFileSync(join(tmp, "agent1", "tps.yaml"), "name: agent1\ncapabilities:\n  mail_handler:\n    priority: 50");
    writeFileSync(join(tmp, "agent2", "tps.yaml"), "name: agent2\ncapabilities:\n  mail_handler:\n    priority: 10");
    const ms = discoverManifests(tmp);
    expect(ms.length).toBe(2);
    expect(ms[0].name).toBe("agent2");
    expect(ms[1].name).toBe("agent1");
  });

  test("skips directories without tps.yaml", () => {
    tmp = join(tmpdir(), `manifest-test-${Date.now()}`);
    mkdirSync(join(tmp, "empty"), { recursive: true });
    expect(discoverManifests(tmp)).toEqual([]);
  });
});

describe("matchesFilter", () => {
  test("returns true when no match defined", () => {
    const m: any = { capabilities: { mail_handler: {} } };
    expect(matchesFilter(m, { from: "a", body: "b" })).toBe(true);
  });

  test("filters by from allowlist", () => {
    const m: any = { capabilities: { mail_handler: { match: { from: ["rockit"] } } } };
    expect(matchesFilter(m, { from: "rockit", body: "b" })).toBe(true);
    expect(matchesFilter(m, { from: "other", body: "b" })).toBe(false);
  });

  test("allows * in from list", () => {
    const m: any = { capabilities: { mail_handler: { match: { from: ["*"] } } } };
    expect(matchesFilter(m, { from: "anything", body: "b" })).toBe(true);
  });

  test("filters by bodyPattern regex", () => {
    const m: any = { capabilities: { mail_handler: { match: { bodyPattern: "^deploy" } } } };
    expect(matchesFilter(m, { from: "a", body: "deploy now" })).toBe(true);
    expect(matchesFilter(m, { from: "a", body: "status" })).toBe(false);
  });

  test("requires both from and bodyPattern to match", () => {
    const m: any = { capabilities: { mail_handler: { match: { from: ["rockit"], bodyPattern: "^deploy" } } } };
    expect(matchesFilter(m, { from: "rockit", body: "deploy" })).toBe(true);
    expect(matchesFilter(m, { from: "other", body: "deploy" })).toBe(false);
    expect(matchesFilter(m, { from: "rockit", body: "other" })).toBe(false);
  });
});
