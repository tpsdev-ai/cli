import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readPresence } from "../src/utils/presence-read.js";
import { flairTarget } from "./helpers/scratch-flair.js";
import { pubkeyFromSeed, requestSigner } from "./helpers/stub-flair.js";

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")("real Flair serves a capped task to a signed reader", async () => {
  const { baseUrl: flairUrl, opsUrl, admin } = flairTarget();
  const id = `presence-contract-${randomUUID()}`;
  const seed = Buffer.alloc(32, 0x6b);
  // The production scheme: real Flair 0.58.0 matches `TPS-Ed25519` case-sensitively.
  const sign = requestSigner(id, seed);
  const operation = (body: unknown) => fetch(opsUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(admin).toString("base64")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const task = "x".repeat(199) + " ";
  try {
    const inserted = await operation({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id, name: id, publicKey: pubkeyFromSeed(seed).toString("base64"), createdAt: new Date().toISOString() }],
    });
    expect(inserted.ok).toBe(true);
    const now = Date.now();
    const stored = await operation({
      operation: "insert", database: "flair", table: "Presence",
      records: [{ agentId: id, lastHeartbeatAt: now, activity: "coding", activityUpdatedAt: now, currentTask: `  ${task}tail  ` }],
    });
    expect(stored.ok).toBe(true);
    const read = await readPresence({ flairUrl, sign });
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.agents.find((agent) => agent.id === id)?.currentTask).toBe(task);
  } finally {
    for (const table of ["Presence", "Agent"]) {
      const deleted = await operation({ operation: "delete", database: "flair", table, hash_values: [id] });
      expect(deleted.ok).toBe(true);
    }
  }
}, 30_000);

test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1")("real Flair rejects an invalid Bearer token on GET /Presence", async () => {
  const response = await fetch(`${flairTarget().baseUrl}/Presence`, {
    headers: { Authorization: "Bearer not-a-credential" },
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "invalid token" });
});
