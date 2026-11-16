import { expect, test } from "bun:test";
import net from "node:net";
import { generateKeyPair } from "../src/utils/identity.js";
import { listenForHostWs } from "../src/utils/ws-noise-transport.js";

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
