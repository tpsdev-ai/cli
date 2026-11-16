import { expect, test } from "bun:test";
import net from "node:net";
import * as http from "node:http";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { SnoopLogg } from "snooplogg";
import { generateKeyPair, registerBranch } from "../src/utils/identity.js";
import { listenOn } from "../src/utils/listen-on.js";
import { listenForHostWs, listenForJoinWs, WsNoiseTransport } from "../src/utils/ws-noise-transport.js";
import { startServiceProxies } from "../src/utils/service-proxy-branch.js";
import { OpenClawAdapter } from "../src/bridge/openclaw-adapter.js";
import { startMockLLM } from "../src/soundstage/mock-llm.js";
import { boundPort } from "./helpers/port.js";
import { createPatchShared } from "./helpers/patch-shared.js";

const patchShared = createPatchShared();

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

/** Record the HTTP servers that bind a port until `restore` is called. */
function watchBinds(): { servers: Server[]; restore: () => void } {
  const servers: Server[] = [];
  const proto = http.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown };
  const original = proto.listen;
  const restore = patchShared(proto, "listen", function (this: Server, ...args: unknown[]) {
    if (!servers.includes(this)) servers.push(this);
    return original.apply(this, args);
  });
  return { servers, restore };
}

/** Collect uncaught exceptions for the duration of a test. */
function trackUncaught(): { errors: string[]; stop: () => void } {
  const errors: string[] = [];
  const onUncaught = (error: unknown) => {
    errors.push(error instanceof Error ? error.message : String(error));
  };
  process.on("uncaughtException", onUncaught);
  return { errors, stop: () => process.off("uncaughtException", onUncaught) };
}

/** Collect the `tps:ws` warnings (the WS listeners' own log lines). */
function captureWarnings(): { text: () => string; stop: () => void } {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  const logger = new SnoopLogg().enable("tps:ws").snoop().pipe(output, { colors: false });
  return {
    text: () => text,
    stop: () => {
      logger.unsnoop().unpipe(output);
    },
  };
}

