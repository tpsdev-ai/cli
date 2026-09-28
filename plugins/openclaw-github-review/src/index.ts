/**
 * openclaw-github-review — a separate, independently versioned OpenClaw plugin
 * that registers ONE host-side verb, `github_review`.
 *
 * The handler executes in the gateway process on the host. It is bound to the
 * calling session's trusted dispatch assignment: the caller's `repo`, `pr` and
 * `commit_id` MUST equal the host assignment and the host-fetched head. The
 * GitHub credential is read once, here, into a #private field of the custody
 * object and is never re-read or disclosed. Every post emits a signed Flair
 * OrgEvent.
 *
 * This plugin depends on the mail plugin in NO way: it has its own
 * installation, deployment and rollback lifecycle.
 */

import { randomUUID } from "node:crypto";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveConfig, type GithubReviewConfig } from "./config.js";
import { FileAssignmentResolver } from "./assignment.js";
import { CredentialCustody } from "./credential.js";
import { HttpGitHubApi } from "./github.js";
import { FlairHttpAuditSink } from "./flair-sink.js";
import {
  FilePendingAuditStore,
  FileReconcileStore,
  MemoryPendingAuditStore,
  MemoryReconcileStore,
  retryPendingAudits,
} from "./audit.js";
import { outcomeToJson, runGithubReview, type HandlerDeps } from "./handler.js";
import { createCiProbeTool } from "./probe.js";
import { REVIEW_EVENTS, type AssignmentResolver, type AuditSink, type ReconcileStore, type SessionContext } from "./types.js";

export const TOOL_NAME = "github_review";
export const CI_PROBE_ENV = "TPS_GITHUB_REVIEW_CI_PROBE";
export const CI_PROBE_TOOL_NAME = "github_review_ci_probe";
export const HOST_MARKER_ENV = "TPS_GITHUB_REVIEW_HOST_MARKER";

const GITHUB_REVIEW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["repo", "pr", "commit_id", "event", "body"],
  properties: {
    repo: { type: "string", description: "owner/repo; must equal the session's dispatch assignment" },
    pr: { type: "integer", minimum: 1, description: "must equal the session's dispatch assignment" },
    commit_id: { type: "string", description: "the reviewed commit SHA; must equal the PR's current head" },
    event: { type: "string", enum: [...REVIEW_EVENTS] },
    body: { type: "string", description: "the review body; treated as opaque text" },
  },
} as unknown as AnyAgentTool["parameters"];

function textResult(text: string): Awaited<ReturnType<AnyAgentTool["execute"]>> {
  return { content: [{ type: "text", text }], details: {} } as Awaited<
    ReturnType<AnyAgentTool["execute"]>
  >;
}

/** Build the one production tool. `session` is the TRUSTED gateway context; the
 *  caller's arguments can never supply or override it. */
export function createGithubReviewTool(deps: HandlerDeps, session: SessionContext): AnyAgentTool {
  return {
    name: TOOL_NAME,
    label: "GitHub Review",
    description:
      "Host-side posting of a single pull-request review under the trusted reviewer identity. The credential stays on the host.",
    parameters: GITHUB_REVIEW_PARAMETERS,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const outcome = await runGithubReview(rawParams, session, deps);
      return textResult(outcomeToJson(outcome));
    },
  };
}

/** Services a caller may inject (tests only). Production always resolves the
 *  concrete host-side implementations. */
export interface HandlerServices {
  assignments?: AssignmentResolver;
  github?: HandlerDeps["github"];
  audit?: AuditSink;
  pendingAudits?: HandlerDeps["pendingAudits"];
  reconcile?: ReconcileStore;
  /** The fetch the Flair audit sink uses (tests point it at a controlled server). */
  flairFetch?: typeof fetch;
  clock?: () => Date;
  newId?: () => string;
}

