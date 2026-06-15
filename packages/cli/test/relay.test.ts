import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deliverToSandbox, processOutboxOnce } from "../src/utils/relay.js";

function writeJson(path: string, obj: unknown) {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}

describe("relay utils", () => {
  let root: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-relay-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = root;
    process.env.TPS_MAIL_DIR = join(root, ".tps", "mail");
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.TPS_MAIL_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  function outboxNew(agent = "brancha") {
    const p = join(root, ".tps", "branch-office", agent, "mail", "outbox", "new");
    mkdirSync(p, { recursive: true });
    return p;
  }

  test("relay overwrites from and sets origin on delivered messages", async () => {
    const out = outboxNew("brancha");
    writeJson(join(out, "m1.json"), {
      id: "msg-1",
      from: "flint",
      to: "kern",
      body: "hello",
      timestamp: new Date().toISOString(),
    });

    const res = await processOutboxOnce("brancha");
    expect(res.processed).toBe(1);

    const inbox = join(root, ".tps", "mail", "kern", "new");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const delivered = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(delivered.from).toBe("container:brancha");
    expect(delivered.origin).toBe("docker-sandbox");
  });

  test("relay validates recipient and moves invalid messages to failed", async () => {
    const out = outboxNew("brancha");
    writeJson(join(out, "bad.json"), {
      from: "x",
      to: "../../etc/passwd",
      body: "oops",
      timestamp: new Date().toISOString(),
    });

    const res = await processOutboxOnce("brancha");
    expect(res.failed).toBe(1);

    const failed = join(root, ".tps", "branch-office", "brancha", "mail", "outbox", "failed");
    const ff = readdirSync(failed).filter((f) => f.endsWith(".json"));
    expect(ff.length).toBeGreaterThan(0);
  });

  test("relay enforces recipient inbox quota", async () => {
    const recipientNew = join(root, ".tps", "mail", "kern", "new");
    mkdirSync(recipientNew, { recursive: true });
    for (let i = 0; i < 100; i++) {
      writeJson(join(recipientNew, `seed-${i}.json`), { id: String(i), from: "x", to: "kern", body: "x", timestamp: new Date().toISOString(), read: false });
    }

    const out = outboxNew("brancha");
    writeJson(join(out, "overflow.json"), {
      from: "brancha",
      to: "kern",
      body: "blocked",
      timestamp: new Date().toISOString(),
    });

    const res = await processOutboxOnce("brancha");
    expect(res.failed).toBe(1);
  });

  test("processed messages move from outbox/new to outbox/cur", async () => {
    const out = outboxNew("brancha");
    writeJson(join(out, "ok.json"), {
      from: "brancha",
      to: "kern",
      body: "ok",
      timestamp: new Date().toISOString(),
    });
    await processOutboxOnce("brancha");

    const cur = join(root, ".tps", "branch-office", "brancha", "mail", "outbox", "cur");
    const curFiles = readdirSync(cur).filter((f) => f.endsWith(".json"));
    expect(curFiles.length).toBe(1);
  });

  test("deliverToSandbox writes to mail/new (canonical inbox path)", async () => {
    // Pre-create the branch-office mail root so getInbox() treats brancha as a branch agent
    const branchMail = join(root, ".tps", "branch-office", "brancha", "mail");
    mkdirSync(branchMail, { recursive: true });

    deliverToSandbox("brancha", {
      to: "brancha",
      from: "flint",
      body: "hi from host",
    });

    // Canonical path: branch-office/<agent>/mail/new/ (matches getInbox().fresh)
    const inbox = join(branchMail, "new");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const payload = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(payload.body).toBe("hi from host");
  });

  test("relay ignores forged from field and rewrites to container:<agent>", async () => {
    const out = outboxNew("brancha");
    writeJson(join(out, "forge.json"), {
      from: "flint",
      to: "kern",
      body: "forged",
      timestamp: new Date().toISOString(),
    });
    await processOutboxOnce("brancha");

    const inbox = join(root, ".tps", "mail", "kern", "new");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    const delivered = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(delivered.from).toBe("container:brancha");
  });

  test("delivers to team workspace for team agents", async () => {
    // Setup team structure
    const teamDir = join(root, ".tps", "branch-office", "team1");
    const workspaceMail = join(teamDir, "workspace", "mail");
    const teamSidecar = {
      teamId: "team1",
      members: ["member1", "member2"],
      workspaceMail,
      createdAt: new Date().toISOString(),
    };

    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(workspaceMail, "new"), { recursive: true });
    writeJson(join(teamDir, "team.json"), teamSidecar);

    // Test delivery to member
    deliverToSandbox("member1", {
      to: "member1",
      from: "host",
      body: "hello team member",
    });

    // Canonical path: workspaceMail/new/ (matches getInbox().fresh)
    const inbox = join(workspaceMail, "new");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(msg.to).toBe("member1");
    expect(msg.body).toBe("hello team member");
  });

  test("relays branch→branch mail to the recipient's workspace inbox, not the host path (ops-16)", async () => {
    const out = outboxNew("brancha");
    // branchb is a registered branch (has a branch-office dir) → reads its workspace inbox.
    const recipBranch = join(root, ".tps", "branch-office", "branchb");
    mkdirSync(recipBranch, { recursive: true });
    writeJson(join(out, "m1.json"), {
      id: "msg-bb", from: "brancha", to: "branchb",
      body: "hello branch b", timestamp: new Date().toISOString(),
    });

    const res = await processOutboxOnce("brancha");
    expect(res.processed).toBe(1);

    // Lands in branchb's workspace inbox (branch-office/branchb/mail/new)...
    const wsInbox = join(recipBranch, "mail", "new");
    expect(readdirSync(wsInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
    // ...not the flat host path (~/.tps/mail/branchb/new).
    const hostPath = join(root, ".tps", "mail", "branchb", "new");
    const hostCount = existsSync(hostPath) ? readdirSync(hostPath).filter((f) => f.endsWith(".json")).length : 0;
    expect(hostCount).toBe(0);
  });

  test("relays to a team member's workspace inbox, not the host path (ops-16)", async () => {
    const out = outboxNew("brancha");
    const teamDir = join(root, ".tps", "branch-office", "team1");
    const workspaceMail = join(teamDir, "workspace", "mail");
    mkdirSync(teamDir, { recursive: true });
    writeJson(join(teamDir, "team.json"), {
      teamId: "team1", members: ["member1"], workspaceMail, createdAt: new Date().toISOString(),
    });
    writeJson(join(out, "m1.json"), {
      id: "msg-m1", from: "brancha", to: "member1",
      body: "hello member", timestamp: new Date().toISOString(),
    });

    const res = await processOutboxOnce("brancha");
    expect(res.processed).toBe(1);

    expect(readdirSync(join(workspaceMail, "new")).filter((f) => f.endsWith(".json")).length).toBe(1);
    const hostPath = join(root, ".tps", "mail", "member1", "new");
    const hostCount = existsSync(hostPath) ? readdirSync(hostPath).filter((f) => f.endsWith(".json")).length : 0;
    expect(hostCount).toBe(0);
  });

  test("relays to a non-branch (host) recipient via the host mail path (ops-16 regression guard)", async () => {
    const out = outboxNew("brancha");
    writeJson(join(out, "m1.json"), {
      id: "msg-host", from: "brancha", to: "kern",
      body: "hello host agent", timestamp: new Date().toISOString(),
    });

    const res = await processOutboxOnce("brancha");
    expect(res.processed).toBe(1);

    // kern has no branch-office presence → host path, unchanged.
    const hostInbox = join(root, ".tps", "mail", "kern", "new");
    expect(readdirSync(hostInbox).filter((f) => f.endsWith(".json")).length).toBe(1);
  });

  test("relay pauses duplicate messages (loop detection)", async () => {
    const agentId = "brancha";
    const out = outboxNew(agentId);

    // Send the same message 3 times
    for (let i = 0; i < 3; i++) {
      const msg = { to: "host", body: "I am stuck in a loop" };
      writeFileSync(join(out, `loop-${i}.json`), JSON.stringify(msg), "utf-8");
    await processOutboxOnce(agentId);
    }

    // Third message should be in paused/, not delivered
    const pausedDir = join(root, ".tps", "branch-office", agentId, "mail", "outbox", "paused");
    const pausedFiles = readdirSync(pausedDir).filter((f) => f.endsWith(".json"));
    expect(pausedFiles.length).toBeGreaterThanOrEqual(1);
  });
});
