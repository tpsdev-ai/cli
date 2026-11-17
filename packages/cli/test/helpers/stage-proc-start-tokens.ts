/**
 * cli#1045 — start-token staging for a single test, through the agent package's
 * `startTokenTestHooks` seam. Each helper restores the previous reader when the
 * current test finishes.
 */
import { onTestFinished } from "bun:test";
import { startTokenTestHooks } from "@tpsdev-ai/agent";
import { installProcStartTokens } from "./proc-start-tokens.mjs";

/**
 * Give every live pid a `proc:` start token for the rest of the test, on every
 * platform (see proc-start-tokens.mjs). A test that stages a reused live pid
 * needs this: a differing `ps:` token is unverified, not stale.
 */
export function stageProcStartTokens(): void {
  onTestFinished(installProcStartTokens());
}

/** `node` arguments, placed before the script, that stage the same `proc:` tokens in a CLI subprocess. */
export const PROC_START_TOKENS_NODE_ARGS: readonly string[] = [
  "--import",
  new URL("./proc-start-tokens-preload.mjs", import.meta.url).href,
];

/** Send processStartToken to its `ps` fallback for the rest of the test, where /proc exists too. */
export function forcePsStartTokens(): void {
  const previous = startTokenTestHooks.readStat;
  startTokenTestHooks.readStat = () => null;
  onTestFinished(() => {
    startTokenTestHooks.readStat = previous;
  });
}
