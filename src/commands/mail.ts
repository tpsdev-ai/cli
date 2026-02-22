import { assertValidBody, checkMessages, getInbox, listMessages, sendMessage, type MailMessage } from "../utils/mail.js";
import { deliverToSandbox, deliverToRemoteBranch } from "../utils/relay.js";
import { sanitizeIdentifier } from "../schema/sanitizer.js";
import { queryArchive } from "../utils/archive.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, renameSync, watch } from "node:fs";
import { loadHostIdentityId } from "../utils/identity.js";
import { queueOutboxMessage } from "../utils/outbox.js";

interface MailArgs {
  action: "send" | "check" | "list" | "log" | "read" | "watch";
  agent?: string;
  message?: string;
  messageId?: string;
  json?: boolean;
  since?: string;
  limit?: number;
}

function resolveAgentId(override?: string): string {
  const id = override || process.env.TPS_AGENT_ID || loadHostIdentityId() || "unknown";
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

export async function runMail(args: MailArgs): Promise<void> {
  switch (args.action) {
    case "send": {
      const to = validateAgent(args.agent);
      if (!args.message) {
        console.error("Usage: tps mail send <agent> <message>");
        process.exit(1);
      }
      const from = resolveAgentId();

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

      // Check for remote branch (has remote.json)
      const remoteJsonPath = join(
        process.env.HOME || homedir(),
        ".tps",
        "branch-office",
        to,
        "remote.json"
      );
      if (existsSync(remoteJsonPath)) {
        assertValidBody(args.message);
        await deliverToRemoteBranch(to, { to, from, body: args.message });
        if (args.json) {
          console.log(JSON.stringify({ status: "sent", to, transport: "remote" }));
        } else {
          console.log(`Mail delivered to remote branch '${to}'.`);
        }
        return;
      }

      // Inbound Bridge: check if recipient is a local branch office agent
      const branchInbox = join(process.env.HOME || homedir(), ".tps", "branch-office", to, "mail", "inbox");
      if (existsSync(branchInbox)) {
        assertValidBody(args.message);
        deliverToSandbox(to, {
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
      const agent = resolveAgentId(args.agent);
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
      const agent = resolveAgentId(args.agent);
      const messages = listMessages(agent);
      if (args.json) {
        console.log(JSON.stringify(messages, null, 2));
      } else if (messages.length === 0) {
        console.log("No messages.");
      } else {
        for (const m of messages) {
          const marker = m.read ? "📖" : "📬";
          console.log(`${marker} [${m.id.slice(0, 8)}] ${m.from} → ${m.to}  ${m.timestamp}`);
        }
      }
      return;
    }

    case "read": {
      const agent = resolveAgentId(args.agent);
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
      const agent = resolveAgentId(args.agent);
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
  }
}
