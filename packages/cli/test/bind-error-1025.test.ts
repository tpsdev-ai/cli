import { expect, test } from "bun:test";
import net from "node:net";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { generateKeyPair } from "../src/utils/identity.js";
import { listenOn } from "../src/utils/listen-on.js";
import { listenForHostWs } from "../src/utils/ws-noise-transport.js";
import { startServiceProxies } from "../src/utils/service-proxy-branch.js";
import { OpenClawAdapter } from "../src/bridge/openclaw-adapter.js";
import { startMockLLM } from "../src/soundstage/mock-llm.js";

/** Bind a listener so the port is genuinely taken, and return it with its port. */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("a bind failure rejects listenForHostWs and raises no uncaught error", async () => {
  const occupied = await occupyPort();
  const uncaught: string[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error instanceof Error ? error.message : String(error));
  };
  process.on("uncaughtException", onUncaught);
  let outcome: "pending" | "resolved" | { rejection: unknown } = "pending";
  try {
    const branch = generateKeyPair();
    const host = generateKeyPair();
    outcome = await Promise.race([
      listenForHostWs(branch, host.encryption.publicKey, occupied.port, () => {}).then(
        () => "resolved" as const,
        (rejection: unknown) => ({ rejection })
      ),
      Bun.sleep(5_000).then(() => "pending" as const),
    ]);
    // Give a late, detached emitter a turn to surface before asserting.
    await Bun.sleep(50);
  } finally {
    process.off("uncaughtException", onUncaught);
    await occupied.close();
  }

  expect(uncaught).toEqual([]);
  expect(outcome).not.toBe("pending");
  expect(outcome).not.toBe("resolved");
  const rejection = (outcome as { rejection: unknown }).rejection;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
});

test("a bind failure rejects startServiceProxies and raises no uncaught error", async () => {
  const occupied = await occupyPort();
  const uncaught: string[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error instanceof Error ? error.message : String(error));
  };
  process.on("uncaughtException", onUncaught);
  let outcome: "resolved" | { rejection: unknown } = "resolved";
  try {
    const channel = {
      onMessage: () => {},
      offMessage: () => {},
      send: async () => {},
      isAlive: () => true,
    };
    outcome = await startServiceProxies([{ name: "service-a", localPort: occupied.port }], channel as never).then(
      () => "resolved" as const,
      (rejection: unknown) => ({ rejection })
    );
    await Bun.sleep(50);
  } finally {
    process.off("uncaughtException", onUncaught);
    await occupied.close();
  }

  expect(uncaught).toEqual([]);
  expect(outcome).not.toBe("resolved");
  const rejection = (outcome as { rejection: unknown }).rejection;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
});

test("a bind failure rejects OpenClawAdapter.start and raises no uncaught error", async () => {
  const occupied = await occupyPort();
  const uncaught: string[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error instanceof Error ? error.message : String(error));
  };
  process.on("uncaughtException", onUncaught);
  let outcome: "resolved" | { rejection: unknown } = "resolved";
  const adapter = new OpenClawAdapter({ port: occupied.port });
  try {
    outcome = await adapter.start(() => "agent-a").then(
      () => "resolved" as const,
      (rejection: unknown) => ({ rejection })
    );
    await Bun.sleep(50);
  } finally {
    process.off("uncaughtException", onUncaught);
    await occupied.close();
    await adapter.stop();
  }

  expect(uncaught).toEqual([]);
  expect(outcome).not.toBe("resolved");
  const rejection = (outcome as { rejection: unknown }).rejection;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
});

test("a bind failure rejects startMockLLM and raises no uncaught error", async () => {
  const occupied = await occupyPort();
  const uncaught: string[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error instanceof Error ? error.message : String(error));
  };
  process.on("uncaughtException", onUncaught);
  let outcome: "resolved" | { rejection: unknown } = "resolved";
  try {
    outcome = await startMockLLM(occupied.port).then(
      () => "resolved" as const,
      (rejection: unknown) => ({ rejection })
    );
    await Bun.sleep(50);
  } finally {
    process.off("uncaughtException", onUncaught);
    await occupied.close();
  }

  expect(uncaught).toEqual([]);
  expect(outcome).not.toBe("resolved");
  const rejection = (outcome as { rejection: unknown }).rejection;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
});

test("an error after a successful bind runs the listener's failure path once", async () => {
  const uncaught: string[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error instanceof Error ? error.message : String(error));
  };
  const httpServer = createServer((_req, res) => res.end());
  const wss = new WebSocketServer({ server: httpServer });
  const failures: string[] = [];
  let closed = false;
  process.on("uncaughtException", onUncaught);
  try {
    await listenOn(httpServer, 0, {
      host: "127.0.0.1",
      also: wss,
      onError: (error) => {
        failures.push(error.message);
        closed = true;
        httpServer.close();
      },
    });
    httpServer.emit("error", new Error("after bind"));
    await Bun.sleep(50);
  } finally {
    process.off("uncaughtException", onUncaught);
    wss.close();
    if (httpServer.listening) httpServer.close();
  }

  expect(uncaught).toEqual([]);
  expect(failures).toEqual(["after bind"]);
  expect(closed).toBe(true);
});
