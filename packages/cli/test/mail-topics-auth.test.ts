import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTopic, publishToTopic } from "../src/utils/mail-topics.js";

let home: string;
let oldHome: string | undefined;
let oldKeys: string | undefined;
let oldMailDir: string | undefined;
let keys: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "topic-auth-"));
  keys = join(home, "keys");
  mkdirSync(keys);
  oldHome = process.env.HOME;
  oldKeys = process.env.TPS_TEST_KEYS_DIR;
  oldMailDir = process.env.TPS_MAIL_DIR;
  process.env.HOME = home;
  process.env.TPS_TEST_KEYS_DIR = keys;
  process.env.TPS_MAIL_DIR = join(home, "mail");
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldKeys === undefined) delete process.env.TPS_TEST_KEYS_DIR; else process.env.TPS_TEST_KEYS_DIR = oldKeys;
  if (oldMailDir === undefined) delete process.env.TPS_MAIL_DIR; else process.env.TPS_MAIL_DIR = oldMailDir;
  rmSync(home, { recursive: true, force: true });
});

test("topic publish without a key refuses before appending, even with no subscribers", () => {
  createTopic("alerts");
  const log = join(home, ".tps", "topics", "alerts", "log.jsonl");
  expect(() => publishToTopic("alerts", "flint", "hi")).toThrow(/no Ed25519 private key/);
  expect(readFileSync(log, "utf8")).toBe("");
});
