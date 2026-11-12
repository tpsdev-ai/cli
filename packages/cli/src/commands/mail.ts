import { isMailboxMessageFile, type FlairClient } from "@tpsdev-ai/agent";
import { mailRootForRecordPath, verifyMailAction, ackMessage, assertValidBody, checkMessages, countInboxMessages, gcMessages, getInbox, isPresentableCurRecord, LEASE_TIMEOUT_MS, listMessages, MAX_INBOX_MESSAGES, nackMessage, sendMessage, withholdUnverified, type MailMessage } from "../utils/mail.js";
import { deliverToSandbox, deliverToRemoteBranch, EXIT_DELIVERY_UNCONFIRMED, MailDeliveryUnconfirmedError, parseMailAckTimeoutMs, resolveMailAckTimeoutMs } from "../utils/relay.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { queryArchive } from "../utils/archive.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, watch } from "node:fs";
import { pidState, pidStateFromProbeError } from "@tpsdev-ai/agent";
import { loadHostIdentityId } from "../utils/identity.js";
import { queueOutboxMessage } from "../utils/outbox.js";
import { resolveMailRoute } from "../utils/mail-routing.js";
import { parseTaskEnvelope, formatTaskEnvelope, createTaskEnvelope } from "../utils/task-envelope.js";
import { parseInboundChain } from "../utils/agent-keys.js";
import { assertValidReplyToId, requireOutboundSigningKey, signOutboundBody } from "../utils/mail-sign.js";
import { readStdinBodySync, EmptyStdinError, StdinTooLargeError } from "../utils/stdin-body.js";
import { isValidEnvelopeId, ENVELOPE_ID_SHAPE_TEXT } from "../utils/envelope-id.js";
import { removePidFile, pidRecordBytesEqual, snapshotPidRecord, type PidFileState, type PidRecordSnapshot } from "../utils/pid-file.js";
import { readSentEnvelope, storeSentEnvelope } from "../utils/sent-envelope.js";
import { isValidMailDeliveryId } from "../utils/wire-mail.js";
import * as ed from "@noble/ed25519";

/** The signal sender for `mail relay stop`; replaceable in tests so they can
 *  assert that a stale or unverifiable pid file sends nothing. */
type RelayStopSignal = (pid: number) => void;
let sendRelayStopSignal: RelayStopSignal = (pid) => process.kill(pid, "SIGTERM");

export function setRelayStopSignal(fn: RelayStopSignal): RelayStopSignal {
  const previous = sendRelayStopSignal;
  sendRelayStopSignal = fn;
  return previous;
}

/** The pid-record reader for `mail relay stop`; replaceable in tests so a record
 *  can change between the first read and the read taken before the signal. */
type RelayStopRecordReader = () => PidRecordSnapshot;
let relayStopRecordReader: RelayStopRecordReader | null = null;

export function setRelayStopRecordReader(fn: RelayStopRecordReader | null): RelayStopRecordReader | null {
  const previous = relayStopRecordReader;
  relayStopRecordReader = fn;
  return previous;
}

/** The pid-file remover for `mail relay stop`; replaceable in tests so the
 *  removal-failure branch can be exercised without a filesystem that refuses unlink. */
type RelayPidRemoval = (path: string) => "removed" | "already gone";
let removeRelayPidFile: RelayPidRemoval = removePidFile;

export function setRelayPidRemoval(fn: RelayPidRemoval): RelayPidRemoval {
  const previous = removeRelayPidFile;
  removeRelayPidFile = fn;
  return previous;
}

/** True when `kill(pid, 0)` was refused with an error pidState calls alive. */
function relayProbeRefused(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return pidStateFromProbeError(error) === "alive";
  }
}

/** Wait for a signalled relay to exit, polling for up to about 5 s. */
async function waitForRelayExit(pid: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (pidState(pid) === "gone") return true;
    // A probe refused with EPERM keeps returning "alive"; stop waiting and
    // report rather than polling until the deadline.
    if (relayProbeRefused(pid)) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pidState(pid) === "gone";
}

/**
 * cli#429: what `tps mail send --json` prints — delivery METADATA only, the
 * same shape on every route: never the body (which may have come from
 * `--stdin`) and never the signed envelope that carries it. `messageId` is the
 * signed envelope's id (the id a reply threads on); `id` and `timestamp` are
 * the local record's, present only where this process wrote one.
 */
function sendReceiptJson(
  route: "local" | "outbox" | "remote-branch" | "bridge",
  signedBody: string,
  fields: Record<string, unknown>,
): string {
  let env: { messageId?: unknown; replyToId?: unknown; timestamp?: unknown } = {};
  try {
    env = JSON.parse(signedBody);
  } catch {
    /* the body was signed above; unreachable */
  }
  return JSON.stringify({
    ...fields,
    route,
    messageId: env.messageId,
    ...(typeof env.replyToId === "string" ? { replyToId: env.replyToId } : {}),
    signedAt: env.timestamp,
  });
}

/** The signed envelope's messageId, which this path also uses as the wire
 *  delivery id, so a caller's `--message-id` re-send reuses the id. */
function signedMessageId(signedBody: string): string | undefined {
  try {
    const env = JSON.parse(signedBody) as { messageId?: unknown };
    return typeof env.messageId === "string" ? env.messageId : undefined;
  } catch {
    return undefined;
  }
}

/** The signed envelope's timestamp, which is the wire `timestamp` the branch
 *  records and compares, so a re-send of the SAME signed envelope matches. */
function signedMessageTimestamp(signedBody: string): string | undefined {
  try {
    const env = JSON.parse(signedBody) as { timestamp?: unknown };
    return typeof env.timestamp === "string" ? env.timestamp : undefined;
  } catch {
    return undefined;
  }
}

