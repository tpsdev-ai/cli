import { listContexts, readContext, writeContext } from "../utils/context.js";

interface ContextArgs {
  action: "read" | "update" | "list";
  workstream?: string;
  summary?: string;
  json?: boolean;
}

export function runContext(args: ContextArgs): void {
  switch (args.action) {
    case "read": {
      if (!args.workstream) {
        console.error("Usage: tps context read <workstream>");
        process.exit(1);
      }
      const record = readContext(args.workstream);
      if (!record) {
        console.error(`No context found for workstream "${args.workstream}".`);
        process.exit(1);
      }
      if (args.json) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        console.log(`Workstream: ${record.workstream}`);
        console.log(`Updated:    ${record.updatedAt}`);
        console.log("");
        console.log(record.summary);
      }
      return;
    }

    case "update": {
      if (!args.workstream || !args.summary) {
        console.error("Usage: tps context update <workstream> --summary \"...\"");
        process.exit(1);
      }
      const record = writeContext(args.workstream, { summary: args.summary });
      if (args.json) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        console.log(`Updated context for ${record.workstream} at ${record.updatedAt}`);
      }
      return;
    }

    case "list": {
      const rows = listContexts();
      if (args.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log("No workstream context files found.");
      } else {
        console.log("Workstreams:");
        for (const row of rows) {
          console.log(`- ${row.workstream} (${row.updatedAt})`);
        }
      }
      return;
    }
  }
}
