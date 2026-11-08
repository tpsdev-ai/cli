import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "heartbeat-post-rpc-"));
const binDir = join(root, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "openclaw"), `#!/usr/bin/env node
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 10_000);
`, { mode: 0o755 });
const heartbeat = join(root, "heartbeat.mjs");
const heartbeatStatus = Number(process.argv[4] ?? 0);
writeFileSync(heartbeat, `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.env.HOME, ".tps", "status", "nodes");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "agent-a.json"), JSON.stringify({ status: "online", errors: [] }));
console.log("Heartbeat for agent-a: online");
process.exit(${heartbeatStatus});
`);
process.env.TPS_HEARTBEAT_BIN = heartbeat;
const { runLiveCase } = await import(pathToFileURL(process.argv[2]).href);
let probes = 0;
try {
  await runLiveCase(root, binDir, {
    allocatePort: async () => 18999,
    probeTimeoutMs: 321,
    rpcTimeoutMs: 123,
    runStatus: ({ testCase, timeout, rpcTimeout }) => {
      probes++;
      if (probes === 1) {
        writeFileSync(join(testCase.dir, "gateway.log"), "POST_HEARTBEAT_GATEWAY_LOG\n");
        return { status: 0 };
      }
      assert.equal(probes, 2);
      assert.equal(JSON.parse(readFileSync(join(testCase.home, ".tps/status/nodes/agent-a.json"), "utf-8")).status, "online");
      assert.equal(timeout, 321);
      assert.equal(rpcTimeout, 123);
      return { status: Number(process.argv[3]), signal: null, stdout: "RPC_PROBE_STDOUT", stderr: "RPC_PROBE_STDERR" };
    },
  });
  console.log("POST_HEARTBEAT_ACCEPTED");
} catch (error) {
  console.log(`POST_HEARTBEAT_FAILED: ${error.message}`);
} finally {
  console.log(`STATUS_PROBES: ${probes}`);
  rmSync(root, { recursive: true, force: true });
}
