/**
 * gal.ts — Global Address List CLI commands
 *
 * tps gal list                      List all entries
 * tps gal set <agentId> <branchId>  Map agent → branch
 * tps gal remove <agentId>          Remove entry
 * tps gal sync                      Seed from branch-office registrations
 */
import { galList, galLookup, galRemove, galSet, galSync } from "../utils/gal.js";

export interface GalArgs {
  action: "list" | "set" | "remove" | "sync";
  agentId?: string;
  branchId?: string;
  json?: boolean;
}

export function runGal(args: GalArgs): void {
  switch (args.action) {
    case "list": {
      const entries = galList();
      if (args.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log("GAL is empty. Use `tps gal set <agentId> <branchId>` to add entries.");
        return;
      }
      const maxAgent = Math.max(8, ...entries.map(e => e.agentId.length));
      const maxBranch = Math.max(8, ...entries.map(e => e.branchId.length));
      console.log(`${"AGENT".padEnd(maxAgent)}  ${"BRANCH".padEnd(maxBranch)}  UPDATED`);
      console.log(`${"-".repeat(maxAgent)}  ${"-".repeat(maxBranch)}  ${"-------------------"}`);
      for (const e of entries) {
        console.log(`${e.agentId.padEnd(maxAgent)}  ${e.branchId.padEnd(maxBranch)}  ${e.updatedAt.slice(0, 19)}`);
      }
      return;
    }

    case "set": {
      if (!args.agentId || !args.branchId) {
        console.error("Usage: tps gal set <agentId> <branchId>");
        process.exit(1);
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(args.agentId)) {
        console.error(`Invalid agentId: ${args.agentId} (alphanumeric, _ and - only)`);
        process.exit(1);
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(args.branchId)) {
        console.error(`Invalid branchId: ${args.branchId} (alphanumeric, _ and - only)`);
        process.exit(1);
      }
      const entry = galSet(args.agentId, args.branchId);
      if (args.json) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`GAL: ${args.agentId} → ${args.branchId}`);
      }
      return;
    }

    case "remove": {
      if (!args.agentId) {
        console.error("Usage: tps gal remove <agentId>");
        process.exit(1);
      }
      const removed = galRemove(args.agentId);
      if (args.json) {
        console.log(JSON.stringify({ removed, agentId: args.agentId }));
      } else if (removed) {
        console.log(`Removed GAL entry: ${args.agentId}`);
      } else {
        console.log(`No GAL entry found for: ${args.agentId}`);
        process.exit(1);
      }
      return;
    }

    case "sync": {
      const result = galSync();
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.added.length > 0) {
          console.log(`Added: ${result.added.join(", ")}`);
        }
        if (result.skipped.length > 0) {
          console.log(`Skipped (already present): ${result.skipped.join(", ")}`);
        }
        if (result.added.length === 0 && result.skipped.length === 0) {
          console.log("No branch-office entries found to sync.");
        }
      }
      return;
    }

    default: {
      console.error("Unknown gal action. Use: list, set, remove, sync");
      process.exit(1);
    }
  }
}
