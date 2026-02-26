import { resolve, relative, isAbsolute, sep } from "node:path";
import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";

/**
 * BoundaryManager handles execution-time policy controls for security boundaries.
 */
export class BoundaryManager {
  private allowedNetworkHosts = new Set<string>();

  constructor(private readonly workspace: string) {}

  addNetworkHost(host: string): void {
    this.allowedNetworkHosts.add(host);
  }

  isNetworkAllowed(host: string): boolean {
    return this.allowedNetworkHosts.has(host) || this.allowedNetworkHosts.has("*");
  }

  /**
   * Resolve a user requested filesystem path against workspace and ensure
   * it cannot escape the workspace root.
   */
  resolveWorkspacePath(relativeOrAbsolutePath: string): string {
    const target = resolve(this.workspace, relativeOrAbsolutePath);
    const workspaceReal = realpathSync(this.workspace);

    let normalized = target;
    if (existsSync(target)) {
      normalized = realpathSync(target);
    } else {
      // If target does not exist, resolve relative to existing parent.
      const parent = resolve(target, "..");
      if (existsSync(parent)) {
        normalized = resolve(realpathSync(parent), target.slice(parent.length + 1));
      }
    }

    if (!this.isWithinWorkspace(normalized, workspaceReal)) {
      throw new Error(`Path traversal blocked: ${relativeOrAbsolutePath}`);
    }

    return target;
  }

  private isWithinWorkspace(candidate: string, workspaceReal: string): boolean {
    const rel = relative(workspaceReal, candidate);
    if (rel === "") return true;
    if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
    return !isAbsolute(rel);
  }

  /**
   * Verify that a command is safe before exec.
   */
  validateCommand(command: string, args: string[]): void {
    if (!command) {
      throw new Error("Exec requires a command");
    }

    const blockedFlags = ["--exec-path", "-e", "--eval", "-p", "-c", "/dev/fd", "--noprofile", "--norc", "node_options", "command="];
    const tokens = [command, ...args].map((token) => String(token).toLowerCase());

    for (const token of tokens) {
      if (blockedFlags.includes(token) || token.includes("core.pager")) {
        throw new Error(`Disallowed exec argument: ${token}`);
      }
    }

    // Disallow attempts to execute compound expressions.
    const full = tokens.join(" ");
    if (full.includes("||") || full.includes("&&") || full.includes(";") || full.includes("|") || full.includes("$") || full.includes("`") ) {
      throw new Error(`Disallowed exec argument: ${full}`);
    }
  }

  /**
   * Child processes must not inherit runtime secrets from the parent process.
   */
  scrubEnvironment(extraKeys: string[] = []): NodeJS.ProcessEnv {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    const denyPattern = /(API_KEY|APISECRET|SECRET|TOKEN|PASS|CREDENTIAL|AUTH)/i;

    for (const key of Object.keys(env)) {
      if (denyPattern.test(key)) {
        delete env[key];
      }
    }

    for (const key of extraKeys) {
      if (key in env) {
        delete env[key];
      }
    }

    return env;
  }

  /** Returns human-readable boundaries for system prompts and audit logs. */
  describeCapabilities(): string {
    const nets = [...this.allowedNetworkHosts].join(", ") || "none";
    return `Network access: ${nets}\nFilesystem access: ${this.workspace}`;
  }

  static isFileReadable(path: string): boolean {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  static isFileWritable(path: string): boolean {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  static canFollowSymlink(path: string): boolean {
    try {
      const stat = lstatSync(path);
      return !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }
}
