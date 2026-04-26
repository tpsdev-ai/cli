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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
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

/**
 * Move a file from new/ to dlq/ (dead-letter queue) when it can't be parsed.
 *
 * Kern's 2026-04-09 review finding: without this, malformed files in new/
 * get added to `seenFiles` once, then readMailFile returns null, then
 * processNewFile returns early — but the file stays in new/ forever,
 * re-populated into seenFiles on every gateway restart. Silent garbage
 * accumulation.
 *
 * The fix: on parse failure, move the file to a sibling dlq/ folder so
 * it's out of the way for live processing but preserved for diagnosis.
 */
function moveToDlq(filePath: string, reason: string): void {
  try {
    const dlqDir = resolve(filePath, "..", "..", "dlq");
    if (!existsSync(dlqDir)) mkdirSync(dlqDir, { recursive: true });
    const name = basename(filePath);
    const target = resolve(dlqDir, name);
    // renameSync works across sibling directories on the same filesystem.
    renameSync(filePath, target);
    // Write a companion .reason file so operators know why it failed.
    writeFileSync(
      target + ".reason",
      `Moved to dlq by openclaw-tps-mail at ${new Date().toISOString()}\nReason: ${reason}\n`,
      "utf-8",
    );
  } catch {
    // best effort — don't crash the watcher on dlq move errors
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
 * Move a mail file from <inbox>/new/ to <inbox>/cur/ with the given state
 * patch applied (typically `ackedAt` on success or `nackedAt` on failure).
 *
 * Atomicity: uses renameSync to move the file from new/ → tmp/ first
 * (atomic on same filesystem), then writes the enriched version to cur/.
 * If the process crashes between rename and write, the file is in tmp/
 * (not new/), so it won't be re-processed on restart — preventing replay.
 * Sherlock's 2026-04-09 security review finding #5.
 *
 * Best-effort: the watcher should not crash if the filesystem transition
 * fails for some reason. Logs via caller.
 */
function moveToCur(filePath: string, patch: Partial<TpsMailBody>): void {
  try {
    const current = readMailFile(filePath);
    if (!current) return;
    const updated = { ...current, ...patch };

    const agentDir = resolve(filePath, "..", "..");
    const tmpDir = resolve(agentDir, "tmp");
    const curDir = resolve(agentDir, "cur");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    if (!existsSync(curDir)) mkdirSync(curDir, { recursive: true });

    const name = basename(filePath);
    const tmpPath = resolve(tmpDir, name);
    const curPath = resolve(curDir, name);

    // Step 1: atomic remove from new/ — prevents replay on crash.
    renameSync(filePath, tmpPath);
    // Step 2: write enriched version to cur/.
    writeFileSync(curPath, JSON.stringify(updated, null, 2), "utf-8");
    // Step 3: clean up tmp staging file.
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
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

      const msg = readMailFile(filePath);
      if (!msg) {
        // Malformed file — move to dlq/ so it doesn't accumulate in new/.
        // Kern's 2026-04-09 review finding: without this the file sits
        // permanently in new/, re-populated into seenFiles on every restart.
        log?.warn?.(
          `tps-mail: file in ${recipient}/new/ failed to parse; moving to dlq: ${basename(filePath)}`,
        );
        moveToDlq(filePath, "JSON parse failed or file was not a valid TPS mail envelope");
        return;
      }

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

      try {
        // NOTE on the deliver callback: in practice, openclaw agents using
        // tool-based replies (e.g., `tps mail send flint "..."`) write their
        // responses via their own tool calls rather than emitting through
        // the reply dispatcher. The deliver callback below handles the case
        // where an agent DOES emit output through the dispatcher — useful
        // for future agents that use the reply path instead of tools. For
        // tool-using agents (the current K&S / Anvil / Pulse pattern) the
        // deliver callback is a no-op and the reply still lands in the
        // recipient's inbox via the `tps mail send` tool path.
        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg,
          dispatcherOptions: {
            deliver: async (payload: any, _info: any) => {
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

              const reply: TpsMailBody = {
                id: randomUUID(),
                from: recipient,
                to: msg.from,
                body: replyText,
                timestamp: new Date().toISOString(),
                replyToId: msg.id,
                headers: {
                  "X-TPS-Trust": "agent",
                  "X-TPS-Surface": CHANNEL_ID,
                  "X-TPS-InReplyTo": msg.id,
                },
                deliveryAttempts: 0,
              };
              const { route } = deliverOutboundMail(
                cfg as any,
                ctx.accountId ?? "default",
                account.mailDir,
                reply,
              );
              log?.info?.(
                `tps-mail: reply ${reply.id} from ${recipient} to ${msg.from} (via dispatcher, route=${route})`,
              );
            },
          },
        });

        // Turn completed — mark original as acked and move to cur/
        moveToCur(filePath, { ackedAt: new Date().toISOString(), read: true });
        log?.info?.(`tps-mail: acked ${msg.id}`);
      } catch (err: any) {
        log?.warn?.(
          `tps-mail: dispatch failed for ${msg.id}: ${err?.message ?? String(err)}`,
        );
        moveToCur(filePath, {
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
