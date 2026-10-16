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
import { assertLoopbackListeners, type DiscoveryTool } from "./helpers/scratch-flair.js";

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

/** Register a case for `mode`; a forced tool that is not installed skips, naming the reason. */
function caseFor(mode: Mode, name: string, fn: () => Promise<void> | void): void {
  if (mode === "default" || toolPresent(mode)) test(`[${mode}] ${name}`, fn);
  else test.skip(`[${mode}] ${name} (skipped: ${mode} is not installed)`, () => {});
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
      expect(() => check(mode, [port])).toThrow();
    } finally {
      await close(server);
    }
  });

  caseFor(mode, "refuses a wildcard IPv6 listener", async () => {
    const { server, port } = await listen("::", 0, true);
    try {
      expect(() => check(mode, [port])).toThrow();
    } finally {
      await close(server);
    }
  });

  caseFor(mode, "refuses a port held by a loopback and a wildcard listener", async () => {
    const loopback = await listen("127.0.0.1", 0);
    try {
      const wildcard = await listen("::", loopback.port, true);
      try {
        expect(() => check(mode, [loopback.port])).toThrow();
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
    expect(() => check(mode, [port])).toThrow();
  });
}
