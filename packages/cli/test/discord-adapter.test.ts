import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { DiscordAdapter } from "../src/bridge/discord-adapter.js";

describe("DiscordAdapter", () => {
  let fetchMock: ReturnType<typeof mock>;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchMock = mock(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      // Seed call (limit=1, no after)
      if (u.includes("limit=1") && !u.includes("after=")) {
        return { ok: true, json: async () => [{ id: "1000", author: { bot: false, id: "u1", username: "Alice" }, content: "hi", timestamp: "2026-01-01T00:00:00Z", guild_id: "g1" }] };
      }
      // Poll call (after=1000) — one new message
      if (u.includes("after=1000")) {
        return { ok: true, json: async () => [{ id: "1001", author: { bot: false, id: "u2", username: "Bob" }, content: "hello", timestamp: "2026-01-01T00:01:00Z", guild_id: "g1" }] };
      }
      // Subsequent polls — empty
      return { ok: true, json: async () => [] };
    });
    globalThis.fetch = fetchMock as any;
  });

  test("seeds lastMessageId on start and delivers new messages", async () => {
    const adapter = new DiscordAdapter({ token: "tok", channelId: "chan1", pollIntervalMs: 999999, requireMention: false });
    const received: any[] = [];
    await adapter.start((env) => { received.push(env); return "ok"; });

    // Trigger a poll manually
    await (adapter as any).poll();

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("hello");
    expect(received[0].senderName).toBe("Bob");

    await adapter.stop();
  });

  test("skips bot messages", async () => {
    fetchMock = mock(async () => ({
      ok: true,
      json: async () => [{ id: "1002", author: { bot: true, id: "b1", username: "BotUser" }, content: "I am a bot", timestamp: "2026-01-01T00:02:00Z", guild_id: "g1" }],
    }));
    globalThis.fetch = fetchMock as any;

    const adapter = new DiscordAdapter({ token: "tok", channelId: "chan2", pollIntervalMs: 999999, requireMention: false });
    const received: any[] = [];
    await adapter.start((env) => { received.push(env); return "ok"; });
    await (adapter as any).poll();

    expect(received).toHaveLength(0);
    await adapter.stop();
  });

  test("send posts to Discord API", async () => {
    const posts: any[] = [];
    fetchMock = mock(async (url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") posts.push({ url, body: opts.body });
      return { ok: true, json: async () => [] };
    });
    globalThis.fetch = fetchMock as any;

    const adapter = new DiscordAdapter({ token: "tok", channelId: "chan3", pollIntervalMs: 999999, requireMention: false });
    await adapter.start(() => "ok");
    await adapter.send({ channel: "discord", channelId: "chan3", senderId: "s1", senderName: "Ember", content: "Done!", timestamp: new Date().toISOString() });

    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body as string).content).toBe("Done!");
    await adapter.stop();
  });
});
