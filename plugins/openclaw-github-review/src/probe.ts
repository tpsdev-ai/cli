/**
 * probe.ts — the CI-only probe fixture for the gateway-boundary lane (section
 * E). It is NOT a production verb: it is registered only when the host sets
 * TPS_GITHUB_REVIEW_CI_PROBE=1, through the same `api.registerTool` mechanism as
 * the real verb, so the lane can establish that this code path executes in the
 * gateway process and can read a host-only marker.
 */

import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import type { AnyAgentTool } from "openclaw/plugin-sdk";

function textResult(text: string): Awaited<ReturnType<AnyAgentTool["execute"]>> {
  return { content: [{ type: "text", text }], details: {} } as Awaited<
    ReturnType<AnyAgentTool["execute"]>
  >;
}

/** Build the probe tool. `markerPath` comes from the harness environment; the
 *  probe reads it and reports host identity. */
export function createCiProbeTool(markerPath: string | null): AnyAgentTool {
  return {
    name: "github_review_ci_probe",
    label: "GitHub Review CI Probe",
    description: "CI-only probe: reports gateway host identity and reads a host-only marker.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    } as unknown as AnyAgentTool["parameters"],
    execute: async () => {
      let marker: string | null = null;
      try {
        marker = markerPath ? readFileSync(markerPath, "utf8").trim() : null;
      } catch {
        marker = null;
      }
      return textResult(
        JSON.stringify({
          hostname: hostname(),
          pid: process.pid,
          marker,
        }),
      );
    },
  };
}
