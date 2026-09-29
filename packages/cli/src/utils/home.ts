/**
 * home.ts — the home directory, resolved when it is needed (cli#430).
 *
 * `homeDir()` returns `process.env.HOME` when it is set and not empty, and
 * otherwise `os.homedir()`, the account's home. That is the rule Node documents
 * for `os.homedir()` on POSIX (HOME first, then the user database). It is spelled
 * out here because under bun `os.homedir()` keeps returning the HOME the process
 * started with, even after `process.env.HOME` is changed.
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