interface MailArgs {
  action: "send" | "check" | "list" | "stats" | "log" | "read" | "watch" | "search" | "relay" | "topic" | "subscribe" | "unsubscribe" | "publish" | "ack" | "nack" | "gc";
  agent?: string;
  message?: string;
  // Task envelope flags
  task?: string;
  taskId?: string;
  title?: string;
  spec?: string;
  branch?: string;
  priority?: string;
  output?: string;
  taskContext?: string;
  messageId?: string;
  /** cli#429: read the message body from stdin (fd 0) instead of argv. */
  stdin?: boolean;
  /** cli#962: how long to wait for the branch's delivery ACK, in milliseconds. */
  ackTimeout?: string;
  /** cli#429: the signed messageId this message replies to. */
  replyTo?: string;
  /**
   * cli#429: the envelope `messageId` to sign this message with, instead of a
   * fresh UUID. A sender that must RE-SEND a message whose first attempt had an
   * unknown outcome passes the same id, so a recipient's replay gate discards
   * a second copy. Held to the one id rule (envelope-id.ts).
   */
  sendMessageId?: string;
  /**
   * cli#429: `--unsigned` is NOT supported — every send is signed. The flag is
   * still parsed so that passing it is REFUSED by name (exit 1, nothing
   * written) instead of being silently ignored.
   */
  unsigned?: boolean;
  json?: boolean;
  count?: boolean;
  since?: string;
  limit?: number;
  desc?: string;
  from?: string;
  fromBeginning?: boolean;
  topicAction?: string;
  reason?: string;
  type?: "transient" | "agent" | "permanent";
  retryAfter?: string;
  maxAge?: string;
  pr?: number;
  status?: "new" | "processing" | "done" | "failed" | "all";
  // mail watch flags
  hook?: string[];
  interval?: number | string;
  daemon?: string;
}

// Warn threshold as a fraction of the cap. 80% leaves ~20 messages of runway —
// enough that a reader who acts on the warning drains before anything bounces,
// while staying quiet for the normal case of a few unread.
const INBOX_WARN_RATIO = 0.8;

/**
 * Print a back-pressure warning when the agent's own inbox is filling up.
 *
 * Deliberately best-effort and never throwing: this is advisory output on a
 * read-only command, so a missing or unreadable maildir must not turn `mail
 * log` into a failure.
 */
function warnIfInboxDeep(agent: string): void {
  try {
    const depth = countInboxMessages(agent);
    const threshold = Math.floor(MAX_INBOX_MESSAGES * INBOX_WARN_RATIO);
    if (depth < threshold) return;
    const atCap = depth >= MAX_INBOX_MESSAGES;
    console.warn(
      atCap
        ? `\n⚠️  ${agent}: ${depth}/${MAX_INBOX_MESSAGES} unprocessed — INBOX IS FULL. Incoming mail is being REJECTED right now. Run \`tps mail check ${agent}\` to drain it.`
        : `\n⚠️  ${agent}: ${depth}/${MAX_INBOX_MESSAGES} unprocessed. At the cap, incoming mail is rejected. Run \`tps mail check ${agent}\` to drain it — this command does not consume.`,
    );
  } catch {
    // Advisory only — never let the warning break the command it rides on.
  }
}

async function resolveAgentId(override?: string): Promise<string> {
  // Fast path: explicit override or env var — no vault I/O needed
  if (override) {
    const safe = sanitizeIdentifier(override);
    if (safe !== override) {
      console.error(`Invalid agent id: ${override}`);
      process.exit(1);
    }
    return override;
  }
  if (process.env.TPS_AGENT_ID) return process.env.TPS_AGENT_ID;

  // Check host.json on disk before touching the vault (vault decrypt is expensive)
  const hostJsonPath = join(process.env.HOME || homedir(), ".tps", "identity", "host.json");
  if (existsSync(hostJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hostJsonPath, "utf-8"));
      if (parsed?.hostId) return String(parsed.hostId);
    } catch { /* fall through */ }
  }

  // Fallback: full vault resolution (may be slow if vault file present + TPS_VAULT_KEY unset)
  const id = await loadHostIdentityId() || "unknown";
  const safe = sanitizeIdentifier(id);
  if (safe !== id) {
    console.error(`Invalid agent id: ${id}`);
    process.exit(1);
  }
  return id;
}

function validateAgent(agent?: string): string {
  if (!agent) {
    console.error("Agent id is required.");
    process.exit(1);
  }
  const safe = sanitizeIdentifier(agent);
  if (safe !== agent) {
    console.error(`Invalid agent id: ${agent}`);
    process.exit(1);
  }
  return agent;
}

// Sign the outbound body, or FAIL.
//
// cli#429: `tps mail send` never sends unsigned. With no usable key the send
// exits NON-ZERO, the error names the key path(s) it looked at (or the path of
// a key it could not read or parse) and the remedy, and NOTHING is written to
// any outbox or maildir — because this runs BEFORE every delivery path
// (branch-mode outbox, remote-branch, branch-office bridge, direct maildir).
// There is no unsigned opt-in.
//
// The envelope builder itself lives in utils/mail-sign.ts (shared with the
// agent runtimes) so the two cannot drift; it validates --reply-to (the ONE
// id rule) before it reads any key.
// The verify client for a stored envelope: the sender's CURRENT key only.
// Earlier delegation hops are not resolved — the fresh send never verified
// them, and the sender's outer signature covers every byte of the chain.
async function storedEnvelopeVerifyClient(from: string, seed: Buffer): Promise<FlairClient> {
  const senderKey = Buffer.from(await ed.getPublicKeyAsync(new Uint8Array(seed)));
  return {
    async getAgent(name: string) {
      return name === from ? { publicKey: senderKey } : null;
    },
  };
}

