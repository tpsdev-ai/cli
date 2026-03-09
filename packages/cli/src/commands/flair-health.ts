/**
 * tps flair health — end-to-end Flair validation
 *
 * Checks:
 *   1. HTTP reachability
 *   2. Memory write (PUT /Memory/<test-id>)
 *   3. Memory read-back (GET /Memory/<test-id>)
 *   4. Semantic search roundtrip (POST /SemanticSearch)
 *   5. Memory cleanup (DELETE /Memory/<test-id>)
 *
 * Exits 0 if all pass, 1 if any fail.
 */

import { createFlairClient } from "../utils/flair-client.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const CHECK = "✓";
const FAIL  = "✗";
const SKIP  = "–";

function pad(label: string): string { return label.padEnd(32, " "); }

function defaultKeyPath(agentId: string): string {
  const candidates = [
    join(homedir(), ".tps", "secrets", "flair", `${agentId}-priv.key`),
    join(homedir(), ".tps", "secrets", `${agentId}-flair.key`),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

export async function runFlairHealth(opts: {
  agentId?: string;
  flairUrl?: string;
  flairKeyPath?: string;
  verbose?: boolean;
}): Promise<void> {
  const agentId  = opts.agentId    ?? process.env.TPS_AGENT_ID ?? "anvil";
  const flairUrl = opts.flairUrl   ?? process.env.FLAIR_URL    ?? "http://127.0.0.1:9926";
  const keyPath  = opts.flairKeyPath ?? process.env.FLAIR_KEY_PATH ?? defaultKeyPath(agentId);

  console.log(`\nFlair health check — ${flairUrl}  (agent: ${agentId})\n`);

  let passed = 0;
  let failed = 0;

  const ok   = (label: string, detail?: string) => { console.log(`  ${CHECK} ${pad(label)}${detail ? `  ${detail}` : ""}`); passed++; };
  const fail = (label: string, detail?: string) => { console.log(`  ${FAIL} ${pad(label)}${detail ? `  ${detail}` : ""}`); failed++; };
  const skip = (label: string, detail?: string) => { console.log(`  ${SKIP} ${pad(label)}${detail ? `  ${detail}` : ""}`); };

  // 1. Reachability
  try {
    const res = await fetch(`${flairUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.status < 500) { ok("reachable", `HTTP ${res.status}`); }
    else { fail("reachable", `HTTP ${res.status}`); }
  } catch (err: any) {
    fail("reachable", err.message ?? String(err));
    console.log(`\n  Flair is unreachable — remaining checks skipped.\n`);
    process.exit(1);
  }

  // Build client
  let client: ReturnType<typeof createFlairClient>;
  try {
    client = createFlairClient(agentId, flairUrl, keyPath);
  } catch (err: any) {
    fail("auth client", err.message ?? String(err));
    process.exit(1);
  }

  // 2. Memory write
  const testId      = `${agentId}-health-${Date.now()}`;
  const testContent = "Flair health check probe — safe to delete";
  try {
    await client.writeMemory(testId, testContent, { durability: "ephemeral", type: "health-check" });
    ok("memory write", testId);
  } catch (err: any) {
    fail("memory write", err.message ?? String(err));
    skip("memory read-back");
    skip("semantic search");
    skip("memory cleanup");
    summarize(passed, failed);
    return;
  }

  // 3. Read-back
  try {
    const mem = await client.getMemory(testId);
    if (mem?.content === testContent) { ok("memory read-back", "content matches"); }
    else { fail("memory read-back", `unexpected: ${JSON.stringify(mem?.content)}`); }
  } catch (err: any) {
    fail("memory read-back", err.message ?? String(err));
  }

  // Allow time for embedding to be computed
  await new Promise((r) => setTimeout(r, 2000));

  // 4. Semantic search
  try {
    const results = await client.search("health check probe", 10);
    const hit = results.find((r: any) => r.id === testId || r.memory?.id === testId);
    if (hit) {
      const score = (hit as any).score ?? (hit as any).similarity ?? "?";
      ok("semantic search", `hit found  score=${score}`);
    } else if (results.length === 0) {
      fail("semantic search", "0 results — embeddings may not be initialized");
    } else {
      fail("semantic search", `${results.length} results but test memory missing — check embedding pipeline`);
      if (opts.verbose) {
        const ids = results.slice(0, 3).map((r: any) => r.id ?? r.memory?.id).join(", ");
        console.log(`    top results: ${ids}`);
      }
    }
  } catch (err: any) {
    fail("semantic search", err.message ?? String(err));
  }

  // 5. Cleanup
  try {
    await client.request("DELETE", `/Memory/${testId}`);
    ok("memory cleanup");
  } catch {
    skip("memory cleanup", "(non-fatal)");
  }

  summarize(passed, failed);
}

function summarize(passed: number, failed: number): void {
  const total = passed + failed;
  console.log(`\n  ${passed}/${total} checks passed\n`);
  if (failed > 0) { console.error(`  Flair is degraded.\n`); process.exit(1); }
  else             { console.log(`  Flair is healthy.\n`);                     }
}
