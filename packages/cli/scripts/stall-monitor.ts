#!/usr/bin/env bun
/**
 * TPS Agent Stall Monitor (Dead Man's Switch)
 * Watches an agent's activity (git commits + TPS mail) and pings them if they go dark.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { queryArchive } from "../src/utils/archive.js";

const STALL_AGENT = process.env.STALL_AGENT || "anvil";
const STALL_AUTHOR = process.env.STALL_AUTHOR || "anvil@tps.dev";
const STALL_REPO = process.env.STALL_REPO || process.cwd();
const STALL_TIMEOUT_MIN = parseInt(process.env.STALL_TIMEOUT_MIN || "20", 10);
const STALL_NOTIFY = process.env.STALL_NOTIFY || STALL_AGENT;

// Fix 3 (S21-C): Sanitize agent name to prevent path traversal
const safeAgent = STALL_AGENT.replace(/[^a-zA-Z0-9_-]/g, "");
const STATE_FILE = join(process.env.HOME || homedir(), ".tps", `stall-monitor-${safeAgent}.json`);

function getLastCommitTime(): number {
  try {
    // Fix 1 (S21-A): Separate author flag and value, use -- separator
    const result = spawnSync("git", ["-C", STALL_REPO, "log", "-1", "--author", STALL_AUTHOR, "--format=%cI", "--"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      return new Date(result.stdout.trim()).getTime();
    }
  } catch (err) {}
  return 0;
}

function getLastMailTime(): number {
  try {
    const results = queryArchive({ agent: STALL_AGENT, limit: 1 });
    if (results.length > 0) {
      return new Date(results[0].timestamp).getTime();
    }
  } catch (err) {}
  return 0;
}

async function run() {
  const lastCommit = getLastCommitTime();
  const lastMail = getLastMailTime();
  const lastActivity = Math.max(lastCommit, lastMail);

  if (lastActivity === 0) {
    console.log(`No activity found for agent ${STALL_AGENT}.`);
    return;
  }

  const minutesSince = (Date.now() - lastActivity) / 1000 / 60;
  console.log(`Last activity for ${STALL_AGENT} was ${minutesSince.toFixed(1)} minutes ago.`);

  if (minutesSince > STALL_TIMEOUT_MIN) {
    let lastAlertTime = 0;
    if (existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        lastAlertTime = state.lastAlertTime || 0;
      } catch (err) {}
    }

    // Alert at most once per hour
    const hoursSinceAlert = (Date.now() - lastAlertTime) / 1000 / 60 / 60;
    if (hoursSinceAlert > 1) {
      console.log(`⚠️ STALL DETECTED: Pinging ${STALL_NOTIFY}...`);
      const message = `Status check: no activity detected in the last ${minutesSince.toFixed(0)} minutes. Are you BLOCKED?`;
      
      // Use the local tps binary to send the mail
      const tpsBin = join(process.cwd(), "dist/bin/tps.js");
      
      // Fix 2 (S21-B): Inherit environment without hardcoded fallback
      const result = spawnSync("node", [tpsBin, "mail", "send", STALL_NOTIFY, message], { 
        encoding: "utf8",
        env: { ...process.env }
      });

      if (result.status === 0) {
        writeFileSync(STATE_FILE, JSON.stringify({ lastAlertTime: Date.now(), minutesSince }), "utf-8");
        console.log("Ping sent.");
      } else {
        console.error("Failed to send ping:", result.stderr);
      }
    } else {
      console.log(`Stall persistent, but already alerted ${hoursSinceAlert.toFixed(1)} hours ago. Skipping.`);
    }
  } else {
    // If agent is active, reset the alert state
    if (existsSync(STATE_FILE)) {
      writeFileSync(STATE_FILE, JSON.stringify({ lastAlertTime: 0 }), "utf-8");
    }
  }
}

run().catch(console.error);
