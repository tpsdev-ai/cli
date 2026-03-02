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
