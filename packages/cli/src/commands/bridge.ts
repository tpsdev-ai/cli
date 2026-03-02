/**
 * tps bridge — OpenClaw Mail Bridge lifecycle
 *
 * Subcommands:
 *   start   Start the bridge daemon
 *   stop    Stop the bridge daemon
 *   status  Show bridge status
 */

import { bridgeStatus, startBridgeDaemon } from "../utils/mail-bridge.js";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeArgs {
  action: "start" | "stop" | "status";
  port?: number;
  openClawUrl?: string;
  bridgeAgentId?: string;
  defaultAgentId?: string;
  mailDir?: string;
  json?: boolean;
}

export async function runBridge(args: BridgeArgs): Promise<void> {
  switch (args.action) {
    case "start": {
      const st = bridgeStatus();
      if (st.running) {
        console.log(`Bridge already running (pid ${st.pid}, port ${st.port})`);
        process.exit(0);
      }

      // Start in-process (caller should run as a daemon / background process)
      startBridgeDaemon({
        port: args.port,
        openClawUrl: args.openClawUrl,
        bridgeAgentId: args.bridgeAgentId,
        defaultAgentId: args.defaultAgentId,
        mailDir: args.mailDir,
      });
      break;
    }

    case "stop": {
      const st = bridgeStatus();
      if (!st.running) {
        console.log("Bridge is not running.");
        break;
      }
      try {
        process.kill(st.pid!, "SIGTERM");
        // Clean up PID file (try both old and new paths)
        const pidDir = join(homedir(), ".tps", "run");
        rmSync(join(pidDir, "bridge-openclaw.pid"), { force: true });
        rmSync(join(pidDir, "mail-bridge.pid"), { force: true });
        console.log(`Bridge (pid ${st.pid}) stopped.`);
      } catch {
        console.log("Bridge was not running (stale pid cleaned up).");
      }
      break;
    }

    case "status": {
      const st = bridgeStatus();
      if (args.json) {
        console.log(JSON.stringify(st));
      } else if (st.running) {
        console.log(`Bridge running: pid=${st.pid}, port=${st.port}`);
      } else {
        console.log("Bridge is not running.");
      }
      break;
    }

    default: {
      const _: never = args.action;
      console.error(`Unknown bridge action: ${_}`);
      process.exit(1);
    }
  }
}
