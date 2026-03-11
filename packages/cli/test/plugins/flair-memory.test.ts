import { describe, expect, it, mock } from "bun:test";
import { FlairMemoryProvider } from "../../src/plugins/flair-memory.js";

function makeClient() {
  return {
    search: mock(async (_q: string, _limit = 5) => [{ id: "m1", content: "hello", agentId: "flint", _score: 0.9 }]),
    writeMemory: mock(async (_id: string, _content: string, _opts: unknown) => {}),
    getMemory: mock(async (id: string) => ({ id, content: "hello", agentId: "flint", durability: "standard", tags: ["a"] })),
    bootstrap: mock(async () => "bootstrapped"),
    ping: mock(async () => true),
  };
}

describe("FlairMemoryProvider", () => {
  it("delegates search/read/bootstrap/ping to FlairClient", async () => {
    const client = makeClient();
    const provider = new FlairMemoryProvider(client as any);

    await expect(provider.search("hello", 3)).resolves.toEqual([{ id: "m1", text: "hello", agentId: "flint", similarity: 0.9, createdAt: undefined }]);
    await expect(provider.read("m1")).resolves.toMatchObject({ id: "m1", text: "hello", agentId: "flint" });
    await expect(provider.bootstrap()).resolves.toBe("bootstrapped");
    await expect(provider.ping()).resolves.toBe(true);

    expect(client.search).toHaveBeenCalledWith("hello", 3);
    expect(client.getMemory).toHaveBeenCalledWith("m1");
    expect(client.bootstrap).toHaveBeenCalled();
    expect(client.ping).toHaveBeenCalled();
  });

  it("delegates writes to FlairClient.writeMemory", async () => {
    const client = makeClient();
    const provider = new FlairMemoryProvider(client as any);

    const result = await provider.write({ text: "ship it", agentId: "anvil", durability: "persistent", type: "fact", tags: ["x"] });

    expect(result.id).toBeString();
    expect(client.writeMemory).toHaveBeenCalledTimes(1);
  });
});
