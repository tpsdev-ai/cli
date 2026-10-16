/**
 * real-flair.test.ts — additional tests across the Flair seam against a
 * REAL Flair (a scratch Harper serving the published @tpsdev-ai/flair), not a
 * fake. The cases cover the four seams a post-merge review found most often
 * wrong: signature-authenticated memory writes and reads, search read scoping for
 * a non-admin whose target is another agent, an archive PATCH that must leave the
 * other fields intact, and the agent key registration read-back of cli#512.
 *
 * They are opt-in, on the same flag cli#591 introduced (`TPS_TEST_REAL_FLAIR=1`):
 * the default suite skips them. The real-Flair lane
 * (`.github/workflows/real-flair.yml`) starts the scratch instance, sets the flag
 * and the instance's ports, and runs this file plus the other files that carry
 * real-Flair cases.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { FlairClient } from "../src/utils/flair-client.js";
import { freshAgentId, flairTarget, provisionAgent, SEEDED_AGENTS } from "./helpers/scratch-flair.js";

const realFlair = test.skipIf(process.env.TPS_TEST_REAL_FLAIR !== "1");

test("flairTarget reads the lane's ports and still honours the cli#591 URL variables", () => {
  expect(freshAgentId("reg")).toMatch(/^reg-/);
  expect(freshAgentId("reg")).not.toBe(freshAgentId("reg"));
  expect(SEEDED_AGENTS).toEqual(["agent-a", "agent-b"]);
  expect(flairTarget({ TPS_TEST_FLAIR_HTTP_PORT: "45001", TPS_TEST_FLAIR_OPS_PORT: "45002" })).toEqual({
    baseUrl: "http://127.0.0.1:45001",
    opsUrl: "http://127.0.0.1:45002",
    admin: "admin:test123",
  });
  expect(flairTarget({ TPS_TEST_FLAIR_URL: "http://127.0.0.1:9931", TPS_TEST_FLAIR_ADMIN: "operator:pw" })).toEqual({
    baseUrl: "http://127.0.0.1:9931",
    opsUrl: "http://127.0.0.1:9925",
    admin: "operator:pw",
  });
  expect(flairTarget({}).baseUrl).toBe("http://127.0.0.1:9926");
});

realFlair("a signed memory write reads back with the fields it was written with", async () => {
  const agent = await provisionAgent(flairTarget());
  const id = `mem-${randomUUID()}`;
  await agent.client.writeMemory(id, "the quick brown fox jumps over the lazy dog", {
    tags: ["seam"],
    type: "note",
    durability: "persistent",
  });
  // The read is signed with the same key Flair verified the write with.
  const read = await agent.client.getMemory(id);
  expect(read.id).toBe(id);
  expect(read.agentId).toBe(agent.id);
  expect(read.content).toBe("the quick brown fox jumps over the lazy dog");
  expect(read.durability).toBe("persistent");
  expect(read.type).toBe("note");
  expect(read.tags).toEqual(["seam"]);
  expect(read.archived ?? false).toBe(false);
}, 120_000);

realFlair("a non-admin searching another agent's scope is refused, and its own scope is served", async () => {
  const target = flairTarget();
  const reader = await provisionAgent(target);
  const other = await provisionAgent(target);
  const id = `mem-${randomUUID()}`;
  await reader.client.writeMemory(id, "a distinctive line about quantum bananas", { tags: ["scope"] });
  // The signer is `reader`; the requested scope is `other`'s. Flair refuses.
  await expect(reader.client.search("quantum bananas", 5, { agentId: other.id })).rejects.toThrow(/403/);
  const own = await reader.client.search("quantum bananas", 5, { agentId: reader.id });
  expect(own.map((r) => r.id)).toContain(id);
}, 120_000);

realFlair("archiving over PATCH keeps the memory's other fields", async () => {
  const agent = await provisionAgent(flairTarget());
  const id = `mem-${randomUUID()}`;
  await agent.client.writeMemory(id, "content that must survive the archive", {
    tags: ["keep"],
    type: "note",
    durability: "persistent",
  });
  const before = await agent.client.getMemory(id);
  await agent.client.archiveMemory(id);
  const after = await agent.client.getMemory(id);
  expect(after.archived).toBe(true);
  expect(after.archivedBy).toBe(agent.id);
  expect(after.archivedAt).toBeTruthy();
  expect(after.agentId).toBe(before.agentId);
  expect(after.content).toBe(before.content);
  expect(after.tags).toEqual(before.tags);
  expect(after.type).toBe(before.type);
  expect(after.durability).toBe(before.durability);
}, 120_000);

realFlair("agent registration reads its key back from Flair, the cli#512 seam", async () => {
  const target = flairTarget();
  const agent = await provisionAgent(target);
  // The registered row reads back exactly the key it was registered with.
  const registered = await agent.client.readStoredPublicKey(agent.id, target.admin);
  expect(registered).toEqual({ found: true, publicKey: agent.publicKey });
  // An id with no row reads as absent — a 404 is the only "no such row".
  const missing = freshAgentId("reg");
  expect(await agent.client.readStoredPublicKey(missing, target.admin)).toEqual({ found: false, publicKey: null });
  // On Flair 0.58.0 a registration over Agent PUT does not complete, so the
  // read-back stays the source of truth: it stays absent.
  const registrar = new FlairClient({ agentId: missing, keyPath: agent.keyPath, baseUrl: target.baseUrl });
  await expect(registrar.registerAgent(missing, agent.publicKey, target.admin)).rejects.toThrow();
  expect(await agent.client.readStoredPublicKey(missing, target.admin)).toEqual({ found: false, publicKey: null });
}, 120_000);
