/**
 * Port allocation for tests, in one place (cli#1025).
 *
 * A test that asks the OS for a free port (bind 0, read the port, close) and
 * then binds that port later leaves a gap: anything can take the port in
 * between. A test that starts a listener in-process therefore binds port 0 and
 * reads back the port it reports. A start that needs a preselected port for a
 * child process goes through `withPortsRetry`, which tries again with a new
 * port when the child reports EADDRINUSE; a child that accepts port 0 through
 * its own config needs neither.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";

/** How many starts `withPortsRetry` attempts before it gives up with the last error. */
export const PORT_ATTEMPTS = 5;

/** True when `error` reports that the address was already in use. */
export function isAddressInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EADDRINUSE";
}

/** Address-in-use text a child writes to its output. */
const ADDRESS_IN_USE_TEXT = /EADDRINUSE|Is port \d+ in use\?|address already in use/i;

/**
 * The bind failure a child reported in its output, as an error that
 * `withPortsRetry` will retry on; undefined while the output names none.
 */
export function bindErrorIn(output: string): (Error & { code: string }) | undefined {
  if (!ADDRESS_IN_USE_TEXT.test(output)) return undefined;
  return Object.assign(new Error(output), { code: "EADDRINUSE" });
}

/** Ask the OS for a loopback port by binding port 0, then close that socket. */
async function pickPort(): Promise<number> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** The port an in-process listener reports it is bound to. */
export function boundPort(server: { port?: () => number }, what = "listener"): number {
  const port = server.port?.();
  if (!port) throw new Error(`${what} did not report its bound port`);
  return port;
}

/** The port a node server is bound to, once it is listening. */
export function listeningPort(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not bound to a TCP port");
  return (address as AddressInfo).port;
}

/**
 * Wait (bounded) until `read` reports a non-zero port, then return it. For a
 * listener started in-process with port 0, which reports the port it got.
 */
export async function waitForBoundPort(read: () => number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const port = read();
    if (port > 0) return port;
    if (Date.now() >= deadline) throw new Error("listener did not report its bound port");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface PortRetryOptions {
  /** How many starts are attempted before the last error is thrown. */
  attempts?: number;
  /** Which failures are retried; address-in-use only, unless a caller says otherwise. */
  retryOn?: (error: unknown) => boolean;
  /** A port the first attempt starts on, so a case can make that attempt lose
   *  the port on purpose and show the second attempt succeeding. */
  firstPort?: number;
}

/**
 * Start something that binds ports from config: choose the ports, run
 * `start`, and when it fails because a port was taken, choose again and start
 * again. The #889 shape — the ports are never assumed to still be free at bind
 * time; the retry is what covers the gap between choosing and binding.
 *
 * `start` must reject with the bind failure (an error naming EADDRINUSE). With
 * the default predicate any other failure propagates at once; a caller can
 * pass `retryOn` to retry a different failure (the heartbeat test does).
 */
export async function withPortsRetry<T>(
  count: number,
  start: (ports: number[]) => Promise<T>,
  options: PortRetryOptions = {},
): Promise<{ ports: number[]; result: T }> {
  const attempts = options.attempts ?? PORT_ATTEMPTS;
  const retryOn = options.retryOn ?? isAddressInUse;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ports: number[] = [];
    if (attempt === 0 && options.firstPort !== undefined) ports.push(options.firstPort);
    while (ports.length < count) {
      const port = await pickPort();
      if (!ports.includes(port)) ports.push(port);
    }
    try {
      return { ports, result: await start(ports) };
    } catch (error) {
      if (!retryOn(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Hold a port for the life of a case, so that binding it on the wildcard
 *  address or on loopback fails with EADDRINUSE. On darwin a listener on
 *  0.0.0.0 does not stop a bind to 127.0.0.1 on the same port, or the
 *  reverse, so the holder binds both; where the wildcard listener already
 *  blocks loopback (Linux), the loopback bind fails with EADDRINUSE and is
 *  skipped. Like a real listener, it keeps accepted sockets open; `close`
 *  destroys them and the servers. */
export async function holdPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  const bind = async (port: number, host: string): Promise<net.Server> => {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    servers.push(server);
    return server;
  };
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  };
  try {
    const port = listeningPort(await bind(0, "0.0.0.0"));
    try {
      await bind(port, "127.0.0.1");
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
    return { port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** `withPortsRetry` for the common one-port case. */
export async function withPortRetry<T>(
  start: (port: number) => Promise<T>,
  options: PortRetryOptions = {},
): Promise<{ port: number; result: T }> {
  const { ports, result } = await withPortsRetry(1, (ports) => start(ports[0]!), options);
  return { port: ports[0]!, result };
}

/**
 * Wait (bounded) until `port` accepts a connection, checking `failure` on each
 * turn: when the thing being started writes an address-in-use error where
 * `failure` reads it, that error is thrown at once, so the caller's retry does
 * not wait out the whole deadline.
 */
export async function waitForListening(
  port: number,
  options: { timeoutMs?: number; failure?: () => unknown; settleMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const settleMs = options.settleMs ?? 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failure = options.failure?.();
    if (failure) throw failure;
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => {
        if (settleMs === 0) return finish(true);
        const timer = setTimeout(() => finish(true), settleMs);
        socket.once("close", () => {
          clearTimeout(timer);
          finish(false);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          finish(false);
        });
      });
      socket.once("error", () => finish(false));
    });
    if (connected) return;
    if (Date.now() >= deadline) throw new Error(`nothing is listening on 127.0.0.1:${port} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
