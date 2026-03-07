/**
 * tps soul — Human control plane for agent identity (soul).
 *
 * Subcommands:
 *   show <agentId>             Print current soul entries
 *   edit <agentId>             Open $EDITOR, PUT on save
 *   set <agentId> --file <f>   Load soul from a markdown/text file
 *   diff <agentId> --file <f>  Diff current soul against a file
 */

import { createFlairClient, defaultFlairKeyPath } from "../utils/flair-client.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SoulArgs {
  action: "show" | "edit" | "set" | "diff";
  agentId: string;
  file?: string;
  flairUrl?: string;
  json?: boolean;
  asAgent?: string;
  keyPath?: string;
}

function soulToText(entries: Array<{ key: string; value: string }>): string {
  if (entries.length === 0) return "";
  return entries.map((e) => `${e.key}: ${e.value}`).join("\n");
}

function textToEntries(text: string): Array<{ key: string; value: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) return null;
      return {
        key: line.slice(0, colonIdx).trim(),
        value: line.slice(colonIdx + 1).trim(),
      };
    })
    .filter(Boolean) as Array<{ key: string; value: string }>;
}

export async function runSoul(args: SoulArgs): Promise<void> {
  const flairUrl = args.flairUrl ?? process.env.FLAIR_URL ?? "http://127.0.0.1:9926";
  const actorId = args.asAgent ?? args.agentId;
  const flair = createFlairClient(actorId, flairUrl, args.keyPath ?? defaultFlairKeyPath(actorId));

  switch (args.action) {
    case "show": {
      const entries = await flair.getSoulFor(args.agentId);
      if (args.json) {
        console.log(JSON.stringify(entries, null, 2));
        break;
      }
      if (entries.length === 0) {
        console.log(`(No soul entries for ${args.agentId})`);
        break;
      }
      for (const e of entries) {
        console.log(`${e.key}: ${e.value}`);
      }
      break;
    }

    case "edit": {
      const entries = await flair.getSoulFor(args.agentId);
      const currentText = soulToText(entries);

      const tmpDir = join(homedir(), ".tps", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const tmpFile = join(tmpDir, `soul-${args.agentId}-${randomUUID()}.txt`);

      writeFileSync(tmpFile, currentText + "\n", "utf-8");

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      try {
        execSync(`${editor} ${tmpFile}`, { stdio: "inherit" });
      } catch {
        unlinkSync(tmpFile);
        console.error("Editor exited with error — soul not updated.");
        process.exit(1);
      }

      const newText = readFileSync(tmpFile, "utf-8").trim();
      unlinkSync(tmpFile);

      if (newText === currentText.trim()) {
        console.log("No changes.");
        break;
      }

      const newEntries = textToEntries(newText);
      if (newEntries.length === 0) {
        console.error("Empty soul file — aborting to prevent data loss.");
        process.exit(1);
      }

      for (const e of newEntries) {
        await flair.setSoulEntry(args.agentId, e.key, e.value);
      }
      console.log(`✓ Soul updated for ${args.agentId} (${newEntries.length} entries).`);
      break;
    }

    case "set": {
      if (!args.file) {
        console.error("Usage: tps soul set <agentId> --file <path>");
        process.exit(1);
      }
      if (!existsSync(args.file)) {
        console.error(`File not found: ${args.file}`);
        process.exit(1);
      }
      const text = readFileSync(args.file, "utf-8").trim();
      const entries = textToEntries(text);
      if (entries.length === 0) {
        console.error("No valid entries found in file. Format: 'key: value' per line.");
        process.exit(1);
      }
      for (const e of entries) {
        await flair.setSoulEntry(args.agentId, e.key, e.value);
      }
      console.log(`✓ Soul set for ${args.agentId} from ${args.file} (${entries.length} entries).`);
      break;
    }

    case "diff": {
      if (!args.file) {
        console.error("Usage: tps soul diff <agentId> --file <path>");
        process.exit(1);
      }
      const entries = await flair.getSoulFor(args.agentId);
      const currentText = soulToText(entries);

      if (!existsSync(args.file)) {
        console.error(`File not found: ${args.file}`);
        process.exit(1);
      }
      const fileText = readFileSync(args.file, "utf-8").trim();

      if (currentText.trim() === fileText.trim()) {
        console.log("No differences.");
        break;
      }

      // Simple line diff
      const current = currentText.split("\n");
      const file = fileText.split("\n");

      const removed = current.filter((l) => !file.includes(l)).map((l) => `- ${l}`);
      const added = file.filter((l) => !current.includes(l)).map((l) => `+ ${l}`);

      if (removed.length) console.log(removed.join("\n"));
      if (added.length) console.log(added.join("\n"));
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown soul action: ${_}`);
      process.exit(1);
    }
  }
}
