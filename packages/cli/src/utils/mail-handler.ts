import { spawnSync } from "node:child_process";
import type { AgentManifest } from "./manifest.js";
import { matchesFilter } from "./manifest.js";

export interface HandlerAction {
  type: "reply" | "forward" | "drop" | "inbox";
  body?: string;
  to?: string;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

/**
 * Runs the mail handler pipeline for an incoming message.
 * Iterates through manifests in priority order (assumed sorted from discoverManifests).
 */
export async function runHandlerPipeline(
  msg: MailMessage,
  manifests: AgentManifest[],
  registeredAgents: string[],
): Promise<HandlerAction> {
  const enabledManifests = manifests.filter(
    (m) => m.capabilities?.mail_handler?.enabled !== false
  );

  for (const manifest of enabledManifests) {
    if (!matchesFilter(manifest, msg)) {
      continue;
    }

    const handler = manifest.capabilities?.mail_handler;
    const bodyToTest = msg.body.trim().slice(0, 1024);

    // 1. Check routing rules first
    if (manifest.routing) {
      for (const rule of manifest.routing) {
        try {
          const re = new RegExp(rule.pattern); // nosemgrep: detect-non-literal-regexp — pattern from validated tps.yaml config
          if (re.test(bodyToTest)) {
            return { type: "forward", to: rule.to, body: msg.body };
          }
        } catch (err) {
          // Skip invalid regex
        }
      }
    }

    // 2. Run exec handler if it exists
    if (handler?.exec) {
      const env: Record<string, string> = {
        ...process.env,
        MAIL_ID: msg.id,
        MAIL_FROM: msg.from,
        MAIL_TO: msg.to,
        MAIL_TIMESTAMP: msg.timestamp,
        TPS_AGENT_NAME: manifest.name,
      };

      if (handler.needs_roster) {
        env.TPS_REGISTERED_AGENTS = JSON.stringify(registeredAgents);
      }

      const timeoutMs = (handler.timeout || 30) * 1000;

      try {
        const result = spawnSync(handler.exec, [], {
          input: msg.body,
          env,
          timeout: timeoutMs,
          encoding: "utf8",
          shell: false,
          cwd: manifest.agentDir,
        });

        if (result.error) {
          console.error("[HANDLER] spawnSync error:", result.error);
          continue;
        }

        if (result.status === 0) {
          const stdout = result.stdout?.trim() || "";
          if (!stdout) {
            return { type: "drop" };
          }

          try {
            const json = JSON.parse(stdout);
            if (json && typeof json === "object" && json.action) {
              return {
                type: json.action,
                body: json.body,
                to: json.to,
              };
            }
          } catch (e) {
            // Not JSON, treat as plain text reply
          }

          return { type: "reply", body: stdout, to: msg.from };
        } else if (result.status === 1) {
          // Exit 1: continue to next manifest
          continue;
        } else {
          // Exit 2+: error, log and continue
          console.error(`[HANDLER] error: ${manifest.name} exited with ${result.status}`);
          continue;
        }
      } catch (err) {
        console.error("[HANDLER] exception running %s:", manifest.name, err); // nosemgrep: unsafe-formatstring
        continue;
      }
    }
  }

  return { type: "inbox" };
}
