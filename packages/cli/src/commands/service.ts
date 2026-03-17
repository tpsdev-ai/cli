/**
 * tps service — manage the branch service proxy registry
 *
 * OPS-122 Phase 1
 *
 * Usage:
 *   tps service register <name> <url> [--port <local-port>] [--desc <text>]
 *   tps service list [--json]
 *   tps service remove <name>
 */

import {
  registerService,
  removeService,
  listServices,
  validateServiceName,
} from "../utils/service-registry.js";

export interface ServiceArgs {
  action: "register" | "list" | "remove";
  name?: string;
  url?: string;
  port?: number;
  desc?: string;
  json?: boolean;
}

export async function runService(args: ServiceArgs): Promise<void> {
  switch (args.action) {
    case "register": {
      const name = args.name?.trim();
      const url = args.url?.trim();
      if (!name) { console.error("Usage: tps service register <name> <url>"); process.exitCode = 1; return; }
      if (!url) { console.error("Usage: tps service register <name> <url>"); process.exitCode = 1; return; }

      try {
        registerService(name, url, {
          ...(args.port ? { localPort: args.port } : {}),
          ...(args.desc ? { description: args.desc } : {}),
        });
        console.log(`✅ Service '${name}' registered → ${url}`);
        if (args.port) console.log(`   Local proxy port: ${args.port}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      }
      return;
    }

    case "list": {
      const services = listServices();
      if (args.json) {
        console.log(JSON.stringify(services, null, 2));
        return;
      }
      if (services.length === 0) {
        console.log("No services registered. Use: tps service register <name> <url>");
        return;
      }
      console.log("Registered services:\n");
      for (const svc of services) {
        const port = svc.localPort ? ` (local port: ${svc.localPort})` : "";
        const desc = svc.description ? `  ${svc.description}` : "";
        console.log(`  ${svc.name.padEnd(16)} ${svc.url}${port}${desc}`);
      }
      return;
    }

    case "remove": {
      const name = args.name?.trim();
      if (!name) { console.error("Usage: tps service remove <name>"); process.exitCode = 1; return; }
      try {
        validateServiceName(name);
        const removed = removeService(name);
        if (removed) {
          console.log(`✅ Service '${name}' removed`);
        } else {
          console.log(`Service '${name}' not found`);
          process.exitCode = 1;
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
      }
      return;
    }

    default:
      console.error("Usage: tps service <register|list|remove>");
      process.exitCode = 1;
  }
}
