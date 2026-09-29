/**
 * openclaw-github-review — a separate, independently versioned OpenClaw plugin
 * that registers ONE host-side verb, `github_review`.
 *
 * The handler executes in the gateway process on the host. It is bound to the
 * calling session's trusted dispatch assignment: the caller's `repo`, `pr` and
 * `commit_id` MUST equal the host assignment and the host-fetched head. The
 * GitHub credential is read once, here, into a #private field of the custody
 * object and is never re-read or disclosed. A review created with a readable
 * receipt gets a signed Flair OrgEvent, or a result saying its audit is
 * pending or not durably confirmed; an uncertain outcome is `unknown`
 * (handler.ts). A dispatch posts at most one verdict, for the processes
 * sharing the latch store's lock; only a response proving its own POST created
 * nothing releases it (dispatch-ledger.ts, latch-admin.ts).
 *
 * This plugin depends on the mail plugin in NO way: it has its own
 * installation, deployment and rollback lifecycle.
 */

import { randomUUID } from "node:crypto";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveConfig, type GithubReviewConfig } from "./config.js";
import { FileAssignmentResolver } from "./assignment.js";
import { CredentialCustody } from "./credential.js";
import { HttpGitHubApi } from "./github.js";
import { FlairHttpAuditSink } from "./flair-sink.js";
import { DispatchLedger } from "./dispatch-ledger.js";
import {
  FilePendingAuditStore,
  FileReconcileStore,
  MemoryPendingAuditStore,
  MemoryReconcileStore,
  retryPendingAudits,
} from "./audit.js";
import { outcomeToJson, runGithubReview, type HandlerDeps } from "./handler.js";
import { createCiProbeTool } from "./probe.js";
import {
  REVIEW_EVENTS,
  type AssignmentResolver,
  type AuditSink,
  type PendingAuditStore,
  type ReconcileStore,
  type SessionContext,
} from "./types.js";

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
    // One verdict per dispatch: ask OpenClaw's runner to serialize a batch that
    // contains this tool. The handler's in-flight guard enforces it regardless.
    executionMode: "sequential",
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
  pendingAudits?: PendingAuditStore;
  reconcile?: ReconcileStore;
  /** The fetch the Flair audit sink uses (tests point it at a controlled server). */
  flairFetch?: typeof fetch;
  clock?: () => Date;
  newId?: () => string;
  /** Where the handler's host log lines go (defaults to the gateway logger). */
  log?: (line: string) => void;
  /** The one-verdict ledger (registerGithubReview shares one per latch store). */
  ledger?: DispatchLedger;
}

/** The audit sink used when no signing key was loaded. The handler refuses
 *  before any request in that state; this sink only makes a direct misuse fail. */
const UNAVAILABLE_AUDIT: AuditSink = {
  record: async () => {
    throw new Error("audit sink unavailable");
  },
};

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
  return {
    config,
    custody,
    assignments:
      services.assignments ??
      (config.assignmentsFile ? new FileAssignmentResolver(config.assignmentsFile) : { resolve: () => ({ status: "missing" }) }),
    github: services.github ?? new HttpGitHubApi({ custody }),
    // buildDeps never reads the signing key: registerGithubReview loads the
    // sink, on a full registration only, and passes it in.
    audit: services.audit ?? UNAVAILABLE_AUDIT,
    pendingAudits,
    ledger: services.ledger ?? new DispatchLedger(reconcile),
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
    log: services.log ?? (() => {}),
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
      // The verb is offered ONLY to the configured reviewer agent — and to no
      // agent at all when no reviewer identity is configured.
      if (reviewer === null || toolCtx.agentId !== reviewer) return null;
      return createGithubReviewTool(deps, {
        sessionKey: toolCtx.sessionKey ?? null,
        agentId: toolCtx.agentId ?? null,
      });
    },
    { name: TOOL_NAME },
  );
  api.logger.info(
    `openclaw-github-review: registered "${TOOL_NAME}" (${(api as { registrationMode?: string }).registrationMode ?? "unknown"} registration)`,
  );

  // Retry any audit write that failed after a confirmed post — WITHOUT
  // reposting a review. Host-side work, so only on a full gateway registration.
  if (isFull) {
    void retryPendingAudits(deps.pendingAudits, deps.audit).catch(() => {
      api.logger.warn("openclaw-github-review: the pending-audit store could not be read; retained audit records were not retried");
    });
  }

  // CI-only probe, gated so production never exposes a second verb.
  if (process.env[CI_PROBE_ENV] === "1") {
    const marker = process.env[HOST_MARKER_ENV] ?? null;
    api.registerTool((toolCtx) => createCiProbeTool(marker, toolCtx), { name: CI_PROBE_TOOL_NAME });
    api.logger.info(`openclaw-github-review: registered CI probe "${CI_PROBE_TOOL_NAME}"`);
  }
}

