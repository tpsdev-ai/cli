import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlairClient } from "../src/utils/flair-client.js";
import { taskLoopCursorPath } from "../src/utils/flair-task-loop.js";
import { startReviewTriggerLoop } from "../src/utils/pr-review-trigger.js";
import { pubkeyFromSeed, writeKeyFile } from "./helpers/stub-flair.js";

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")("real Flair stamps a signed non-admin POST and the review loop skips its claimed agent attribution", async () => {
  const baseUrl = "http://127.0.0.1:9926";
  const root = mkdtempSync(join(tmpdir(), "review-flair-"));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  const agent = `review-${randomUUID()}`;
  const foreign = `foreign-${randomUUID()}`;
  const seeds = new Map([[agent, Buffer.alloc(32, 0x31)], [foreign, Buffer.alloc(32, 0x32)]]);
  const headers = { Authorization: `Basic ${Buffer.from("admin:test123").toString("base64")}`, "Content-Type": "application/json" };
  const operation = (body: unknown) => fetch("http://127.0.0.1:9925", { method: "POST", headers, body: JSON.stringify(body) });
  const forgedId = `forged-${randomUUID()}`;
  const goodId = `good-${randomUUID()}`;
  let loop: ReturnType<typeof startReviewTriggerLoop> | undefined;
  try {
    const inserted = await operation({ operation: "insert", database: "flair", table: "Agent", records: [...seeds].map(([id, seed]) => ({
      id, name: id, publicKey: pubkeyFromSeed(seed).toString("base64"), admin: false, createdAt: new Date().toISOString(),
    })) });
    expect(inserted.ok).toBe(true);
    const client = new FlairClient({ agentId: agent, baseUrl, keyPath: writeKeyFile(root, agent, seeds.get(agent)!) });
    const caller = new FlairClient({ agentId: foreign, baseUrl, keyPath: writeKeyFile(root, foreign, seeds.get(foreign)!) });
    const since = new Date(Date.now() - 60_000);
    const event = { kind: "pr.opened", authorId: agent, targetIds: [agent], summary: "Review attribution", detail: "https://github.com/example/repo/pull/999", createdAt: new Date().toISOString() };
    await caller.request("POST", "/OrgEvent/", { ...event, id: forgedId });
    const stored = await client.request<{ authorId: string }>("GET", `/OrgEvent/${forgedId}`);
    expect(stored.authorId).toBe(foreign);
    const catchup = await client.getEventsSince(agent, since);
    expect(catchup.status).toBe("ok");
    if (catchup.status !== "ok") throw new Error("Catch-up unavailable");
    expect(catchup.events.find((row) => row.id === forgedId)?.authorId).toBe(foreign);
    await Bun.sleep(5);
    await client.request("POST", "/OrgEvent/", { ...event, id: goodId, detail: "https://github.com/example/repo/pull/17" });
    const good = await client.request<{ createdAt: string }>("GET", `/OrgEvent/${goodId}`);
    const calls: string[][] = [];
    loop = startReviewTriggerLoop(client, agent, { reviewers: ["reviewer-1"], repo: "example/repo" }, {
      pollIntervalMs: 20,
      deps: { spawnSyncImpl: ((_cmd: string, args: string[]) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; }) as any },
    });
    const deadline = Date.now() + 5_000;
    let position: string | undefined;
    do {
      try { position = JSON.parse(readFileSync(taskLoopCursorPath(`${agent}-review-trigger`), "utf8")).position; } catch {}
      if (position === `${good.createdAt}\t${goodId}`) break;
      await Bun.sleep(20);
    } while (Date.now() < deadline);
    expect(position).toBe(`${good.createdAt}\t${goodId}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[4]).toBe("repos/example/repo/pulls/17/requested_reviewers");
  } finally {
    await loop?.stop();
    try {
      for (const [table, ids] of [["OrgEvent", [forgedId, goodId]], ["Agent", [agent, foreign]]] as const) {
        const deleted = await operation({ operation: "delete", database: "flair", table, hash_values: ids });
        expect(deleted.ok).toBe(true);
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);
