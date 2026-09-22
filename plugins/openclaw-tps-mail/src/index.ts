/**
 * openclaw-tps-mail — OpenClaw Channel Plugin for TPS Mail
 *
 * Registers `tps-mail` as a first-class openclaw channel (alongside
 * discord/telegram/etc.) so inter-agent mail goes through the gateway's
 * native message routing instead of an external shell-hook wrapper
 * around `openclaw agent`.
 *
 * Inbound flow:
 *   fs.watch(~/.tps/mail/<agent>/new/) →
 *   parse TPS mail envelope →
 *   build MsgContext →
 *   dispatchReplyWithBufferedBlockDispatcher via channelRuntime →
 *   agent turn runs with standard gateway budgets/tooling →
 *   deliver callback writes reply back to sender's inbox →
 *   move original file new/ → cur/ with ackedAt set
 *
 * Outbound flow:
 *   outbound.sendText(ctx) →
 *   write TPS mail envelope to ~/.tps/mail/<ctx.to>/new/<id>.json
 *
 * Config in openclaw.json:
 *   channels.tps-mail.accounts.default.mailDir: ~/.tps/mail
 *   bindings: [{ agentId: "kern", match: { channel: "tps-mail", accountId: "default" } }]
 *   plugins.allow: [..., "openclaw-tps-mail"]
 *
 * Why this replaces the openclaw-deliver.sh hook:
 *   - External shell hook wraps `openclaw agent` CLI, which has a 60s
 *     per-request Gemini timeout that's too short for deep review tasks.
 *   - Native channel path uses the gateway's internal message loop, same
 *     as Discord/Telegram, which has the budget pacing K&S actually need.
 *   - Fixes the argv-leak by deletion — message body never goes through argv.
 *   - Eliminates the session accumulation pollution seen with the hook
 *     (hook always landed in `main` session, accumulating noise).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { Envelope, ChainEntry } from "@tpsdev-ai/agent";
import { signEnvelope } from "@tpsdev-ai/agent";
import { readAgentPrivateKey } from "@tpsdev-ai/cli/utils/agent-keys";
import { promote, recoverPromoted, sweepStrandedPromoteScratch } from "@tpsdev-ai/cli/utils/mail";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelConfigAdapter,
} from "openclaw/plugin-sdk/channels";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channels";

// ─── Config ──────────────────────────────────────────────────────────────────

interface TpsMailAccount {
  accountId: string;
  mailDir: string;    // resolved absolute path, e.g., /Users/.../.tps/mail
  enabled: boolean;
}

interface TpsMailBody {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read?: boolean;
  headers?: Record<string, string>;
  replyToId?: string;
  ackedAt?: string;
  nackedAt?: string;
  nackReason?: string;
  deliveryAttempts?: number;
}

const DEFAULT_MAIL_DIR = resolve(homedir(), ".tps", "mail");
const CHANNEL_ID = "tps-mail";

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
}

function resolveMailDir(cfg: any, accountId: string): string {
  const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts ?? {};
  const account = accounts[accountId] ?? accounts.default ?? {};
  return expandHome(account.mailDir ?? DEFAULT_MAIL_DIR);
}

// ─── Agent binding discovery ─────────────────────────────────────────────────
// Reads `cfg.bindings` to find all agents that should receive TPS mail for the
// given account. Each binding is `{ agentId, match: { channel, accountId } }`.

function findBoundAgents(cfg: any, accountId: string): string[] {
  const bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  const agents: string[] = [];
  for (const binding of bindings) {
    const match = binding?.match ?? {};
    if (match.channel !== CHANNEL_ID) continue;
    // Allow missing accountId to mean "default"
    const boundAcct = match.accountId ?? "default";
    if (boundAcct !== accountId) continue;
    if (typeof binding.agentId === "string") agents.push(binding.agentId);
  }
  return agents;
}

// ─── TPS mail envelope helpers ───────────────────────────────────────────────

function readMailFile(filePath: string): TpsMailBody | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TpsMailBody;
  } catch {
    return null;
  }
}

function writeMailFile(mailDir: string, recipient: string, message: TpsMailBody): string {
  const newDir = resolve(mailDir, recipient, "new");
  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
  const tsSlug = message.timestamp.replace(/[:.]/g, "-");
  const filename = `${tsSlug}-${message.id}.json`;
  const target = resolve(newDir, filename);
  writeFileSync(target, JSON.stringify(message, null, 2), "utf-8");
  return target;
}

/**
 * Write to ~/.tps/outbox/new/ for cross-host delivery via the TPS branch
 * service. The branch service drains this directory on each heartbeat and
 * relays messages over the wire to the host, which dispatches to the
 * recipient's actual host. Format matches packages/cli/src/utils/outbox.ts
 * `OutboxMessage`.
 */
