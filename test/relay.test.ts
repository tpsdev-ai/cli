import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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

  test("deliverToSandbox writes to inbox/new atomically", async () => {
    deliverToSandbox("brancha", {
      to: "brancha",
      from: "flint",
      body: "hi from host",
    });

    const inbox = join(root, ".tps", "branch-office", "brancha", "mail", "inbox", "new");
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
    mkdirSync(join(workspaceMail, "inbox", "new"), { recursive: true });
    writeJson(join(teamDir, "team.json"), teamSidecar);

    // Test delivery to member
    deliverToSandbox("member1", {
      to: "member1",
      from: "host",
      body: "hello team member",
    });

    // Verify it landed in team workspace inbox
    const inbox = join(workspaceMail, "inbox", "new");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(join(inbox, files[0]!), "utf-8"));
    expect(msg.to).toBe("member1");
    expect(msg.body).toBe("hello team member");
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
