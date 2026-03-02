/**
 * tps bridge — OpenClaw Mail Bridge lifecycle
 *
 * Subcommands:
 *   start   Start the bridge daemon
 *   stop    Stop the bridge daemon
 *   status  Show bridge status
 */

import { bridgeStatus, startBridgeDaemon } from "../utils/mail-bridge.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BRIDGE_PID_PATH = join(homedir(), ".tps", "run", "mail-bridge.pid");

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
      if (!existsSync(BRIDGE_PID_PATH)) {
        console.log("Bridge is not running.");
        break;
      }
      try {
        const raw = JSON.parse(readFileSync(BRIDGE_PID_PATH, "utf-8"));
        process.kill(raw.pid, "SIGTERM");
        rmSync(BRIDGE_PID_PATH, { force: true });
        console.log(`Bridge (pid ${raw.pid}) stopped.`);
      } catch {
        rmSync(BRIDGE_PID_PATH, { force: true });
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
