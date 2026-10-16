/**
 * cli#653 — the real-Flair lane's default listener checker, run against sockets
 * this file binds itself. The checker under test is the production
 * `assertLoopbackListeners` the lane installs; the `tool` argument forces one
 * discovery tool, so the lsof path and the ss path are each covered, and the
 * no-argument call is the lane's own entry point.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { assertLoopbackListeners, type DiscoveryTool, ScratchFlairBindError } from "./helpers/scratch-flair.js";

/** The no-argument entry, plus each discovery tool forced. */
type Mode = "default" | DiscoveryTool;

const MODES: Mode[] = ["default", "lsof", "ss"];

const VERSION_ARGS: Record<DiscoveryTool, string[]> = { lsof: ["-v"], ss: ["-V"] };

/** Whether `tool` can be executed here; a missing binary makes execFileSync throw ENOENT. */
function toolPresent(tool: DiscoveryTool): boolean {
  try {
    execFileSync(tool, VERSION_ARGS[tool], { stdio: "ignore" });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Bind a plain listener and report the port the OS chose. */
function listen(host: string, port: number, ipv6Only?: boolean): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(ipv6Only === undefined ? { host, port } : { host, port, ipv6Only }, () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    );
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Run the checker the way `mode` enters it. */
function check(mode: Mode, ports: number[]): void {
  if (mode === "default") assertLoopbackListeners(ports);
  else assertLoopbackListeners(ports, mode);
}

/**
 * Register a case for `mode`. A forced tool that is not installed skips, naming the reason; the
 * default entry needs at least one of the tools, so it skips, naming both, when neither is installed
 * (otherwise every refusal case would pass on the missing-tool error instead of a refusal).
 */
function caseFor(mode: Mode, name: string, fn: () => Promise<void> | void): void {
  if (mode === "default") {
    if (toolPresent("lsof") || toolPresent("ss")) test(`[${mode}] ${name}`, fn);
    else test.skip(`[${mode}] ${name} (skipped: neither lsof nor ss is installed)`, () => {});
  } else if (toolPresent(mode)) test(`[${mode}] ${name}`, fn);
  else test.skip(`[${mode}] ${name} (skipped: ${mode} is not installed)`, () => {});
}

/** A refusal that is the checker's own address verdict, never an error from running the tool. */
function expectBindRefusal(mode: Mode, ports: number[]): void {
  expect(() => check(mode, ports)).toThrow(ScratchFlairBindError);
}

/**
 * A port with no listener is refused: ss reports no address (a ScratchFlairBindError), and lsof
 * exits non-zero for an unbound port. Either way the refusal is never a missing-tool error.
 */
function expectNoListenerRefusal(mode: Mode, port: number): void {
  let thrown: unknown;
  try {
    check(mode, [port]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as NodeJS.ErrnoException).code).not.toBe("ENOENT");
}

for (const mode of MODES) {
  caseFor(mode, "accepts a loopback-only listener", async () => {
    const { server, port } = await listen("127.0.0.1", 0);
    try {
      expect(() => check(mode, [port])).not.toThrow();
    } finally {
      await close(server);
    }
  });

  caseFor(mode, "refuses a wildcard IPv4 listener", async () => {
    const { server, port } = await listen("0.0.0.0", 0);
    try {
      expectBindRefusal(mode, [port]);
    } finally {
      await close(server);
    }
  });

  caseFor(mode, "refuses a wildcard IPv6 listener", async () => {
    const { server, port } = await listen("::", 0, true);
    try {
      expectBindRefusal(mode, [port]);
    } finally {
      await close(server);
    }
  });

  caseFor(mode, "refuses a port held by a loopback and a wildcard listener", async () => {
    const loopback = await listen("127.0.0.1", 0);
    try {
      const wildcard = await listen("::", loopback.port, true);
      try {
        expectBindRefusal(mode, [loopback.port]);
      } finally {
        await close(wildcard.server);
      }
    } finally {
      await close(loopback.server);
    }
  });

  caseFor(mode, "refuses a port with no listener", async () => {
    const { server, port } = await listen("127.0.0.1", 0);
    await close(server);
    expectNoListenerRefusal(mode, port);
  });
}