function writeOutboxFile(message: TpsMailBody): string {
  const outboxNew = resolve(process.env.HOME ?? homedir(), ".tps", "outbox", "new");
  mkdirSync(outboxNew, { recursive: true });
  const tsSlug = message.timestamp.replace(/[:.]/g, "-");
  const filename = `${tsSlug}-${message.id}.json`;
  const target = resolve(outboxNew, filename);
  writeFileSync(
    target,
    JSON.stringify(
      {
        id: message.id,
        to: message.to,
        from: message.from,
        body: message.body,
        timestamp: message.timestamp,
        // The reply reference and marker headers MUST ride with the envelope:
        // for a remote recipient the outbox copy is the only record a later
        // scan (receipt/ack, S2) or the sender's own tooling can key on.
        ...(message.replyToId ? { replyToId: message.replyToId } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return target;
}

/**
 * Decide where to write outbound mail.
 * - Local recipient (bound to this gateway via `bindings`): write to the
 *   recipient's local inbox so the watcher picks it up directly.
 * - Remote recipient (no binding): write to ~/.tps/outbox/new/ so the
 *   branch service relays it over the wire to the appropriate host.
 *
 * Without this split, replies addressed to off-host agents (the cross-host
 * case) silently land in this host's local mail/<recipient>/new/ and
 * never reach the actual recipient.
 */
function deliverOutboundMail(
  cfg: any,
  accountId: string,
  mailDir: string,
  message: TpsMailBody,
): { path: string; route: "local" | "outbox" } {
  const localAgents = findBoundAgents(cfg, accountId);
  if (localAgents.includes(message.to)) {
    return { path: writeMailFile(mailDir, message.to, message), route: "local" };
  }
  return { path: writeOutboxFile(message), route: "outbox" };
}

/**
 * Sign a dispatcher reply as a v1 signed envelope, exactly like `tps mail
 * send` (packages/cli/src/commands/mail.ts `maybeSignEnvelopeBody`). Returns
 * the JSON-stringified signed envelope, or null when the agent has no
 * signing key (caller must warn and write nothing).
 */
function signReplyEnvelope(from: string, to: string, body: string): string | null {
  const privkey = readAgentPrivateKey(from);
  if (!privkey) return null;

  const now = new Date().toISOString();
  const chain: ChainEntry[] = [
    {
      agent: "system",
      kind: "human",
      timestamp: now,
      rationale: "tps-mail dispatcher reply (no inbound chain)",
      signature: null,
    },
    {
      agent: from,
      kind: "agent",
      timestamp: now,
      rationale: `agent ${from} dispatcher reply`,
      signature: null,
    },
  ];

  const envelope: Envelope = {
    v: 1,
    from,
    to,
    subject: `mail to ${to}`,
    body,
    messageId: randomUUID(),
    timestamp: now,
    delegationChain: chain,
  };

  return JSON.stringify(signEnvelope(envelope, { [from]: privkey }));
}

/**
 * Is `to` a local recipient? True when it has a maildir under `mailDir` on
 * this host, or when it is bound to this gateway. A LOCAL recipient's reply is
 * delivered to their maildir and never goes to ~/.tps/outbox (cli#338
 * requirement 3). A recipient that is neither is REMOTE: its reply goes to
 * ~/.tps/outbox/new/ for the branch service to relay, never dropped.
 */
function isLocalRecipient(
  mailDir: string,
  cfg: any,
  accountId: string,
  to: string,
): boolean {
  if (existsSync(resolve(mailDir, to))) return true;
  return findBoundAgents(cfg, accountId).includes(to);
}

/**
 * Patch a mail record in place. Used to ack/nack a message that the shared
 * promote() enforcement point has already moved new/ → cur/. The promotion
 * itself is atomic inside promote() (new/ → tmp/ → cur/); this only enriches
 * the cur/ record after dispatch, so a crash here cannot replay a message.
 */
function patchMailFile(path: string, patch: Partial<TpsMailBody>): void {
  try {
    const current = readMailFile(path);
    if (!current) return;
    writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
  } catch {
    // best effort — don't crash the watcher on state-transition errors
  }
}

/**
 * Resolve the sending agent id from the outbound context. Returns null if
 * the identity can't be determined — callers must fail-closed rather than
 * using a fallback like "unknown" that creates a shared session sink.
 */
function resolveOutboundSender(ctx: ChannelOutboundContext): string | null {
  const id =
    (ctx.identity as any)?.agentId ??
    (ctx.identity as any)?.from ??
    null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function buildEnvelope(msg: TpsMailBody): string {
  return [
    "[TPS Mail]",
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `ID: ${msg.id}`,
    `Timestamp: ${msg.timestamp}`,
    "",
    msg.body,
    "",
    "---",
    `Reply via: tps mail send ${msg.from} "<your response>"`,
  ].join("\n");
}

// ─── Channel Plugin ──────────────────────────────────────────────────────────

const config: ChannelConfigAdapter<TpsMailAccount> = {
  listAccountIds: (cfg: any) => {
    const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts;
    if (!accounts || typeof accounts !== "object") {
      // If no accounts configured at all, assume a single "default" account
      // pointing at ~/.tps/mail so the plugin is usable out of the box.
      return ["default"];
    }
    return Object.keys(accounts);
  },
  resolveAccount: (cfg: any, accountId?: string | null): TpsMailAccount => {
    const id = accountId ?? "default";
    const mailDir = resolveMailDir(cfg, id);
    const enabled = cfg?.channels?.[CHANNEL_ID]?.enabled !== false;
    return { accountId: id, mailDir, enabled };
  },
  defaultAccountId: () => "default",
  isEnabled: (account) => account.enabled,
  isConfigured: (account) => existsSync(account.mailDir),
  unconfiguredReason: (account) => `TPS mail directory does not exist: ${account.mailDir}`,
};

const outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async (ctx: ChannelOutboundContext) => {
    const sender = resolveOutboundSender(ctx);
    if (!sender) {
      return {
        ok: false,
        error: "tps-mail: outbound identity unknown — refusing to send anonymous mail",
      } as any;
    }

    const account = config.resolveAccount(ctx.cfg as any, ctx.accountId ?? "default");
    const now = new Date().toISOString();
    const message: TpsMailBody = {
      id: randomUUID(),
      from: sender,
      to: ctx.to,
      body: ctx.text,
      timestamp: now,
      replyToId: ctx.replyToId ?? undefined,
      headers: {
        "X-TPS-Trust": "agent",
        "X-TPS-Surface": CHANNEL_ID,
      },
      deliveryAttempts: 0,
    };
    const { path: filePath, route } = deliverOutboundMail(
      ctx.cfg as any,
      ctx.accountId ?? "default",
      account.mailDir,
      message,
    );
    return {
      ok: true,
      id: message.id,
      externalId: message.id,
      details: { path: filePath, route },
    } as any;
  },
};

const gateway: ChannelGatewayAdapter<TpsMailAccount> = {
  startAccount: async (ctx: ChannelGatewayContext<TpsMailAccount>) => {
    const { account, cfg, log } = ctx;
    const channelRuntime = (ctx as any).channelRuntime;

    if (!channelRuntime) {
      log?.warn?.(
        "tps-mail: channelRuntime not available — plugin requires SDK 2026.2.19+",
      );
      return;
    }

    if (!existsSync(account.mailDir)) {
      log?.warn?.(`tps-mail: mail directory does not exist: ${account.mailDir}`);
      return;
    }

    const boundAgents = findBoundAgents(cfg as any, account.accountId);
    if (boundAgents.length === 0) {
      log?.info?.(
        `tps-mail: no agents bound to channel ${CHANNEL_ID} account ${account.accountId}; idle`,
      );
      return;
    }

    log?.info?.(
      `tps-mail: watching ${boundAgents.length} agent inbox(es): ${boundAgents.join(", ")}`,
    );

    const watchers: FSWatcher[] = [];
    // seenFiles dedupes inotify events (fs.watch can fire multiple times per
    // write — see the debounce in the watcher callback). It is intentionally
    // NOT pre-populated from the existing new/ snapshot at startup: any file
    // already sitting in new/ when the gateway starts is mail that arrived
    // while the gateway was down (or that a previous turn never ack'd) and
    // MUST be processed on this startup, not silently swallowed.
    //
    // Replay safety comes from `moveToCur` after dispatch — successful turns
    // ack and move the file to cur/, failed dispatches nack and also move to
    // cur/, malformed files are moved to dlq/. None of these paths leave a
    // file in new/, so re-processing the same id twice is impossible across
    // restarts unless the gateway crashed mid-turn (acceptable: at-least-once
    // delivery is the contract).
    const seenFiles = new Set<string>();

    async function processNewFile(recipient: string, filePath: string): Promise<void> {
      if (seenFiles.has(filePath)) return;
      seenFiles.add(filePath);

      // ONE enforcement point, shared with the CLI: parse wrapper → envelope,
      // verify through an always-constructed Flair client, check recipient and
      // replay, and move new/ → cur/ (or dlq/ with a `.reason` sidecar). The
      // plugin carries no verification implementation of its own.
      const promoted = await promote(recipient, filePath);
      if (!promoted.ok) {
        log?.warn?.(
          `tps-mail: not promoted (${promoted.class}) for ${recipient}: ${promoted.reason}`,
        );
        return;
      }
      await deliverPromoted(recipient, promoted.message, promoted.path);
    }

    /**
     * Crash-recovery re-dispatch of a cur/ record, gated on proof-of-promotion
     * and re-verification. cur/ is a DESTINATION directory: presenting from it
     * would bypass the new/ → cur/ enforcement point unless the record proves it
     * came through promote() (envelopeId + stored signed envelope) and still
     * verifies. recoverPromoted() enforces that and quarantines anything that
     * cannot prove provenance; a Flair outage leaves the record in cur/ for the
     * next start.
     */
    async function recoverUnackedCurRecord(recipient: string, curPath: string, record: TpsMailBody): Promise<void> {
      try {
        const recovered = await recoverPromoted(recipient, curPath);
        if (!recovered.ok) {
          log?.warn?.(
            `tps-mail: cur/ recovery refused ${record.id} (${recovered.class}): ${recovered.reason}`,
          );
          return;
        }
        await deliverPromoted(recipient, recovered.message, curPath);
      } catch (err: any) {
        log?.warn?.(`tps-mail: cur/ recovery deferred for ${record.id}: ${err?.message ?? err}`);
      }
    }

    /**
     * Deliver an already-promoted (cur/) record.
     *
     * Shared by the new/ path (after promote()) and the startup recovery sweep
     * (after recoverPromoted() has re-established provenance and re-verified).
     * promote() moves a record to cur/ BEFORE dispatch, and ackedAt is written
     * only AFTER the turn returns; a gateway that exits in that window would
     * otherwise strand an unacked, undelivered record in cur/ forever, breaking
     * at-least-once.
     *
     * This does not re-enter promote(): the id is already consumed and promote()
     * would dead-letter it as a replay. The recovery path calls recoverPromoted()
     * for the re-check instead.
     */
    async function deliverPromoted(recipient: string, msg: TpsMailBody, curPath: string): Promise<void> {
      if (seenFiles.has(curPath)) return;
      seenFiles.add(curPath);

      log?.info?.(`tps-mail: delivering ${msg.id} from ${msg.from} to ${recipient}`);
      // Session key: one conversation per (channel, sender) pair.
      // Using `dmScope: "per-channel-peer"` isolates each tps-mail sender
      // into their own session, so conversations build context over time
      // without polluting the recipient's `main` session used by Discord
      // and cron jobs.
      //
      // IMPORTANT: buildAgentSessionKey takes `peer: { kind, id }` — not
      // `conversationId` / `chatType`. Without the correct params it
      // silently falls back to `agent:<recipient>:main`, which defeats the
      // whole point of having a separate channel and re-pollutes main.
      const sessionKey = channelRuntime.routing?.buildAgentSessionKey?.({
        agentId: recipient,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        peer: { kind: "direct", id: msg.from },
        dmScope: "per-channel-peer",
      }) ?? `agent:${recipient}:${CHANNEL_ID}:${account.accountId}:${msg.from}`;

      const envelope = buildEnvelope(msg);
      const rawMsgCtx: Record<string, any> = {
        BodyForAgent: envelope,
        RawBody: msg.body,
        Body: msg.body,
        CommandBody: msg.body,
        BodyForCommands: msg.body,
        SessionKey: sessionKey,
        From: msg.from,
        To: recipient,
        SenderId: msg.from,
        SenderName: msg.from,
        Surface: CHANNEL_ID,
        Provider: CHANNEL_ID,
        ChatType: "direct",
        MessageSid: msg.id,
        Timestamp: Date.parse(msg.timestamp) || Date.now(),
        AccountId: account.accountId,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: msg.from,
        ConversationLabel: `tps-mail:${msg.from}`,
      };

      // Promote MsgContext → FinalizedMsgContext so dispatch can run.
      // Falls back to the raw context with CommandAuthorized: false if the
      // runtime helper is missing (older SDK).
      const msgCtx = channelRuntime.reply?.finalizeInboundContext
        ? await channelRuntime.reply.finalizeInboundContext(rawMsgCtx)
        : { ...rawMsgCtx, CommandAuthorized: false };

      // One reply per inbound, at most (cli#338). The dispatcher's deliver
      // callback receives blocks in order; we emit only the FINAL message,
      // once. There is deliberately NO suppression by "the agent already sent
      // something": the dispatcher's final is ALWAYS posted and is the only
      // obligation-discharging post. (The CLI envelope carries no reply
      // reference today, so an explicit send cannot be told apart from a
      // progress note; suppression returns only as a later CLI slice.)
      let delivered = false;
      try {
        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg,
          dispatcherOptions: {
            deliver: async (payload: any, info: any) => {
              // Requirement 1: only the final message, once.
              if (info?.kind !== "final") return;
              if (delivered) return;

              const replyText: string =
                (typeof payload?.text === "string" ? payload.text : "") ||
                (Array.isArray(payload?.content)
                  ? payload.content
                      .filter((c: any) => c?.type === "text")
                      .map((c: any) => c?.text ?? "")
                      .join("\n")
                  : "") ||
                "";
              if (!replyText.trim()) return;

              // Requirement 4: sign the reply (Ed25519 + messageId).
              const signedBody = signReplyEnvelope(recipient, msg.from, replyText);
              if (!signedBody) {
                log?.warn?.(
                  `tps-mail: no signing key for ${recipient}; cannot sign dispatcher reply to ${msg.from}`,
                );
                return;
              }

              const reply: TpsMailBody = {
                id: randomUUID(),
                from: recipient,
                to: msg.from,
                body: signedBody,
                timestamp: new Date().toISOString(),
                replyToId: msg.id,
                headers: {
                  "X-TPS-Trust": "agent",
                  "X-TPS-Surface": CHANNEL_ID,
                  "X-TPS-InReplyTo": msg.id,
                },
                deliveryAttempts: 0,
              };

              // Requirement 3 + 5: a local recipient's reply goes to their
              // maildir; a REMOTE recipient's reply goes to ~/.tps/outbox/new/
              // for the branch service to relay — never dropped.
              if (isLocalRecipient(account.mailDir, cfg as any, ctx.accountId ?? "default", msg.from)) {
                writeMailFile(account.mailDir, msg.from, reply);
                delivered = true;
                log?.info?.(
                  `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=local)`,
                );
              } else {
                const path = writeOutboxFile(reply);
                delivered = true;
                log?.info?.(
                  `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=outbox: ${path})`,
                );
              }
            },
          },
        });

        // Turn completed — mark original as acked in cur/.
        patchMailFile(curPath, { ackedAt: new Date().toISOString(), read: true });
        log?.info?.(`tps-mail: acked ${msg.id}`);
      } catch (err: any) {
        log?.warn?.(
          `tps-mail: dispatch failed for ${msg.id}: ${err?.message ?? String(err)}`,
        );
        patchMailFile(curPath, {
          nackedAt: new Date().toISOString(),
          nackReason: `dispatch failed: ${err?.message ?? String(err)}`,
        });
      }
    }

    // Launch a watcher per agent inbox.
    for (const agentId of boundAgents) {
      const newDir = resolve(account.mailDir, agentId, "new");
      if (!existsSync(newDir)) {
        mkdirSync(newDir, { recursive: true });
      }
      try {
        const watcher = fsWatch(newDir, { persistent: true }, (_event, filename) => {
          if (!filename) return;
          const filePath = resolve(newDir, String(filename));
          if (!existsSync(filePath)) return;
          // Debounce: fs.watch can fire multiple events per file write.
          setTimeout(() => {
            processNewFile(agentId, filePath).catch((err) => {
              log?.warn?.(`tps-mail: processNewFile error: ${err?.message ?? err}`);
            });
          }, 50);
        });
        watchers.push(watcher);

        // Process any files already present (but not in seenFiles) in case
        // the gateway starts up after mail was already written.
        try {
          for (const filename of readdirSync(newDir)) {
            const filePath = resolve(newDir, filename);
            if (!seenFiles.has(filePath)) {
              void processNewFile(agentId, filePath);
            }
          }
        } catch { /* ignore */ }

        // Crash recovery (at-least-once): re-dispatch cur/ records that were
        // promoted but never acked/nacked. cur/ is a DESTINATION, so the record
        // must PROVE it came through promote() (envelopeId + stored signed
        // envelope) and re-verify before it may be presented — otherwise the
        // sweep would bypass the enforcement point simply by reading from the
        // other directory. recoverPromoted() enforces that and quarantines a
        // record that cannot prove provenance; a Flair outage defers to the next
        // start.
        const curDir = resolve(account.mailDir, agentId, "cur");
        try {
          if (existsSync(curDir)) {
            for (const filename of readdirSync(curDir)) {
              if (!filename.endsWith(".json")) continue;
              const curPath = resolve(curDir, filename);
              if (seenFiles.has(curPath)) continue;
              const record = readMailFile(curPath);
              if (!record || record.ackedAt || record.nackedAt) continue;
              void recoverUnackedCurRecord(agentId, curPath, record);
            }
          }
        } catch { /* ignore */ }

        // Reap stranded tmp/*.promote scratch from an interrupted promote (the
        // catch only runs on a thrown error, so a kill leaves orphans no other
        // sweep can see).
        try {
          await sweepStrandedPromoteScratch(resolve(account.mailDir, agentId));
        } catch { /* ignore */ }
      } catch (err: any) {
        log?.warn?.(
          `tps-mail: failed to watch ${newDir}: ${err?.message ?? String(err)}`,
        );
      }
    }

    // Keep the promise alive until the gateway signals shutdown. If we
    // return immediately after setting up watchers, the gateway interprets
    // it as "the account went down" and enters an auto-restart loop.
    //
    // We resolve the promise only when ctx.abortSignal fires. That's the
    // signal from the gateway that startAccount should terminate — at that
    // point we close watchers and return.
    await new Promise<void>((resolveShutdown) => {
      if (ctx.abortSignal?.aborted) {
        resolveShutdown();
        return;
      }
      ctx.abortSignal?.addEventListener(
        "abort",
        () => {
          for (const w of watchers) {
            try { w.close(); } catch { /* ignore */ }
          }
          log?.info?.("tps-mail: stopped all watchers");
          resolveShutdown();
        },
        { once: true },
      );
    });
  },

  stopAccount: async (ctx: ChannelGatewayContext<TpsMailAccount>) => {
    // Cleanup happens via abortSignal in startAccount. Nothing to do here.
    ctx.log?.info?.("tps-mail: stopAccount called");
  },
};

const tpsMailChannel: ChannelPlugin<TpsMailAccount> = {
  id: CHANNEL_ID as any,
  meta: {
    id: CHANNEL_ID as any,
    label: "TPS Mail",
    selectionLabel: "TPS Mail",
    blurb: "Inter-agent messaging via the local TPS mail filesystem queue",
    docsPath: "/docs/channels/tps-mail",
    order: 200,
  } as any,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    reply: true,
    edit: false,
    unsend: false,
    threads: false,
    nativeCommands: false,
  },
  defaults: {
    queue: { debounceMs: 50 },
  },
  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`, "bindings"],
  },
  config,
  outbound,
  gateway,
};

// ─── Plugin registration ─────────────────────────────────────────────────────

export default {
  register(api: OpenClawPluginApi) {
    try {
      (api as any).registerChannel({ plugin: tpsMailChannel });
      api.logger.info(`openclaw-tps-mail: registered channel "${CHANNEL_ID}"`);
    } catch (err: any) {
      api.logger.error(
        `openclaw-tps-mail: failed to register channel: ${err?.message ?? err}`,
      );
      throw err;
    }
  },
};
