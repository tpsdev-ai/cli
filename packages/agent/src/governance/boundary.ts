/**
 * BoundaryManager discovers nono profile constraints at boot and communicates
 * allowed capabilities to the ToolRegistry.
 *
 * NOTE: The system prompt is NOT a security boundary. Hard nono syscall/network
 * filters and pre-execution checks in ToolRegistry are the actual enforcement.
 */
export class BoundaryManager {
  private allowedNetworkHosts: Set<string> = new Set();
  private allowedPaths: Set<string> = new Set();

  addNetworkHost(host: string): void {
    this.allowedNetworkHosts.add(host);
  }

  addPath(path: string): void {
    this.allowedPaths.add(path);
  }

  isNetworkAllowed(host: string): boolean {
    return this.allowedNetworkHosts.has(host) || this.allowedNetworkHosts.has("*");
  }

  isPathAllowed(path: string): boolean {
    for (const allowed of this.allowedPaths) {
      if (path.startsWith(allowed)) return true;
    }
    return false;
  }

  /** Returns a human-readable capabilities summary for the LLM system prompt. */
  describeCapabilities(): string {
    const nets = [...this.allowedNetworkHosts].join(", ") || "none";
    const paths = [...this.allowedPaths].join(", ") || "none";
    return `Network access: ${nets}\nFilesystem access: ${paths}`;
  }
}