async function signOutboundOrFail(
  from: string,
  to: string,
  body: string,
  opts: { replyToId?: string; messageId?: string },
): Promise<{ signed: string; reusedStoredEnvelope: boolean }> {
  try {
    if (opts.messageId !== undefined && !isValidEnvelopeId(opts.messageId)) {
      throw new Error(`invalid --message-id: must be ${ENVELOPE_ID_SHAPE_TEXT}`);
    }
    // A re-send runs the same --reply-to validation and the same sender-key
    // resolution as a fresh send BEFORE it consults the store, so a missing,
    // unreadable, corrupt or conflicting key is refused here, not after a hit.
    if (opts.replyToId !== undefined) assertValidReplyToId(opts.replyToId);
    const mailRoot = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
    // The inbound delegation chain this invocation would embed on a fresh send.
    const priorChain = parseInboundChain(process.env.TPS_INBOUND_CHAIN_JSON);
    // A re-send of an explicit id reuses the signed envelope stored for it:
    // signing again would change its timestamp and signature, and the branch
    // treats a same-id payload mismatch as a conflict, not a duplicate. The
    // stored bytes must match this message, carry the same inbound chain, and
    // verify with the CURRENT key.
    let client: FlairClient | undefined;
    let signed: string | undefined;
    if (opts.messageId !== undefined) {
      client = await storedEnvelopeVerifyClient(from, requireOutboundSigningKey(from));
      signed = await readSentEnvelope(mailRoot, opts.messageId, { from, to, body, replyToId: opts.replyToId, priorChain }, client);
    }
    const reusedStoredEnvelope = signed !== undefined;
    if (signed === undefined) {
      signed = signOutboundBody(from, to, body, {
        requireKey: true,
        replyToId: opts.replyToId,
        messageId: opts.messageId,
        rationale: process.env.TPS_CHAIN_RATIONALE ?? `agent ${from} tps mail send`,
        priorChain,
      });
    }
    // cli#429: every route limits the SIGNED envelope (the body plus its
    // signature, chain and envelope fields) to MAX_BODY_BYTES, not the
    // plaintext — so check it HERE, before any route, and refuse by name. A body
    // just under the limit passes the plaintext check (e.g. --stdin) and would
    // otherwise fail later, with a different error, inside a route. The check
    // runs BEFORE the store: an oversized envelope must not reserve its id when
    // the refusal says nothing was written.
    try {
      assertValidBody(signed);
    } catch (err) {
      throw new Error(
        `the signed message is too large to send: ${(err as Error).message} The limit covers the signed envelope — ` +
          `the body plus its signature, delegation chain and envelope fields — so shorten the body. Nothing was written.`,
      );
    }
    return { signed, reusedStoredEnvelope };
  } catch (err) {
    console.error(`Refusing to send: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** Store a signed envelope under an explicit `--message-id` once its route has
 *  accepted the send, and return the stored bytes. The store used to run while
 *  the message was signed, before the route resolved, so a send the route then
 *  refused left a signed envelope (body included) under `.sent-envelopes/`
 *  while the refusal said nothing was written. Another send of the same id may
 *  have won the write, so every route sends the envelope the store holds. */
async function storeExplicitSignedEnvelope(
  from: string,
  to: string,
  body: string,
  replyToId: string | undefined,
  messageId: string,
  signed: string,
): Promise<string> {
  const mailRoot = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  const client = await storedEnvelopeVerifyClient(from, requireOutboundSigningKey(from));
  const priorChain = parseInboundChain(process.env.TPS_INBOUND_CHAIN_JSON);
  return storeSentEnvelope(mailRoot, messageId, signed, { from, to, body, replyToId, priorChain }, client);
}

/** Store the signed envelope of a REMOTE send that generated its own id. The
 *  exit-75 message prints that id and tells the sender to re-send with it; only
 *  the stored bytes make that retry the same signed message (same id, timestamp
 *  and payload) the branch can accept as a duplicate. */
async function storeGeneratedSignedEnvelope(
  from: string,
  to: string,
  body: string,
  replyToId: string | undefined,
  signed: string,
): Promise<void> {
  const messageId = signedMessageId(signed);
  if (messageId === undefined) throw new Error("the signed message has no envelope id");
  const mailRoot = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
  const client = await storedEnvelopeVerifyClient(from, requireOutboundSigningKey(from));
  const priorChain = parseInboundChain(process.env.TPS_INBOUND_CHAIN_JSON);
  await storeSentEnvelope(mailRoot, messageId, signed, { from, to, body, replyToId, priorChain }, client);
}

function newestJsonMtime(dir: string, fresh = false): string | null {
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((file) => fresh ? isMailboxMessageFile(file) : file.endsWith(".json"))
    .map((file) => join(dir, file))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return newest ? statSync(newest).mtime.toISOString() : null;
}

export async function runMail(args: MailArgs): Promise<void> {
  switch (args.action) {
    case "send": {
      // cli#429: there is no unsigned send. Refuse the flag by name — alone or
      // combined with --reply-to/--stdin — before any input is read or any
      // route is touched, so nothing is written.
      if (args.unsigned) {
        console.error(
          "Refusing to send: --unsigned is not supported — `tps mail send` always signs. " +
            "Provision the sender's Ed25519 key (~/.flair/keys/<id>.key or ~/.tps/identity/<id>.key).",
        );
        process.exit(1);
      }
      const to = validateAgent(args.agent);

      // cli#962: the ACK wait is a positive number of milliseconds. Refuse a bad
      // flag before any input is read; a bad env var is refused when the remote
      // route needs it.
      if (args.ackTimeout !== undefined) {
        try {
          parseMailAckTimeoutMs(args.ackTimeout, "--ack-timeout");
        } catch (err) {
          console.error(`Refusing to send: ${(err as Error).message}`);
          process.exit(1);
        }
      }

      // Build the message body. Three sources, mutually exclusive (cli#429):
      //   --stdin   read the body from fd 0
      //   --task    construct a task envelope
      //   positional message from argv (the historical path)
      let messageBody: string;
      if (args.stdin) {
        if (args.task) {
          console.error("Refusing to send: --stdin cannot be combined with --task.");
          process.exit(1);
        }
        if (args.message && args.message.trim() !== "") {
          console.error("Refusing to send: --stdin cannot be combined with a positional message.");
          process.exit(1);
        }
        try {
          messageBody = readStdinBodySync();
        } catch (err) {
          if (err instanceof EmptyStdinError || err instanceof StdinTooLargeError) {
            console.error(`Refusing to send: ${err.message}.`);
          } else {
            console.error(`Failed to read the message body from stdin: ${(err as Error).message}`);
          }
          process.exit(1);
        }
      } else if (args.task) {
        try {
          messageBody = createTaskEnvelope(`task.${args.task}`, {
            taskId: args.taskId,
            title: args.title,
            spec: args.spec,
            branch: args.branch,
            priority: args.priority,
            output: args.output,
            context: args.taskContext,
          });
        } catch (err) {
          console.error(`Task envelope error: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        if (!args.message) {
          console.error("Usage: tps mail send <agent> <message>  (or --stdin)");
          process.exit(1);
        }
        messageBody = args.message;
      }

      const from = await resolveAgentId();

      // Sign BEFORE route dispatch so all four delivery paths
      // (branch-mode outbox, remote-branch, branch-office bridge, direct maildir)
      // ship signed bodies, and so a send that cannot sign fails with nothing
      // written. cli#429.
      const signedSend = await signOutboundOrFail(from, to, messageBody, {
        replyToId: args.replyTo,
        messageId: args.sendMessageId,
      });
      args.message = signedSend.signed;
      // An explicit `--message-id` is stored only once a route has accepted the
      // send: a refusal must write nothing.
      const explicitStorePending = !signedSend.reusedStoredEnvelope && args.sendMessageId !== undefined;
      const storeExplicitForRoute = async (): Promise<void> => {
        if (!explicitStorePending || args.sendMessageId === undefined || args.message === undefined) return;
        try {
          args.message = await storeExplicitSignedEnvelope(
            from,
            to,
            messageBody,
            args.replyTo,
            args.sendMessageId,
            args.message,
          );
        } catch (err) {
          console.error(`Refusing to send: ${(err as Error).message}`);
          process.exit(1);
        }
      };

      // (cli#389) ONE locality decision, shared with the openclaw-tps-mail
      // plugin so the two cannot drift: `resolveMailRoute` owns the
      // branch/office + GAL rules. The CLI has no OpenClaw bindings, so it
      // passes none — on a branch every recipient is relayed through the
      // outbox, exactly as before.
      const mailRoot = process.env.TPS_MAIL_DIR || join(process.env.HOME || homedir(), ".tps", "mail");
      const route = resolveMailRoute({ to, mailDir: mailRoot, localAgents: [] });

      // Branch mode: queue outbound to be picked up by host on next connect.
      if (route.kind === "outbox") {
        assertValidBody(args.message);
        await storeExplicitForRoute();
        queueOutboxMessage(to, args.message, from);
        if (args.json) {
          console.log(sendReceiptJson("outbox", args.message, { status: "queued", to, from, queue: "outbox" }));
        } else {
          console.log("Queued for delivery to host.");
        }
        return;
      }

      // A recipient registered for remote delivery (GAL entry + remote.json).
      if (route.kind === "remote-branch") {
        assertValidBody(args.message);
        let ackTimeoutMs: number;
        try {
          ackTimeoutMs = resolveMailAckTimeoutMs(process.env, args.ackTimeout);
        } catch (err) {
          console.error(`Refusing to send: ${(err as Error).message}`);
          process.exit(1);
        }
        const wireId = signedMessageId(args.message);
        if (wireId !== undefined && !isValidMailDeliveryId(wireId)) {
          console.error(
            `Refusing to send: --message-id "${wireId}" cannot be delivered to a remote branch; ` +
              `the wire delivery id must be a UUID or a 64-character lowercase hex id.`,
          );
          process.exit(1);
        }
        // A generated id is printed in the unconfirmed message too, so store
        // its signed envelope before the delivery that can print it. An
        // explicit id is stored at the same point, after the wire-id refusal.
        try {
          if (explicitStorePending) await storeExplicitForRoute();
          else if (args.sendMessageId === undefined) {
            await storeGeneratedSignedEnvelope(from, to, messageBody, args.replyTo, args.message);
          }
        } catch (err) {
          console.error(`Refusing to send: ${(err as Error).message}`);
          process.exit(1);
        }
        try {
          await deliverToRemoteBranch(
            route.branchId,
            { id: wireId, to, from, body: args.message, timestamp: signedMessageTimestamp(args.message) },
            { ackTimeoutMs, reSignedExplicitId: explicitStorePending },
          );
        } catch (err) {
          if (err instanceof MailDeliveryUnconfirmedError) {
            console.error(err.message);
            process.exitCode = EXIT_DELIVERY_UNCONFIRMED;
            return;
          }
          throw err;
        }
        if (args.json) {
          console.log(
            sendReceiptJson("remote-branch", args.message, {
              status: "sent",
              to,
              from,
              transport: "remote",
              resolvedBranch: route.branchId,
            }),
          );
        } else {
          const resolvedNote = route.branchId !== to ? ` (via GAL: ${route.branchId})` : "";
          console.log(`Mail delivered to remote branch '${to}'${resolvedNote}.`);
        }
        return;
      }

      // A local branch-office sandbox (an inbox with no remote.json) → the
      // CLI's own bridge, shared with the plugin (cli#389).
      if (route.kind === "bridge") {
        assertValidBody(args.message);
        await storeExplicitForRoute();
        deliverToSandbox(route.branchId, {
          to,
          from,
          body: args.message,
        });
        if (args.json) {
          console.log(sendReceiptJson("bridge", args.message, { status: "sent", to, from, bridge: "branch-office" }));
        } else {
          console.log(`Message sent to branch office ${to}`);
        }
        return;
      }

      // A GAL entry naming a branch with NO remote registration is a
      // misconfiguration: refuse with the SAME named failure the plugin uses,
      // whatever maildirs exist — never a fall-through to the local maildir.
      if (route.kind === "failed") {
        console.error(
          `Refusing to send to '${to}': ${route.reason} — the GAL names branch '${route.branchId}' but it has no remote registration ` +
            `(~/.tps/branch-office/${route.branchId}/remote.json). Fix the GAL entry or register the branch.`,
        );
        process.exit(1);
      }

      // (cli#389 round 13) An UNKNOWN recipient — no binding, no GAL entry, no
      // maildir, no branch-office bridge — is a NAMED failure on the CLI too,
      // exactly as the shared rule and the plugin treat it. Falling through to
      // `sendMessage` created `~/.tps/mail/<to>/new/` for a name nothing reads
      // and exited 0, so a typo became silent loss — and the directory it
      // created then reclassified that name as local on the next decision.
      if (route.kind === "unknown") {
        console.error(
          `Refusing to send to '${to}': no route — '${to}' is not a local agent and not in the GAL. ` +
            `Create the agent first, or add it to the GAL; nothing was written.`,
        );
        process.exit(1);
      }

      // Direct Maildir send: args.message was already signed by
      // signOutboundOrFail above; `route.kind === "local"`, or the CLI's
      // fallback for an office recipient with no maildir yet.
      await storeExplicitForRoute();
      const msg = sendMessage(to, args.message, from);
      if (args.json) {
        // Metadata only (cli#429): `sendMessage` returns the whole record, whose
        // body is the signed envelope carrying the plaintext — never print it.
        console.log(
          sendReceiptJson("local", args.message, { status: "sent", to, from, id: msg.id, timestamp: msg.timestamp }),
        );
      } else {
        console.log(`Message sent to ${to} (${msg.id})`);
      }
      return;
    }

    case "check": {
      const agent = await resolveAgentId(args.agent);
      const messages = await checkMessages(agent);
      if (args.json) {
        console.log(JSON.stringify(messages, null, 2));
      } else if (messages.length === 0) {
        console.log("No new messages.");
      } else {
        for (const m of messages) {
          console.log(`📬 ${m.from} → ${m.to}  ${m.timestamp}`);
          if (m.redelivered) {
            const minutes = Math.round(LEASE_TIMEOUT_MS / 60_000);
            const remedy = m.trustTier === "external"
              ? "external-tier mail: the ack and nack commands refuse it"
              : `ack it with: tps mail ack ${m.id} --agent ${agent}`;
            console.log(`[re-delivered: not acked within ${minutes} min — ${remedy}]`);
          }
          if (m.replyToId) console.log(`↳ reply-to: ${m.replyToId}`);
          const taskEnv = parseTaskEnvelope(m.body);
          console.log(taskEnv ? formatTaskEnvelope(taskEnv) : m.body);
          console.log("---");
        }
      }
      return;
    }

    case "list": {
      const agent = await resolveAgentId(args.agent);
      let messages = (await listMessages(agent))
        .sort((a, b) => Date.parse(b.receivedAt ?? b.timestamp) - Date.parse(a.receivedAt ?? a.timestamp));
      if (args.status && args.status !== "all") {
        messages = messages.filter((m) => {
          if (args.status === "new") return !m.read && !m.checkedOutAt && !m.nackedAt;
          if (args.status === "processing") return !m.read && !!m.checkedOutAt && !m.nackedAt;
          if (args.status === "done") return !!m.ackedAt;
          if (args.status === "failed") return !!m.nackedAt;
          return true;
        });
      }
      if (args.count) {
        console.log(messages.length);
      } else if (args.json) {
        // listMessages has already withheld every unverified record — new/
        // (unverified), dlq/ (quarantined) and any cur/ record that cannot
        // re-verify — body, thread fields and headers (withholdUnverified,
        // cli#429).
        console.log(JSON.stringify(messages, null, 2));
      } else {
        const limit = Math.max(0, Math.floor(args.limit ?? 20));
        const visible = messages.slice(0, limit);
        if (visible.length === 0) {
          console.log("No messages.");
        } else {
          for (const m of visible) {
            const id8 = `[${m.id.slice(0, 8)}]`;
            if (m.location === "new") {
              // Unverified: that it exists and who it claims to be from, but never
              // its body — `new/` is not mail.
              console.log(`⏳ [pending verify] ${id8} ${m.from} → ${m.to}  ${m.timestamp}`);
              continue;
            }
            if (m.location === "dlq") {
              console.log(`⛔ [dlq${m.rejectClass ? `: ${m.rejectClass}` : ""}] ${id8} ${m.from} → ${m.to}  ${m.timestamp}`);
              if (m.rejectReason) {
                for (const line of m.rejectReason.split("\n")) console.log(`    ${line}`);
              }
              continue;
            }
            const marker = m.read ? "📖" : "📬";
            const taskEnv = parseTaskEnvelope(m.body);
            const summary = taskEnv
              ? `  ${formatTaskEnvelope(taskEnv)}`
              : m.body
                ? `  ${m.body.slice(0, 60)}${m.body.length > 60 ? "…" : ""}`
                : "";
            const replyMarker = m.replyToId ? `  ↳ reply-to: ${m.replyToId}` : "";
            console.log(`${marker} ${id8} ${m.from} → ${m.to}  ${m.timestamp}${replyMarker}${summary}`);
          }
        }
      }
      return;
    }

    case "stats": {
      const agent = await resolveAgentId(args.agent);
      const inbox = getInbox(agent);
      const sentDir = join(inbox.root, "sent");
      const payload = {
        agent,
        inboxCount: readdirSync(inbox.fresh).filter(isMailboxMessageFile).length,
        lastReceived: newestJsonMtime(inbox.fresh, true),
        lastSent: newestJsonMtime(sentDir),
      };
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Agent: ${payload.agent}`);
        console.log(`Inbox count: ${payload.inboxCount}`);
        console.log(`Last received: ${payload.lastReceived ?? "never"}`);
        console.log(`Last sent: ${payload.lastSent ?? "never"}`);
      }
      return;
    }

    case "read": {
      const agent = await resolveAgentId(args.agent);
      const id = args.messageId;
      if (!id) {
        console.error("Usage: tps mail read <agent> <message-id>");
        process.exit(1);
      }
      const inbox = getInbox(agent);
      const dirs: Array<[string, "new" | "cur"]> = [[inbox.fresh, "new"], [inbox.cur, "cur"]];
      let found: MailMessage | null = null;
      let foundLoc: "new" | "cur" = "cur";
      let foundPath = "";
      for (const [dir, loc] of dirs) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir).filter(f => loc === "new" ? isMailboxMessageFile(f) : f.endsWith(".json"));
        for (const f of files) {
          try {
            const msg = JSON.parse(readFileSync(join(dir, f), "utf-8")) as MailMessage;
            if (msg.id === id || msg.id.startsWith(id)) { found = msg; foundLoc = loc; foundPath = join(dir, f); break; }
          } catch { /* skip corrupt files */ }
        }
        if (found) break;
      }
      if (!found) {
        console.error(`Message not found: ${id}`);
        process.exit(1);
      }
      // A `cur/` record is only presentable with verified provenance; one that
      // cannot prove (and re-verify) its promotion is withheld, exactly like new/.
      const unverified = foundLoc === "new" || !(await isPresentableCurRecord(agent, found, mailRootForRecordPath(foundPath)));
      if (args.json) {
        // Unverified: body, thread fields and headers withheld (withholdUnverified, cli#429).
        const out = unverified ? withholdUnverified(found) : found;
        console.log(JSON.stringify(out, null, 2));
      } else {
        if (unverified) {
          // New/cur content without a verified envelope — never present its
          // body, thread or headers: the same redaction as the JSON view.
          const shown = withholdUnverified(found);
          console.log(`⏳ [pending verify] ${shown.from} → ${shown.to}  ${shown.timestamp}`);
          console.log(`ID: ${shown.id}`);
          console.log("(body withheld until the envelope is verified)");
          return;
        }
        const marker = found.read ? "📖" : "📬";
        console.log(`${marker} ${found.from} → ${found.to}  ${found.timestamp}`);
        console.log(`ID: ${found.id}`);
        if (found.replyToId) console.log(`Reply-to: ${found.replyToId}`);
        const taskEnv = parseTaskEnvelope(found.body);
        if (taskEnv) {
          console.log(`Task: ${formatTaskEnvelope(taskEnv)}`);
        }
        console.log("---");
        console.log(found.body);
      }
      return;
    }

    case "watch": {
      const agent = await resolveAgentId(args.agent);
      const { runMailWatch } = await import("./mail-watch.js");
      console.log(`Watching ${agent} inbox... (Ctrl-C to stop)`);
      await runMailWatch({
        agent,
        hook: args.hook,
        interval: args.interval ? Number(args.interval) : undefined,
        json: args.json,
        daemon: args.daemon,
      });
      // runMailWatch keeps alive until SIGINT/SIGTERM
      await new Promise<void>((resolve) => {
        const stop = () => { resolve(); };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      return;
    }

    case "log": {
      const events = queryArchive({
        agent: args.agent,
        since: args.since,
        limit: args.limit || 20,
      });
      if (args.json) {
        console.log(JSON.stringify(events, null, 2));
      } else if (events.length === 0) {
        console.log("No archive entries.");
      } else {
        for (const e of events) {
          const icon = e.event === "sent" ? "📤" : e.event === "read" ? "📬" : "📋";
          const preview = e.bodyPreview ? ` — ${e.bodyPreview}` : "";
          const reply = e.replyToId ? `  ↳ reply-to: ${e.replyToId}` : "";
          console.log(`${icon} [${e.event}] ${e.from} → ${e.to} @ ${e.timestamp}${reply}${preview}`);
        }
      }
      // Back-pressure is aimed at the recipient but the "Inbox full" throw only
      // ever reaches the sender. `log` is read-only — it does NOT consume — so
      // an agent that reads its mail this way can sit at the cap indefinitely,
      // bouncing every inbound message, and see nothing wrong. Surfacing depth
      // here puts the warning in front of the one party who can clear it, on
      // the command they actually run. (Not printed under --json: that output
      // is parsed by callers.)
      if (!args.json) warnIfInboxDeep(await resolveAgentId(args.agent));
      return;
    }

    case "relay": {
      const relayAction = args.agent ?? "status"; // relay start|stop|status
      const { readRelayPidFile, relayPidPath, runRelayDaemon } = await import("../utils/mail-relay.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const mailDir = join(homedir(), ".tps", "mail");

      if (relayAction === "status") {
        // Read-only: unverified, stale, invalid and unreadable states name the pid file.
        const state = readRelayPidFile();
        if (state.kind === "running") {
          console.log(`Mail relay running: pid=${state.pid}`);
        } else if (state.kind === "unverified") {
          console.log(`Mail relay unverified: pid=${state.pid}, pid file ${state.path}.`);
        } else if (state.kind === "stale") {
          console.log(`Mail relay: unknown (stale pid file ${state.path}).`);
        } else if (state.kind === "invalid") {
          console.log(`Mail relay: unknown (invalid pid file ${state.path}).`);
        } else if (state.kind === "unreadable") {
          console.log(`Mail relay state unknown: pid file ${state.path} could not be read.`);
        } else {
          console.log("Mail relay is not running.");
        }
        break;
      }

      if (relayAction === "stop") {
        const readStopRecord = (): PidRecordSnapshot =>
          relayStopRecordReader?.() ?? snapshotPidRecord(relayPidPath());
        const classification = readStopRecord();
        const state = classification.state;
        // A removal failure keeps the relay pid file, reports the path and the
        // error code, and exits non-zero.
        const removeRelayPid = (path: string): "removed" | "already gone" => {
          try {
            return removeRelayPidFile(path);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "unknown";
            throw new Error(`Mail relay pid file ${path} could not be removed (${code}); the pid file was kept.`);
          }
        };
        const describeKeptRecord = (
          path: string,
          kept: PidFileState,
          expectedPid?: number,
          expectedStartToken?: string,
        ): string => {
          if (kept.kind === "running" && (kept.pid !== expectedPid || kept.startToken !== expectedStartToken)) {
            return `pid file ${path} now belongs to a different process (pid ${kept.pid}) and was kept.`;
          }
          return `pid file ${path} no longer holds the record this stop read and was kept.`;
        };
        // A bad record says nothing about the relay process: describe the
        // record, remove it when the re-read still holds the same bytes, and
        // leave state unknown. A record replaced in between is kept.
        const reportBadRecord = (snapshot: PidRecordSnapshot): void => {
          const state = snapshot.state;
          if (state.kind !== "invalid" && state.kind !== "stale") return;
          const { kind, path } = state;
          const current = snapshotPidRecord(path);
          if (current.state.kind === "unreadable") {
            throw new Error(
              `Mail relay pid file ${path} was ${kind} and could not be read at the final check; the pid file was kept, and the relay's state is unknown. Inspect it and remove it yourself if the relay is not running.`,
            );
          }
          if (
            current.state.kind !== "missing" &&
            !pidRecordBytesEqual(current.raw, snapshot.raw)
          ) {
            console.log(
              `Mail relay pid file ${path} was ${kind}; ${describeKeptRecord(path, current.state, state.kind === "stale" ? state.pid : undefined)} This command signalled no process, and the relay's state is unknown.`,
            );
            return;
          }
          let removal: "removed" | "already gone";
          if (current.state.kind === "missing") {
            removal = "already gone";
          } else {
            try {
              removal = removeRelayPidFile(path);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code ?? "unknown";
              throw new Error(
                `Mail relay pid file ${path} was ${kind} and could not be removed (${code}); this command signalled no process, the pid file was kept, and the relay's state is unknown.`,
              );
            }
          }
          console.log(
            removal === "removed"
              ? `Mail relay pid file ${path} was ${kind} and was removed; this command signalled no process, and the relay's state is unknown.`
              : `Mail relay pid file ${path} was ${kind} and is already gone; this command signalled no process, and the relay's state is unknown.`,
          );
        };
        if (state.kind === "missing") {
          console.log("Mail relay is not running.");
          break;
        }
        if (state.kind === "unreadable") {
          throw new Error(
            `Mail relay pid file ${state.path} could not be read, so its process identity cannot be verified. Check that process and stop it yourself, or remove ${state.path} if the relay is not running.`,
          );
        }
        if (state.kind === "invalid" || state.kind === "stale") {
          reportBadRecord(classification);
          break;
        }
        if (state.kind === "unverified") {
          throw new Error(
            `Mail relay pid file names pid ${state.pid}, but that process's identity cannot be verified. Check that pid and stop it yourself, or remove ${state.path} if the relay is not running.`,
          );
        }
        // The classification above is the plan, not the decision. This one
        // read is the pre-signal snapshot: it decides whether to signal and
        // its bytes are the ones the removal below compares against.
        const decision = readStopRecord();
        const current = decision.state;
        if (current.kind !== "running" || current.pid !== state.pid || current.startToken !== state.startToken) {
          if (current.kind === "missing") {
            console.log("Mail relay pid file disappeared before it was signalled; this command signalled no process.");
          } else if (current.kind === "invalid" || current.kind === "stale") {
            console.log(
              `Mail relay pid file ${current.path} is now ${current.kind}; this command signalled no process.`,
            );
          } else if (current.kind === "unreadable") {
            throw new Error(
              `Mail relay pid file ${current.path} could not be re-read, so its process identity cannot be verified; this command signalled no process. Check that process and stop it yourself, or remove ${current.path} if the relay is not running.`,
            );
          } else if (current.kind === "unverified") {
            throw new Error(
              `Mail relay pid file ${current.path} now names pid ${current.pid}, but that process's identity cannot be verified; this command signalled no process. Check that pid and stop it yourself, or remove ${current.path} if the relay is not running.`,
            );
          } else if (current.pid !== state.pid) {
            throw new Error(
              `Mail relay pid file ${current.path} now names pid ${current.pid}, not the pid ${state.pid} that was read; this command signalled no process.`,
            );
          } else {
            throw new Error(
              `Mail relay pid file ${current.path} still names pid ${current.pid}, but its start token changed before it was signalled; this command signalled no process.`,
            );
          }
          break;
        }
        // cli#970: compare the record's bytes before removing it, as
        // `office kill` does. Relay pid records are written without a lock,
        // so a record written between this compare and the unlink can still
        // be removed.
        const stopPid = state.pid;
        const stopStartToken = state.startToken;
        const removeStopRecord = (
          path: string,
          snapshot: PidRecordSnapshot,
        ): "removed" | "already gone" | { kept: PidFileState } => {
          const current = snapshotPidRecord(path);
          if (current.state.kind === "missing") return "already gone";
          if (current.state.kind === "unreadable") {
            throw new Error(
              `Mail relay pid file ${path} could not be read at the final check; the pid file was kept. Inspect it and remove it yourself if the relay is not running.`,
            );
          }
          if (!pidRecordBytesEqual(current.raw, snapshot.raw)) {
            return { kept: current.state };
          }
          return removeRelayPid(path);
        };
        try {
          sendRelayStopSignal(state.pid);
        } catch (error) {
          // Only a probe that classifies the pid "gone" proves the process is
          // gone: remove the file in that case. EPERM ("alive") and any other
          // result keep the file and fail with the operator's recovery path.
          if (pidStateFromProbeError(error) !== "gone") {
            throw new Error(`Mail relay could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
          }
          const removal = removeStopRecord(state.path, decision);
          if (removal === "removed") {
            console.log(`Recorded relay process (pid ${state.pid}) is gone (stale pid file removed).`);
          } else if (removal === "already gone") {
            console.log(`Recorded relay process (pid ${state.pid}) is gone (pid file already gone).`);
          } else {
            console.log(
              `Recorded relay process (pid ${state.pid}) is gone; ${describeKeptRecord(state.path, removal.kept, stopPid, stopStartToken)}`,
            );
          }
          break;
        }
        if (!(await waitForRelayExit(state.pid))) {
          throw new Error(`Mail relay could not be stopped (pid ${state.pid}); pid file kept at ${state.path}.`);
        }
        const removal = removeStopRecord(state.path, decision);
        if (removal === "removed") {
          console.log(`Mail relay stopped (pid=${state.pid}); pid file removed.`);
        } else if (removal === "already gone") {
          console.log(`Mail relay stopped (pid=${state.pid}); pid file already gone.`);
        } else {
          console.log(`Mail relay stopped (pid=${state.pid}); ${describeKeptRecord(state.path, removal.kept, stopPid, stopStartToken)}`);
        }
        break;
      }

      if (relayAction === "start") {
        const existing = readRelayPidFile();
        if (existing.kind === "running") {
          throw new Error(`Mail relay already running (pid=${existing.pid}).`);
        }
        if (existing.kind === "unverified") {
          throw new Error(
            `Mail relay pid file ${existing.path} names pid ${existing.pid}, but that process's identity cannot be verified. Check that pid and stop it yourself, or remove ${existing.path} if the relay is not running.`,
          );
        }
        if (existing.kind === "unreadable") {
          throw new Error(
            `Mail relay pid file ${existing.path} could not be read, so its process identity cannot be verified. Check that process and stop it yourself, or remove ${existing.path} if the relay is not running.`,
          );
        }
        if (existing.kind === "invalid" || existing.kind === "stale") {
          removePidFile(existing.path);
        }
        // Spawn relay as detached background process
        const { spawn } = await import("node:child_process");
        const daemon = spawn(
          process.execPath,
          [...process.execArgv, process.argv[1]!, "mail", "relay", "_run", mailDir],
          {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            env: process.env as NodeJS.ProcessEnv,
          },
        );
        daemon.unref();
        await new Promise((r) => setTimeout(r, 500));
        const started = readRelayPidFile();
        const newPid =
          started.kind === "running" || started.kind === "unverified" ? started.pid : null;
        console.log(newPid ? `Mail relay started: pid=${newPid}` : "Mail relay started (pid pending).");
        break;
      }

      if (relayAction === "_run") {
        // Internal: actual daemon loop
        const dir = args.message ?? mailDir;
        await runRelayDaemon(dir);
        break;
      }

      console.error(`Usage: tps mail relay [start|stop|status]`);
      process.exit(1);
      break;
    }

    case "ack": {
      const agent = await resolveAgentId(args.agent);
      const id = args.messageId ?? args.message;
      if (!id) {
        console.error("Usage: tps mail ack <id> [--agent <id>]");
        process.exit(1);
      }
      await verifyMailAction(agent, id);
      const msg = ackMessage(agent, id);
      if (!msg) {
        console.warn(`Message already gone or not found: ${id}`);
        return;
      }
      console.log(`Acked ${msg.id}`);
      return;
    }

    case "nack": {
      const agent = await resolveAgentId(args.agent);
      const id = args.messageId ?? args.message;
      if (!id || !args.reason) {
        console.error("Usage: tps mail nack <id> --reason <text> [--agent <id>] [--type transient|agent|permanent] [--retry-after <duration>]");
        process.exit(1);
      }
      await verifyMailAction(agent, id);
      const msg = nackMessage(agent, id, args.reason, args.type ?? "transient", args.retryAfter);
      if (!msg) {
        console.warn(`Message already gone or not found: ${id}`);
        return;
      }
      console.log(`Nacked ${msg.id} (${msg.nackType})`);
      return;
    }

    case "gc": {
      const removed = gcMessages(args.agent, args.maxAge, args.pr);
      console.log(`GC removed ${removed} message(s)`);
      return;
    }

    case "search": {
      if (!args.agent) {
        console.error("Usage: tps mail search <query>");
        process.exit(1);
      }
      const { queryArchive } = await import("../utils/archive.js");
      const results = queryArchive({ search: args.agent, limit: 50 });
      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          console.log("No results found.");
        } else {
          for (const r of results) {
            console.log(`[${r.timestamp}] ${r.event}: ${r.from} -> ${r.to}`);
            if (r.body) {
              console.log(r.body.slice(0, 100) + (r.body.length > 100 ? "..." : ""));
            }
            console.log("---");
          }
        }
      }
      break;
    }

    case "topic": {
      const { createTopic, listTopics } = await import("../utils/mail-topics.js");
      const subAction = args.topicAction;

      if (subAction === "create") {
        const name = args.agent;
        if (!name) {
          console.error("Usage: tps mail topic create <name> [--desc \"...\"]");
          process.exit(1);
        }
        const meta = createTopic(name, args.desc);
        if (args.json) {
          console.log(JSON.stringify(meta, null, 2));
        } else {
          console.log(`Topic created: ${meta.name}`);
        }
        return;
      }

      if (subAction === "list") {
        const topics = listTopics();
        if (args.json) {
          console.log(JSON.stringify(topics, null, 2));
        } else if (topics.length === 0) {
          console.log("No topics.");
        } else {
          for (const t of topics) {
            const last = t.lastMessage ? ` last=${t.lastMessage}` : "";
            console.log(`  ${t.name}  subs=${t.subscribers.length}  msgs=${t.messageCount}${last}`);
            if (t.description) console.log(`    ${t.description}`);
          }
        }
        return;
      }

      console.error("Usage:\n  tps mail topic create <name> [--desc \"...\"]\n  tps mail topic list");
      process.exit(1);
      break;
    }

    case "subscribe": {
      const { subscribe } = await import("../utils/mail-topics.js");
      const topic = args.agent;
      if (!topic) {
        console.error("Usage: tps mail subscribe <topic> [--id <agentId>] [--from-beginning]");
        process.exit(1);
      }
      const agentId = await resolveAgentId(args.from);
      subscribe(topic, agentId, args.fromBeginning);
      if (args.json) {
        console.log(JSON.stringify({ status: "subscribed", topic, agentId }));
      } else {
        console.log(`${agentId} subscribed to ${topic}`);
      }
      return;
    }

    case "unsubscribe": {
      const { unsubscribe } = await import("../utils/mail-topics.js");
      const topic = args.agent;
      if (!topic) {
        console.error("Usage: tps mail unsubscribe <topic> [--id <agentId>]");
        process.exit(1);
      }
      const agentId = await resolveAgentId(args.from);
      unsubscribe(topic, agentId);
      if (args.json) {
        console.log(JSON.stringify({ status: "unsubscribed", topic, agentId }));
      } else {
        console.log(`${agentId} unsubscribed from ${topic}`);
      }
      return;
    }

    case "publish": {
      const { publishToTopic } = await import("../utils/mail-topics.js");
      const topic = args.agent;
      if (!topic || !args.message) {
        console.error("Usage: tps mail publish <topic> <message> [--from <agentId>]");
        process.exit(1);
      }
      const from = await resolveAgentId(args.from);
      const entry = publishToTopic(topic, from, args.message);
      if (args.json) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`Published to ${topic} (${entry.id.slice(0, 8)})`);
      }
      return;
    }
  }
}
