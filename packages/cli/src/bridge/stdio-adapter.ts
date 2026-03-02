/**
 * Stdio Bridge Adapter
 *
 * Reads JSON envelopes from stdin, writes outbound envelopes to stdout.
 * Great for testing and CLI piping.
 */

import { createInterface } from "node:readline";
import type { BridgeAdapter, BridgeEnvelope } from "./adapter.js";

export class StdioAdapter implements BridgeAdapter {
  readonly name = "stdio";
  private rl: ReturnType<typeof createInterface> | null = null;

  async start(onInbound: (envelope: BridgeEnvelope) => string): Promise<void> {
    this.rl = createInterface({ input: process.stdin });
    this.rl.on("line", (line) => {
      try {
        const envelope: BridgeEnvelope = JSON.parse(line);
        if (envelope.content && envelope.channel) {
          onInbound(envelope);
        }
      } catch {
        // Skip malformed lines
      }
    });
  }

  async send(envelope: BridgeEnvelope): Promise<void> {
    process.stdout.write(JSON.stringify(envelope) + "\n");
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }
}
