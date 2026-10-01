// cli#444 — the codex runtime records liveness on Flair's Presence resource and
// NEVER writes the agent's own Agent row: in Flair `Agent.status` is the
// principal's lifecycle state, so an `"offline"` write DEACTIVATES the agent
// (its requests are then refused with `401 principal_deactivated`).
//
// These tests use a fake Flair client that records every call it receives, so
// a stray PATCH/PUT to `/Agent/<id>` would show up directly.
import { describe, expect, it } from "bun:test";
import { publishRuntimePresence, runtimeShutdownBeat } from "../src/utils/codex-runtime.js";
import { FlairClient } from "../src/utils/flair-client.js";

/** A fake Flair client that records every call it receives. */
function fakeClient(opts: { presenceThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async presence(activity?: string) {
        calls.push(`PRESENCE ${activity ?? "(liveness)"}`);
        if (opts.presenceThrows) throw new Error("presence down");
      },
      async request(method: string, path: string) {
        calls.push(`${method} ${path}`);
        return undefined;
      },
    },
  };
}

describe("codex runtime presence (cli#444)", () => {
  it(
    "issues a Presence write on start and on shutdown, and NO /Agent PATCH or PUT",
    async () => {
      const { calls, client } = fakeClient();
      // start: the runtime's first heartbeat tick (and every 5min after).
      await publishRuntimePresence(client as never, "testbot");
      // shutdown: the signal handler's final beat.
      await runtimeShutdownBeat(client as never, "testbot");

      expect(calls).toEqual(["PRESENCE (liveness)", "PRESENCE idle"]);
      expect(calls.some((c) => /^(PATCH|PUT) \/Agent\//.test(c))).toBe(false);
    },
    10_000,
  );

  it(
    "a Presence failure only logs — it never throws and never falls back to /Agent",
    async () => {
      const { calls, client } = fakeClient({ presenceThrows: true });
      await publishRuntimePresence(client as never, "testbot");
      await runtimeShutdownBeat(client as never, "testbot");

      // Both beats were attempted; neither fell back to an Agent write.
      expect(calls).toEqual(["PRESENCE (liveness)", "PRESENCE idle"]);
      expect(calls.some((c) => c.includes("/Agent/"))).toBe(false);
    },
    10_000,
  );

  it(
    "FlairClient.presence POSTs /Presence (and nothing on /Agent)",
    async () => {
      const client = new FlairClient({ baseUrl: "http://127.0.0.1:9", agentId: "testbot", keyPath: "/nonexistent" });
      const calls: string[] = [];
      // Spy the request the method builds; the signer/key path is exercised in
      // the client's own tests.
      (client as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> }).request =
        async (method: string, path: string, body?: unknown) => {
          calls.push(`${method} ${path} ${JSON.stringify(body)}`);
          return undefined;
        };

      await client.presence("idle");
      expect(calls).toEqual(['POST /Presence {"activity":"idle"}']);

      await client.presence("coding", "triage");
      expect(calls[1]).toBe('POST /Presence {"activity":"coding","currentTask":"triage"}');
      expect(calls.some((c) => c.includes("/Agent/"))).toBe(false);
    },
    10_000,
  );
});
