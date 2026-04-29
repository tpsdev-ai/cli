// Test fixtures
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const TEMP_ROOT = join(homedir(), ".tps", "test-temp");
export const INBOX_NEW = join(TEMP_ROOT, ".tps", "mail", "ember", "new");
export const INBOX_CUR = join(TEMP_ROOT, ".tps", "mail", "ember", "cur");
export const LAUNCHER = join(homedir(), "agents", "ember", "bin", "ember");

export async function setupTestInbox(): Promise<void> {
  await mkdir(INBOX_NEW, { recursive: true });
  await mkdir(INBOX_CUR, { recursive: true });
}

export async function cleanupTestInbox(): Promise<void> {
  try {
    await rm(TEMP_ROOT, { recursive: true, force: true });
  } catch {}
}

export async function writeTestMessage(id: string, from: string, body: string): Promise<string> {
  const filePath = join(INBOX_NEW, `${id}.json`);
  const msg = { id, from, body };
  await writeFile(filePath, JSON.stringify(msg), "utf8");
  return filePath;
}
