import { ackMessage, assertValidBody, checkMessages, gcMessages, getInbox, listMessages, nackMessage, sendMessage, type MailMessage } from "../utils/mail.js";
import { deliverToSandbox, deliverToRemoteBranch } from "../utils/relay.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { queryArchive } from "../utils/archive.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, watch } from "node:fs";
import { loadHostIdentityId } from "../utils/identity.js";
import { queueOutboxMessage } from "../utils/outbox.js";
import { galLookup } from "../utils/gal.js";

interface MailArgs {
  action: "send" | "check" | "list" | "stats" | "log" | "read" | "watch" | "search" | "relay" | "topic" | "subscribe" | "unsubscribe" | "publish" | "ack" | "nack" | "gc";
  agent?: string;
  message?: string;
  messageId?: string;
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

function newestJsonMtime(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(dir, file))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return newest ? statSync(newest).mtime.toISOString() : null;
}

export async function runMail(args: MailArgs): Promise<void> {
  switch (args.action) {
    case "send": {
      const to = validateAgent(args.agent);
      if (!args.message) {
        console.error("Usage: tps mail send <agent> <message>");
        process.exit(1);
      }
      const from = await resolveAgentId();

      // Branch mode: queue outbound to be picked up by host on next connect
      const branchHostFile = join(process.env.HOME || homedir(), ".tps", "identity", "host.json");
      if (existsSync(branchHostFile)) {
        assertValidBody(args.message);
        queueOutboxMessage(to, args.message, from);
        if (args.json) {
          console.log(JSON.stringify({ status: "queued", to, queue: "outbox" }));
        } else {
          console.log("Queued for delivery to host.");
        }
        return;
      }

      // GAL lookup: resolve agent name → physical branch ID
      const galBranchId = galLookup(to);
      const effectiveTo = galBranchId ?? to;

      // Check for remote branch (has remote.json)
      const remoteJsonPath = join(
        process.env.HOME || homedir(),
        ".tps",
        "branch-office",
        effectiveTo,
        "remote.json"
      );
      if (existsSync(remoteJsonPath)) {
        assertValidBody(args.message);
        await deliverToRemoteBranch(effectiveTo, { to, from, body: args.message });
        if (args.json) {
          console.log(JSON.stringify({ status: "sent", to, transport: "remote", resolvedBranch: effectiveTo }));
        } else {
          const resolvedNote = galBranchId ? ` (via GAL: ${galBranchId})` : "";
          console.log(`Mail delivered to remote branch '${to}'${resolvedNote}.`);
        }
        return;
      }

      // Inbound Bridge: check if recipient is a local branch office agent
      const branchInbox = join(process.env.HOME || homedir(), ".tps", "branch-office", effectiveTo, "mail", "inbox");
      if (existsSync(branchInbox)) {
        assertValidBody(args.message);
        deliverToSandbox(effectiveTo, {
          to,
          from,
          body: args.message,
        });
        if (args.json) {
          console.log(JSON.stringify({ status: "sent", to, bridge: "branch-office" }));
        } else {
          console.log(`Message sent to branch office ${to}`);
        }
        return;
      }

      const msg = sendMessage(to, args.message, from);
      if (args.json) {
        console.log(JSON.stringify(msg, null, 2));
      } else {
        console.log(`Message sent to ${to} (${msg.id})`);
      }
      return;
    }

    case "check": {
      const agent = await resolveAgentId(args.agent);
      const messages = checkMessages(agent);
      if (args.json) {
        console.log(JSON.stringify(messages, null, 2));
      } else if (messages.length === 0) {
        console.log("No new messages.");
      } else {
        for (const m of messages) {
          console.log(`📬 ${m.from} → ${m.to}  ${m.timestamp}`);
          console.log(m.body);
          console.log("---");
        }
      }
      return;
    }

    case "list": {
      const agent = await resolveAgentId(args.agent);
      let messages = listMessages(agent)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
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
        console.log(JSON.stringify(messages, null, 2));
      } else {
        const limit = Math.max(0, Math.floor(args.limit ?? 20));
        const visible = messages.slice(0, limit);
        if (visible.length === 0) {
          console.log("No messages.");
        } else {
          for (const m of visible) {
            const marker = m.read ? "📖" : "📬";
            console.log(`${marker} [${m.id.slice(0, 8)}] ${m.from} → ${m.to}  ${m.timestamp}`);
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
        inboxCount: readdirSync(inbox.fresh).filter((file) => file.endsWith(".json")).length,
        lastReceived: newestJsonMtime(inbox.fresh),
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
      const dirs = [inbox.fresh, inbox.cur];
      let found: MailMessage | null = null;
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir).filter(f => f.endsWith(".json"));
        for (const f of files) {
          const msg = JSON.parse(readFileSync(join(dir, f), "utf-8")) as MailMessage;
          if (msg.id === id || msg.id.startsWith(id)) { found = msg; break; }
        }
        if (found) break;
      }
      if (!found) {
        console.error(`Message not found: ${id}`);
        process.exit(1);
      }
      if (args.json) {
        console.log(JSON.stringify(found, null, 2));
      } else {
        const marker = found.read ? "📖" : "📬";
        console.log(`${marker} ${found.from} → ${found.to}  ${found.timestamp}`);
        console.log(`ID: ${found.id}`);
        console.log("---");
        console.log(found.body);
      }
      return;
    }

    case "watch": {
      const agent = await resolveAgentId(args.agent);
      const { fresh, cur } = getInbox(agent);
      console.log(`Watching ${agent} inbox... (Ctrl-C to stop)`);

      const print = (file: string) => {
        if (!file.endsWith(".json")) return;
        const fullPath = join(fresh, file);
        try {
          const raw = readFileSync(fullPath, "utf-8");
          const msg = JSON.parse(raw) as MailMessage;
          console.log(`\n📬 ${msg.from} → ${msg.to}  ${msg.timestamp}`);
          console.log(msg.body);
          renameSync(fullPath, join(cur, file));
        } catch {}
      };

      readdirSync(fresh).filter((f) => f.endsWith(".json")).forEach(print);

      const watcher = watch(fresh, (_event, filename) => {
        if (filename) print(filename.toString());
      });

      await new Promise<void>((resolve) => {
        const stop = () => {
          try { watcher.close(); } catch {}
          resolve();
        };
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
          console.log(`${icon} [${e.event}] ${e.from} → ${e.to} @ ${e.timestamp}${preview}`);
        }
      }
      return;
    }

    case "relay": {
      const relayAction = args.agent ?? "status"; // relay start|stop|status
      const { getRelayPid, runRelayDaemon } = await import("../utils/mail-relay.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const mailDir = join(homedir(), ".tps", "mail");

      if (relayAction === "status") {
        const pid = getRelayPid();
        if (pid) {
          console.log(`Mail relay running: pid=${pid}`);
        } else {
          console.log("Mail relay is not running.");
        }
        break;
      }

      if (relayAction === "stop") {
        const pid = getRelayPid();
        if (!pid) {
          console.log("Mail relay is not running.");
        } else {
          process.kill(pid, "SIGTERM");
          console.log(`Mail relay stopped (pid=${pid}).`);
        }
        break;
      }

      if (relayAction === "start") {
        const existingPid = getRelayPid();
        if (existingPid) {
          console.log(`Mail relay already running (pid=${existingPid}).`);
          break;
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
        const newPid = getRelayPid();
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
        console.error("Usage: tps mail ack <id> [agent]");
        process.exit(1);
      }
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
        console.error("Usage: tps mail nack <id> --reason <text> [--type transient|agent|permanent] [--retry-after <duration>]");
        process.exit(1);
      }
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