/** Collect `console.error` lines for the duration of a test. */
function captureConsoleError(): { lines: () => string[]; stop: () => void } {
  const lines: string[] = [];
  const restore = patchShared(console, "error", (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  return { lines: () => lines, stop: restore };
}

/** Record the timers created with `delayMs` that are still armed. */
function watchTimers(delayMs: number): { live: Set<unknown>; stop: () => void } {
  const live = new Set<unknown>();
  const timers = globalThis as unknown as {
    setTimeout: (handler: TimerHandler, ms?: number, ...args: unknown[]) => unknown;
    clearTimeout: (handle?: unknown) => void;
  };
  const realSetTimeout = timers.setTimeout;
  const realClearTimeout = timers.clearTimeout;
  const restoreSet = patchShared(timers, "setTimeout", (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const tracked = ms === delayMs && typeof handler === "function";
    let handle: unknown;
    handle = realSetTimeout(
      tracked
        ? (...timerArgs: unknown[]) => {
            live.delete(handle);
            (handler as (...callbackArgs: unknown[]) => void)(...timerArgs);
          }
        : handler,
      ms,
      ...args,
    );
    if (tracked) live.add(handle);
    return handle;
  });
  const restoreClear = patchShared(timers, "clearTimeout", (handle?: unknown) => {
    if (handle !== undefined) live.delete(handle);
    realClearTimeout(handle);
  });
  return {
    live,
    stop: () => {
      restoreSet();
      restoreClear();
    },
  };
}

/** Wait (bounded) until `predicate` holds. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition not reached in ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
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
        (rejection: unknown) => ({ rejection }),
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

test("a bind failure rejects WsNoiseTransport.listen and raises no uncaught error", async () => {
  const occupied = await occupyPort();
  const host = generateKeyPair();
  const uncaught = trackUncaught();
  let outcome: "resolved" | { rejection: unknown } = "resolved";
  try {
    outcome = await new WsNoiseTransport(host, host).listen(occupied.port).then(
      () => "resolved" as const,
      (rejection: unknown) => ({ rejection }),
    );
    await Bun.sleep(50);
  } finally {
    uncaught.stop();
    await occupied.close();
  }

  expect(uncaught.errors).toEqual([]);
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
      (rejection: unknown) => ({ rejection }),
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
      (rejection: unknown) => ({ rejection }),
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
      (rejection: unknown) => ({ rejection }),
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
    // A server and the WebSocketServer over it report one error twice; the
    // second emission is consumed without running the failure path again.
    httpServer.emit("error", new Error("after bind again"));
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

test("a post-bind error runs listenForHostWs's failure path", async () => {
  const branch = generateKeyPair();
  const host = generateKeyPair();
  const warnings = captureWarnings();
  const uncaught = trackUncaught();
  const watch = watchBinds();
  let listener: Awaited<ReturnType<typeof listenForHostWs>> | undefined;
  let text = "";
  try {
    listener = await listenForHostWs(branch, host.encryption.publicKey, 0, () => {});
    const server = watch.servers[0]!;
    server.emit("error", new Error("post-bind"));
    await until(() => !server.listening);
  } finally {
    watch.restore();
    text = warnings.text();
    warnings.stop();
    uncaught.stop();
    await listener?.close();
  }

  expect(uncaught.errors).toEqual([]);
  expect(text).toContain("[host] listener error after bind: post-bind");
}, 10_000);

test("a post-bind error runs WsNoiseTransport.listen's failure path", async () => {
  const host = generateKeyPair();
  const warnings = captureWarnings();
  const uncaught = trackUncaught();
  const watch = watchBinds();
  let listener: Awaited<ReturnType<WsNoiseTransport["listen"]>> | undefined;
  let text = "";
  try {
    listener = await new WsNoiseTransport(host, host).listen(0);
    const server = watch.servers[0]!;
    server.emit("error", new Error("post-bind"));
    await until(() => !server.listening);
  } finally {
    watch.restore();
    text = warnings.text();
    warnings.stop();
    uncaught.stop();
    await listener?.close();
  }

  expect(uncaught.errors).toEqual([]);
  expect(text).toContain("[listen] server error after bind: post-bind");
}, 10_000);

test("a post-bind error rejects the pending join and clears its timer", async () => {
  const branch = generateKeyPair();
  const warnings = captureWarnings();
  const uncaught = trackUncaught();
  const watch = watchBinds();
  const timers = watchTimers(5_000);
  let bound = false;
  const joined = listenForJoinWs(branch, 0, 5_000, () => {
    bound = true;
  });
  let rejection: unknown;
  let text = "";
  let server: Server | undefined;
  try {
    joined.catch(() => {});
    await until(() => bound);
    server = watch.servers[0]!;
    server.emit("error", new Error("post-bind"));
    rejection = await joined.then(() => undefined, (error: unknown) => error);
    await until(() => !server.listening);
  } finally {
    watch.restore();
    timers.stop();
    if (server?.listening) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    text = warnings.text();
    warnings.stop();
    uncaught.stop();
  }

  expect(uncaught.errors).toEqual([]);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe("post-bind");
  expect(text).toContain("[join] listener error after bind: post-bind");
  expect(timers.live.size).toBe(0);
}, 10_000);

test("a bind failure rejects listenForJoinWs and clears its join timer", async () => {
  const occupied = await occupyPort();
  const branch = generateKeyPair();
  const timers = watchTimers(120_000);
  const uncaught = trackUncaught();
  let rejection: unknown;
  try {
    rejection = await listenForJoinWs(branch, occupied.port).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    timers.stop();
    uncaught.stop();
  }
  await occupied.close();

  expect(uncaught.errors).toEqual([]);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
  expect(timers.live.size).toBe(0);
}, 10_000);

test("a post-bind error runs startServiceProxies's failure path", async () => {
  const consoleErrors = captureConsoleError();
  const uncaught = trackUncaught();
  const watch = watchBinds();
  let proxies: Awaited<ReturnType<typeof startServiceProxies>> | undefined;
  let lines: string[] = [];
  try {
    const channel = {
      onMessage: () => {},
      offMessage: () => {},
      send: async () => {},
      isAlive: () => true,
    };
    proxies = await startServiceProxies([{ name: "service-a", localPort: 0 }], channel as never);
    const server = watch.servers[0]!;
    server.emit("error", new Error("post-bind"));
    await until(() => !server.listening);
  } finally {
    watch.restore();
    lines = consoleErrors.lines();
    consoleErrors.stop();
    uncaught.stop();
    proxies?.close();
  }

  expect(uncaught.errors).toEqual([]);
  expect(lines).toContain("Service proxy 'service-a' listener failed: post-bind");
}, 10_000);

test("a post-bind error runs OpenClawAdapter.start's failure path", async () => {
  const logs: string[] = [];
  const uncaught = trackUncaught();
  const watch = watchBinds();
  const adapter = new OpenClawAdapter({ port: 0 }, (message) => logs.push(message));
  try {
    await adapter.start(() => "agent-a");
    const server = watch.servers[0]!;
    server.emit("error", new Error("post-bind"));
    await until(() => !server.listening);
  } finally {
    watch.restore();
    uncaught.stop();
    await adapter.stop();
  }

  expect(uncaught.errors).toEqual([]);
  expect(logs.some((line) => line.includes("[openclaw] listener failed: post-bind"))).toBe(true);
}, 10_000);

test("a post-bind error runs startMockLLM's failure path", async () => {
  const consoleErrors = captureConsoleError();
  const uncaught = trackUncaught();
  let server: Server | undefined;
  try {
    server = await startMockLLM(0);
    server.emit("error", new Error("post-bind"));
    await until(() => !server!.listening);
  } finally {
    consoleErrors.stop();
    uncaught.stop();
    if (server?.listening) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  }

  expect(uncaught.errors).toEqual([]);
  expect(consoleErrors.lines()).toContain("Mock LLM listener failed: post-bind");
}, 10_000);

test("service proxies roll back over a real transport channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "tps-bind-error-"));
  const savedHome = process.env.HOME;
  const savedVault = process.env.TPS_VAULT_KEY;
  const savedIdentity = process.env.TPS_IDENTITY_DIR;
  const savedRegistry = process.env.TPS_REGISTRY_DIR;
  process.env.HOME = root;
  process.env.TPS_VAULT_KEY = "test-passphrase";
  process.env.TPS_IDENTITY_DIR = join(root, ".tps", "identity");
  process.env.TPS_REGISTRY_DIR = join(root, ".tps", "registry");

  const host = generateKeyPair();
  const branch = generateKeyPair();
  registerBranch("branch-a", branch.signing.publicKey, undefined, branch.encryption.publicKey);

  const hostTransport = new WsNoiseTransport(host, host);
  let listener: Awaited<ReturnType<WsNoiseTransport["listen"]>> | undefined;
  let watch: ReturnType<typeof watchBinds> | undefined;
  let client: WsNoiseTransport | undefined;
  let proxies: Awaited<ReturnType<typeof startServiceProxies>> | undefined;
  const occupied = await occupyPort();
  try {
    listener = await hostTransport.listen(0);
    watch = watchBinds();
    const port = boundPort(listener);
    const received: string[] = [];
    listener.onConnection((channel) => {
      channel.onMessage((message) => {
        received.push((message.body as { text: string }).text);
      });
    });

    client = new WsNoiseTransport(branch);
    const channel = await client.connect({
      host: "127.0.0.1",
      port,
      branchId: "branch-a",
      hostPublicKey: host.encryption.publicKey,
    });

    // The proxies start over the real channel.
    proxies = await startServiceProxies([{ name: "service-a", localPort: 0 }], channel);
    expect(proxies.handles).toHaveLength(1);
    const firstProxy = watch.servers[0]!;
    await until(() => firstProxy.listening);

    // A later proxy's port is taken: the start rejects, and the proxies it had
    // already bound are removed.
    const rejection = await startServiceProxies(
      [
        { name: "service-b", localPort: 0 },
        { name: "service-c", localPort: occupied.port },
      ],
      channel,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    const rolledBack = watch.servers[1]!;
    await until(() => !rolledBack.listening);
    expect(firstProxy.listening).toBe(true);

    // The channel still carries a message after the rollback.
    await channel.send({ type: 1, seq: 1, ts: new Date().toISOString(), body: { text: "after-rollback" } });
    await until(() => received.includes("after-rollback"));

    await channel.close();
  } finally {
    watch?.restore();
    await occupied.close();
    proxies?.close();
    client?.close();
    await listener?.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedVault === undefined) delete process.env.TPS_VAULT_KEY;
    else process.env.TPS_VAULT_KEY = savedVault;
    if (savedIdentity === undefined) delete process.env.TPS_IDENTITY_DIR;
    else process.env.TPS_IDENTITY_DIR = savedIdentity;
    if (savedRegistry === undefined) delete process.env.TPS_REGISTRY_DIR;
    else process.env.TPS_REGISTRY_DIR = savedRegistry;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
