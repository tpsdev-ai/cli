/**
 * flair-task-loop.ts — Polls OrgEventCatchup for task.assigned events
 * targeting this agent. Runtime-agnostic: works without OpenClaw.
 *
 * Usage:
 *   import { startTaskLoop, TaskHandler } from "./flair-task-loop.js";
 *   startTaskLoop(flairClient, "anvil", async (event) => {
 *     console.log("Got task:", event.summary, event.refId);
 *   });
 */

import type { FlairClient } from "./flair-client.js";

export interface OrgEvent {
  id: string;
  kind: string;
  authorId: string;
  targetIds?: string[];
  summary: string;
  detail?: string;
  refId?: string;
  scope?: string;
  createdAt: string;
  expiresAt?: string;
}

export type TaskHandler = (event: OrgEvent) => Promise<void>;

const DEFAULT_POLL_MS = 10_000;

export function startTaskLoop(
  flair: FlairClient,
  agentId: string,
  handler: TaskHandler,
  opts: { pollIntervalMs?: number; kinds?: string[] } = {},
): { stop: () => void } {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const kinds = new Set(opts.kinds ?? ["task.assigned"]);
  let since = new Date().toISOString();
  let running = true;
  const seen = new Set<string>();

  async function poll() {
    while (running) {
      try {
        const events: OrgEvent[] = await (flair as any).request(
          "GET",
          `/OrgEventCatchup/${agentId}?since=${since}`,
        );

        for (const event of events ?? []) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);

          if (!kinds.has(event.kind)) continue;

          const targets = event.targetIds ?? [];
          if (targets.length > 0 && !targets.includes(agentId)) continue;

          console.log(`[${agentId}] Task received: ${event.kind} — ${event.summary}`);
          try {
            await handler(event);
          } catch (err: any) {
            console.error(`[${agentId}] Task handler error for ${event.id}: ${err.message}`);
          }
        }

        if (events && events.length > 0) {
          since = events[events.length - 1].createdAt;
        }

        // Cap seen set
        if (seen.size > 1000) {
          const arr = [...seen];
          arr.splice(0, arr.length - 500);
          seen.clear();
          arr.forEach((id) => seen.add(id));
        }
      } catch (err: any) {
        console.warn(`[${agentId}] Task loop poll error: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  poll();
  console.log(`[${agentId}] Task loop started (polling every ${pollMs / 1000}s)`);
  return { stop: () => { running = false; } };
}
