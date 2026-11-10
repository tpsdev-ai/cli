/**
 * Bridge Adapter Interface
 *
 * Each adapter translates between a specific channel (Discord, Slack, etc.)
 * and TPS mail envelopes. The bridge core handles mail routing; adapters
 * handle channel-specific I/O.
 */

export interface BridgeEnvelope {
  channel: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  replyTo?: string;
  agentId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface BridgeAdapter {
  /** Adapter name (e.g. "openclaw", "discord", "stdio") */
  readonly name: string;

  /**
   * Start the adapter. Called once by the bridge core.
   * @param onInbound - callback when a message arrives from the channel
   */
  start(onInbound: (envelope: BridgeEnvelope) => string): Promise<void>;

  /**
   * Send a message out to the channel.
   */
  send(envelope: BridgeEnvelope): Promise<void>;

  /**
   * Stop the adapter and clean up resources.
   */
  stop(): Promise<void>;
}

/**
 * Adapter name grammar (cli#725): one or more lowercase ASCII letters (`[a-z]+`).
 * Shared by `BridgeCore` at start and `bridgePidFiles` during discovery.
 */
export const BRIDGE_ADAPTER_NAME_RE = /^[a-z]+$/;

export function validateBridgeAdapterName(name: string): boolean {
  return BRIDGE_ADAPTER_NAME_RE.test(name);
}

/**
 * JSON-quotes a rejected name, then escapes every remaining code point outside
 * `\x20`-`\x7e` as `\uXXXX` (each UTF-16 unit, so an astral code point is two
 * escapes; JSON.stringify has already escaped the controls).
 */
export function printableName(name: string): string {
  // No `u` flag, on purpose: without it the class matches UTF-16 code units, so both halves of an astral
  // character (0xD800-0xDFFF) are escaped. With `u` it matches code points, and an astral character passes raw.
  return JSON.stringify(name).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function assertBridgeAdapterName(name: string): void {
  if (!validateBridgeAdapterName(name)) {
    throw new Error(
      `Invalid bridge adapter name ${printableName(name)}: allowed characters are lowercase ASCII letters ([a-z]+).`,
    );
  }
}