export function buildDeps(
  config: GithubReviewConfig,
  custody: CredentialCustody,
  services: HandlerServices = {},
): HandlerDeps {
  const pendingAudits =
    services.pendingAudits ??
    (config.pendingAuditFile ? new FilePendingAuditStore(config.pendingAuditFile) : new MemoryPendingAuditStore());
  const reconcile =
    services.reconcile ??
    (config.reconcileFile ? new FileReconcileStore(config.reconcileFile) : new MemoryReconcileStore());
  const audit: AuditSink =
    services.audit ??
    (config.signingKeyFile && config.reviewerIdentity
      ? new FlairHttpAuditSink(config.reviewerIdentity, config.flairUrl, config.signingKeyFile, services.flairFetch ?? fetch)
      : {
          record: async () => {
            throw new Error("audit sink unavailable");
          },
        });
  return {
    config,
    custody,
    assignments:
      services.assignments ??
      (config.assignmentsFile ? new FileAssignmentResolver(config.assignmentsFile) : { resolve: () => null }),
    github: services.github ?? new HttpGitHubApi({ custody }),
    audit,
    pendingAudits,
    reconcile,
    // The review environment's versions and image digest come from the reviewer
    // image (section A); until then they are null, NOT the gateway's own values.
    runtime: {
      bunVersion: null,
      nodeVersion: null,
      sandboxImageDigest: null,
      pluginVersion: config.pluginVersion,
    },
    clock: services.clock ?? (() => new Date()),
    newId: services.newId ?? (() => randomUUID()),
  };
}

/** Register the one production verb and (only under the CI flag) the probe,
 *  through the gateway's registration mechanism. Deps are supplied by the
 *  caller so the CI lane can register the SAME code path with controlled
 *  services. */
export function registerWithDeps(api: OpenClawPluginApi, deps: HandlerDeps): void {
  const isFull = (api as { registrationMode?: string }).registrationMode === "full";
  const reviewer = deps.config.reviewerIdentity;

  api.registerTool(
    (toolCtx) => {
      // The verb is offered ONLY to the configured reviewer agent.
      if (reviewer !== null && toolCtx.agentId !== reviewer) return null;
      return createGithubReviewTool(deps, {
        sessionKey: toolCtx.sessionKey ?? null,
        agentId: toolCtx.agentId ?? null,
      });
    },
    { name: TOOL_NAME },
  );
  api.logger.info(`openclaw-github-review: registered "${TOOL_NAME}"`);

  // Retry any audit write that failed after a confirmed post — WITHOUT
  // reposting a review. Host-side work, so only on a full gateway registration.
  if (isFull) {
    void retryPendingAudits(deps.pendingAudits, deps.audit).catch(() => {});
  }

  // CI-only probe, gated so production never exposes a second verb.
  if (process.env[CI_PROBE_ENV] === "1") {
    const marker = process.env[HOST_MARKER_ENV] ?? null;
    api.registerTool(() => createCiProbeTool(marker), { name: CI_PROBE_TOOL_NAME });
    api.logger.info(`openclaw-github-review: registered CI probe "${CI_PROBE_TOOL_NAME}"`);
  }
}

/** Register the plugin. Never throws for missing credentials or configuration:
 *  an unusable state is expressed as an explicit refusal at call time. Credential
 *  reads and the audit retry are host-side work, gated on a full registration. */
export function registerGithubReview(api: OpenClawPluginApi, services: HandlerServices = {}): void {
  const pluginVersion = (api as { version?: string }).version ?? "0.1.0";
  const config = resolveConfig((api as { pluginConfig?: unknown }).pluginConfig, pluginVersion);
  const isFull = (api as { registrationMode?: string }).registrationMode === "full";

  // Load the credential ONCE, at gateway start, into the closure — only on a
  // full registration; other modes (discovery, cli-metadata) must not read it.
  const { custody, detail } = CredentialCustody.load({
    credentialFile: isFull ? config.credentialFile : null,
    provisioningFile: isFull ? config.provisioningFile : null,
    maxAgeDays: config.provisioningMaxAgeDays,
    clock: () => new Date(),
  });
  if (isFull) api.logger.info(`openclaw-github-review: credential ${detail}`);

  // If the signing key cannot be loaded, mark signing unavailable so the
  // handler refuses rather than appearing to work.
  if (isFull && config.signingKeyFile) {
    try {
      // A throwaway load proves readability; the real sink loads it again only
      // inside the host-side audit path.
      void new FlairHttpAuditSink(config.reviewerIdentity ?? "", config.flairUrl, config.signingKeyFile, services.flairFetch ?? fetch);
    } catch (err) {
      api.logger.warn(`openclaw-github-review: signing key unusable (${(err as Error).message}); posting disabled`);
      config.signingKeyFile = null;
    }
  }

  registerWithDeps(api, buildDeps(config, custody, services));
}

export default {
  register(api: OpenClawPluginApi) {
    registerGithubReview(api);
  },
};