/** What a FULL registration loads: the credential custody and the signing
 *  sink, each read once. Module-private — never exported, never on globalThis,
 *  never in plugin config or tool context. OpenClaw loads this module once per
 *  process but can register it again in another mode: it executes plugin tools
 *  from "tool-discovery" registrations it loads on demand. Such a registration
 *  of the SAME configuration in the same process reuses this state instead of
 *  reading any secret; a registration of any other configuration, or in a
 *  process with no full registration, has none and refuses at call time. */
interface HostState {
  configKey: string;
  custody: CredentialCustody;
  audit: AuditSink | undefined;
  signingKeyFile: string | null;
}
let hostState: HostState | null = null;

/** One ledger per durable latch store, shared by every registration in this
 *  process, so the in-flight guard and in-memory latches hold across them. */
const ledgers = new Map<string, DispatchLedger>();
function sharedLedger(reconcileFile: string): DispatchLedger {
  let ledger = ledgers.get(reconcileFile);
  if (!ledger) {
    ledger = new DispatchLedger(new FileReconcileStore(reconcileFile));
    ledgers.set(reconcileFile, ledger);
  }
  return ledger;
}

/** Register the plugin. Never throws for missing credentials or configuration:
 *  an unusable state is expressed as an explicit refusal at call time.
 *
 *  Host-side work — reading the GitHub credential and the signing key, and the
 *  audit retry — happens ONLY on a full registration. Every other mode
 *  (discovery, tool-discovery, cli-metadata, setup-runtime, setup-only) reads
 *  no secret and retries nothing: it reuses the host state a full registration
 *  of the same configuration loaded in this process, or has none. */
export function registerGithubReview(api: OpenClawPluginApi, services: HandlerServices = {}): void {
  const pluginVersion = (api as { version?: string }).version ?? "0.1.0";
  const mode = (api as { registrationMode?: string }).registrationMode ?? "unknown";
  const config = resolveConfig((api as { pluginConfig?: unknown }).pluginConfig, pluginVersion);
  const configKey = JSON.stringify(config);

  let custody: CredentialCustody;
  let audit = services.audit;
  if (mode === "full") {
    // Load the credential ONCE, at gateway start, into the closure.
    const loaded = CredentialCustody.load({
      credentialFile: config.credentialFile,
      provisioningFile: config.provisioningFile,
      maxAgeDays: config.provisioningMaxAgeDays,
      clock: () => new Date(),
    });
    custody = loaded.custody;
    api.logger.info(`openclaw-github-review: credential ${loaded.detail}`);

    // Load the signing key ONCE, into the sink. If it cannot be loaded, signing
    // is unavailable and the handler refuses rather than appearing to work.
    if (!audit && config.signingKeyFile) {
      try {
        audit = new FlairHttpAuditSink(config.reviewerIdentity ?? "", config.flairUrl, config.signingKeyFile, services.flairFetch ?? fetch);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        api.logger.warn(
          `openclaw-github-review: the signing key could not be loaded (${typeof code === "string" ? code : "unparsable key"}); posting disabled`,
        );
        config.signingKeyFile = null;
      }
    }
    hostState = { configKey, custody, audit, signingKeyFile: config.signingKeyFile };
  } else {
    // Never read a secret outside a full registration.
    const shared = hostState !== null && hostState.configKey === configKey ? hostState : null;
    config.credentialFile = null;
    config.provisioningFile = null;
    config.signingKeyFile = shared ? shared.signingKeyFile : null;
    custody =
      shared?.custody ??
      CredentialCustody.load({ credentialFile: null, provisioningFile: null, maxAgeDays: config.provisioningMaxAgeDays, clock: () => new Date() })
        .custody;
    audit = audit ?? shared?.audit;
    api.logger.info(
      shared
        ? `openclaw-github-review: this ${mode} registration uses the host state the full registration loaded in this process`
        : `openclaw-github-review: this ${mode} registration has no host state (no full registration of this configuration in this process); posting is unavailable from it`,
    );
  }

  const ledger = !services.reconcile && config.reconcileFile ? sharedLedger(config.reconcileFile) : undefined;
  registerWithDeps(
    api,
    buildDeps(config, custody, { ...services, audit, ledger, log: services.log ?? ((line) => api.logger.warn(line)) }),
  );
}

export default {
  register(api: OpenClawPluginApi) {
    registerGithubReview(api);
  },
};
