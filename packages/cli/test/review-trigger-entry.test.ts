import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSignedEnvelope } from "./helpers/stub-flair.js";

function readRows(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

for (const taskPath of ["flair", "mail"]) {
  test(`${taskPath} task: config-file launch publishes the PR URL and requests configured reviewers`, async () => {
    const root = mkdtempSync(join(tmpdir(), "review-entry-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const agentDir = join(root, ".tps", "agents", "agent-a");
    for (const path of [bin, workspace, agentDir]) mkdirSync(path, { recursive: true });
    const keyPath = join(root, "agent-a.key");
    writeFileSync(keyPath, Buffer.alloc(32, 0x31));
    writeFileSync(join(workspace, "SOUL.md"), "Test agent");
    const processFixture = readFileSync(join(import.meta.dir, "helpers/review-trigger-process.ts"), "utf8");
    for (const command of ["codex", "git", "gh-as"]) {
      const path = join(bin, command);
      writeFileSync(path, `#!${process.execPath}\n${processFixture}`);
      chmodSync(path, 0o755);
    }
    const configPath = join(root, "agent.yaml");
    writeFileSync(configPath, JSON.stringify({
      agentId: "agent-a", workspace,
      workspaceProvider: { type: "none" },
      flair: { url: "http://flair.test", keyPath },
      autoCommit: { push: true, openPr: true, prRepo: "example/repo" },
      reviewTrigger: { reviewers: ["reviewer-1", "reviewer-2"], repo: "example/repo" },
    }));
    if (taskPath === "mail") {
      const inbox = join(root, "mail", "agent-a", "new");
      mkdirSync(inbox, { recursive: true });
      const envelope = buildSignedEnvelope("flint", "agent-a", "Implement change", {
        "agent-a": Buffer.alloc(32, 0x31), flint: Buffer.alloc(32, 0x32),
      }, { messageId: "task-mail", trust: "internal" });
      writeFileSync(join(inbox, "task-mail.json"), JSON.stringify({
        id: "task-mail", from: "flint", to: "agent-a", body: JSON.stringify(envelope),
        timestamp: envelope.timestamp, read: false,
      }));
    }
    const child = spawn(process.execPath, [
      "--preload", join(import.meta.dir, "helpers/review-trigger-entry-preload.ts"),
      resolve(import.meta.dir, "../dist/bin/tps.js"),
      "agent", "start", "--id", "agent-a", "--config", configPath,
      "--runtime", "codex", "--no-sandbox", "--quiet-nono-check",
    ], {
      cwd: workspace,
      env: { ...process.env, HOME: root, TPS_MAIL_DIR: join(root, "mail"), TPS_GIT_BIN: join(bin, "git"),
        PATH: `${bin}:${process.env.PATH}`, REVIEW_TASK_PATH: taskPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    try {
      const deadline = Date.now() + 18_000;
      let calls: any[] = [];
      do {
        calls = readRows(join(root, "processes.jsonl"));
        if (calls.some((call) => call.command === "gh-as" && call.args[1] === "api")) break;
        if (child.exitCode !== null) break;
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      const emitted = readRows(join(root, "events.jsonl")).filter((event) => event.kind === "pr.opened");
      expect(emitted, output).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ authorId: "agent-a", refId: `task-${taskPath}`, detail: "https://github.com/example/repo/pull/17" });
      expect(calls.filter((call) => call.command === "codex"), output).toHaveLength(1);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push"), output).toBe(true);
      expect(calls.filter((call) => call.command === "gh-as" && call.args[1] === "api"), output).toEqual([{
        command: "gh-as",
        args: ["agent-a", "api", "--method", "POST", "repos/example/repo/pulls/17/requested_reviewers", "--input", "-"],
        input: JSON.stringify({ reviewers: ["reviewer-1", "reviewer-2"] }),
      }]);
    } finally {
      child.kill("SIGKILL");
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
}
