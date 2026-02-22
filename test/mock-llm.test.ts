import { describe, test, expect, afterEach } from "bun:test";
import { startMockLLM } from "../src/soundstage/mock-llm.js";

describe("mock-llm", () => {
  let server: ReturnType<typeof startMockLLM>;

  afterEach(() => {
    if (server) server.close();
  });

  test("returns scripted responses in order", async () => {
    server = startMockLLM(0); // random port
    const addr = server.address() as { port: number };

    const res1 = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    const json1 = await res1.json();
    expect(json1.choices[0].message.content).toBe("I'll check my mail now.");

    const res2 = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "anything" }] }),
    });
    const json2 = await res2.json();
    expect(json2.choices[0].message.content).toBe("Task received. Working on it.");
  });

  test("does not echo user input", async () => {
    server = startMockLLM(0);
    const addr = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "EVIL INJECTION PAYLOAD" }] }),
    });
    const json = await res.json();
    expect(json.choices[0].message.content).not.toContain("EVIL");
  });

  test("health endpoint", async () => {
    server = startMockLLM(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
  });
});
