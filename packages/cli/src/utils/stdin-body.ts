/**
 * stdin-body.ts — read a mail body from stdin, robustly (cli#429).
 *
 * WHY NOT `process.stdin`. A stream (`for await (const c of process.stdin)` or
 * `.on("data")`) is the obvious reader and is WRONG here. Under bun 1.3.10, once
 * `process.stdin` has been created in an earlier tick — which this CLI does
 * (meow, the nono check, any imported module that touches it) — a REGULAR-FILE
 * stdin reads as 0 bytes: the stream ends immediately with no data. Pipes are
 * fine, but on Linux bun's `spawnSync({ input })` hands the child a memfd, which
 * behaves like a regular file, so a stream-based reader passes on macOS and
 * silently loses the body on Linux. That is exactly the shape bob#203 (driving
 * this over spawnSync) needs to work.
 *
 * THE PATTERN: `readSync` on fd 0 until EOF, retrying EAGAIN (a non-blocking fd),
 * with an explicit size cap and a distinct error for empty input. This reads the
 * same bytes whether stdin is a file, a memfd or a pipe, and does not create
 * `process.stdin`, so it cannot trip the bun regular-file path.
 *
 * The body is returned as UTF-8 text. It is NEVER echoed by this module or its
 * caller.
 */

import { readSync } from "node:fs";
import { MAX_BODY_BYTES } from "./mail.js";

/** Error thrown when --stdin received zero bytes (distinct from every I/O error). */
export class EmptyStdinError extends Error {
  constructor() {
    super("no message body received on stdin (--stdin read 0 bytes)");
    this.name = "EmptyStdinError";
  }
}

/** Error thrown when the stdin body exceeds the cap. */
export class StdinTooLargeError extends Error {
  constructor(bytes: number, cap: number) {
    super(
      `stdin message body exceeds the ${cap}-byte limit (got at least ${bytes} bytes); ` +
        `the envelope body limit is ${cap} bytes — shorten the body and retry`,
    );
    this.name = "StdinTooLargeError";
  }
}

/** Read chunk size — one page-class read; the cap check is what bounds the body. */
const CHUNK = 64 * 1024;

/**
 * How long to keep retrying a non-blocking fd (EAGAIN) before giving up. A pipe
 * writer may legitimately pause between chunks, so this is generous; a
 * non-blocking fd with no writer at all still terminates here rather than
 * spinning forever.
 */
const EAGAIN_TIMEOUT_MS = 60_000;
const EAGAIN_SLEEP_MS = 5;

/** Synchronous sleep that works on both bun and node main threads. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No SharedArrayBuffer / Atomics here — fall back to a bounded spin.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * Read all of fd 0 as UTF-8, capped at `maxBytes` (default: the envelope body
 * cap, `MAX_BODY_BYTES`). Throws EmptyStdinError on zero bytes and
 * StdinTooLargeError past the cap. Never touches `process.stdin`.
 */
export function readStdinBodySync(maxBytes: number = MAX_BODY_BYTES): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(CHUNK);
  let total = 0;
  let eagainMs = 0;

  for (;;) {
    let n: number;
    try {
      // position=null: read from the fd's current position (sequential).
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "EAGAIN") {
        // Non-blocking fd, no data available yet: back off and retry rather
        // than treating "not ready" as EOF.
        eagainMs += EAGAIN_SLEEP_MS;
        if (eagainMs > EAGAIN_TIMEOUT_MS) {
          throw new Error("timed out reading the message body from stdin");
        }
        sleepSync(EAGAIN_SLEEP_MS);
        continue;
      }
      // `EOF` is not thrown by node's readSync (it returns 0); treat a stray one
      // as end-of-input for robustness.
      if (code === "EOF") break;
      throw err;
    }

    if (n === 0) break; // EOF

    total += n;
    if (total > maxBytes) throw new StdinTooLargeError(total, maxBytes);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }

  if (total === 0) throw new EmptyStdinError();
  return Buffer.concat(chunks).toString("utf8");
}
