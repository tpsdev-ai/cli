import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlairClient } from "../src/utils/flair-client.js";
import { createPatchShared } from "./helpers/patch-shared.js";

const patchShared = createPatchShared();
const credential = "Authorization=Basic b3BlcmF0b3I6c2VjcmV0";
const throwsCredential = () => { throw new Error(credential); };
const throwingProxy = () => new Proxy({}, { get: throwsCredential });

const rejections: Array<{ name: string; value: () => unknown }> = [
  { name: "throwing cause getter", value: () => ({ get cause() { return throwsCredential(); } }) },
  { name: "throwing code getter", value: () => ({ get code() { return throwsCredential(); } }) },
  { name: "throwing proxy", value: throwingProxy },
  { name: "throwing cause code getter", value: () => ({ cause: { get code() { return throwsCredential(); } } }) },
  { name: "throwing cause proxy", value: () => ({ cause: throwingProxy() }) },
  { name: "known code with throwing cause getter", value: () => ({ code: "ECONNREFUSED", get cause() { return throwsCredential(); } }) },
  { name: "string rejection", value: () => credential },
  { name: "null rejection", value: () => null },
  { name: "callable rejection with ECONNREFUSED code", value: () => Object.assign(() => {}, { code: "ECONNREFUSED" }) },
];

let workDir: string;
let client: FlairClient;
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "flair-transport-inspection-"));
  const keyPath = join(workDir, "agent.key");
  writeFileSync(keyPath, Buffer.alloc(32, 0x7a));
  client = new FlairClient({ baseUrl: "http://flair.invalid", agentId: "agent-a", keyPath });
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const entries = [
  { name: "request", method: "GET", path: "/Memory/mem-1", call: () => client.request("GET", "/Memory/mem-1") },
  { name: "registerAgent", method: "PUT", path: "/Agent/agent-a", call: () => client.registerAgent("Agent A", "public-key", "operator:secret") },
  { name: "readStoredPublicKey", method: "GET", path: "/Agent/agent-a", call: () => client.readStoredPublicKey("agent-a", "operator:secret") },
];

for (const entry of entries) {
  describe(entry.name, () => {
    for (const rejection of rejections) {
      test(`${rejection.name} yields the fixed network failure message`, async () => {
        const restore = patchShared(globalThis, "fetch", (async () => {
          throw rejection.value();
        }) as typeof fetch);
        try {
          let caught: unknown;
          try {
            await entry.call();
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(Error);
          const error = caught as Error;
          expect(error.message).toBe(`Flair ${entry.name} ${entry.method} ${entry.path} transport error: network failure`);
          expect(error.stack).not.toContain(credential);
          expect(error.cause).toBeUndefined();
        } finally {
          restore();
        }
      });
    }
  });
}
