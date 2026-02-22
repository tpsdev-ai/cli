import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { sanitizeIdentifier } from "../schema/sanitizer.js";

const MAX_WALL_BYTES = 256 * 1024; // 256KB cap

function assertOfficeDir(officeDir: string): void {
  const resolved = resolve(officeDir);
  const root = resolve(join(process.env.HOME || homedir(), ".tps", "branch-office"));
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error(`Office directory out of bounds: ${officeDir}`);
  }
}

export function wallPath(officeDir: string): string {
  return join(officeDir, "WALL.md");
}

export function initWall(officeDir: string, officeName: string): void {
  assertOfficeDir(officeDir);
  const p = wallPath(officeDir);
  if (!existsSync(p)) {
    writeFileSync(p, `# ${officeName} — Broadcast Wall\n\n`, "utf-8");
  }
}

export function postToWall(officeDir: string, agent: string, message: string): void {
  assertOfficeDir(officeDir);
  const safe = sanitizeIdentifier(agent);
  if (!agent || safe !== agent) throw new Error(`Invalid agent id: ${agent}`);
  if (message.includes("\u0000")) throw new Error("Wall post contains invalid null byte.");
  if (Buffer.byteLength(message, "utf8") > 4096) throw new Error("Wall post exceeds 4KB limit.");

  const p = wallPath(officeDir);
  if (!existsSync(p)) throw new Error("Wall not initialized. Run initWall first.");

  const timestamp = new Date().toISOString();
  const entry = `\n**[${timestamp}] ${agent}:** ${message}\n`;

  // Check wall size cap (S17.2-A fix: check size AFTER append)
  const current = readFileSync(p, "utf-8");
  if (Buffer.byteLength(current + entry, "utf8") > MAX_WALL_BYTES) {
    throw new Error("Wall has reached maximum size (256KB). Archive or reset.");
  }

  appendFileSync(p, entry, "utf-8");
}

export function readWall(officeDir: string): string {
  assertOfficeDir(officeDir);
  const p = wallPath(officeDir);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8");
}

