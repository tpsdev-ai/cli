/**
 * home.ts — the home directory, resolved when it is needed (cli#439).
 *
 * `homeDir()` returns `process.env.HOME` when it is set and not empty, and
 * otherwise `os.homedir()`. It mirrors the CLI's `src/utils/home.ts`; the agent
 * package cannot import the CLI package (see `io/mail.ts`), so the rule is
 * spelled out here.
 *
 * Call it where a path is used, not once at module load: a path built at import
 * time keeps whatever HOME was set then, and every later call in the same
 * process uses that path whatever HOME says now.
 */
import { homedir } from "node:os";

/** `process.env.HOME` when set and not empty, else `os.homedir()`. Read on every call. */
export function homeDir(): string {
  return process.env.HOME || homedir();
}
