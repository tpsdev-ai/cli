/**
 * probe.ts — the CI-only probe fixture for the gateway-boundary lane (section
 * E). It is NOT a production verb. It is registered only when the host sets
 * TPS_GITHUB_REVIEW_CI_PROBE=1, through the same `api.registerTool` mechanism as
 * the real verb — and OpenClaw accepts that registration only from a manifest
 * that declares it: the SHIPPED manifest does not, so the registry rejects the
 * probe there. The lane registers it from a manifest overlay it creates, to
 * establish that this code path executes in the gateway process, reads a
 * host-only marker, and sees the tool context OpenClaw supplied.
 */

import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";

function textResult(text: string): Awaited<ReturnType<AnyAgentTool["execute"]>> {
  return { content: [{ type: "text", text }], details: {} } as Awaited<
    ReturnType<AnyAgentTool["execute"]>
  >;
}

/** The tool-context fields the probe reports back (supplied by OpenClaw). */
export interface ProbeContext {
  sessionKey?: string;
  agentId?: string;
  sandboxed?: boolean;
}

/** Build the probe tool. `markerPath` comes from the harness environment; the
 *  probe reads it and reports host identity and the context it was built for. */
export function createCiProbeTool(markerPath: string | null, ctx: ProbeContext = {}): AnyAgentTool {
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
          context: {
            sessionKey: ctx.sessionKey ?? null,
            agentId: ctx.agentId ?? null,
            sandboxed: ctx.sandboxed ?? null,
          },
        }),
      );
    },
  };
}
