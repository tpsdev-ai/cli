/**
 * TEST-ONLY start-token source control for bun tests (cli#1045). See
 * start-token-source.mjs: these change what `/proc/<pid>/stat` reads return in
 * the test process (spyOn on the `node:fs` namespace, forwarding every argument)
 * and restore it when the current test finishes, or name the preload a child
 * process needs. Nothing in the production packages is involved.
 */
import { onTestFinished, spyOn } from "bun:test";
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wrapReadFileSync } from "./start-token-source.mjs";

/** Absolute paths of the two preloads. */
export const PS_START_TOKENS_PRELOAD = fileURLToPath(new URL("./start-token-ps-preload.mjs", import.meta.url));
export const PROC_START_TOKENS_PRELOAD = fileURLToPath(new URL("./start-token-proc-preload.mjs", import.meta.url));

/** `bun` arguments, before `--eval`/the script, that force the `ps` fallback in a bun child. */
export const PS_START_TOKENS_BUN_ARGS: readonly string[] = ["--preload", PS_START_TOKENS_PRELOAD];
/** `node` arguments, before the script, that force the `ps` fallback in a node child. */
export const PS_START_TOKENS_NODE_ARGS: readonly string[] = ["--import", pathToFileURL(PS_START_TOKENS_PRELOAD).href];

/** `node` arguments, before the script, that stage the same `proc:` tokens in a node child. */
export const PROC_START_TOKENS_NODE_ARGS: readonly string[] = ["--import", pathToFileURL(PROC_START_TOKENS_PRELOAD).href];

function substitute(mode: "ps" | "proc"): void {
  const real = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(wrapReadFileSync(real, mode) as typeof fs.readFileSync);
  onTestFinished(() => {
    spy.mockRestore();
  });
}

/** Send this process's processStartToken to its `ps` fallback for the rest of the test, where /proc exists too. */
export function forcePsStartTokens(): void {
  substitute("ps");
}

/**
 * Give every live pid a `proc:` start token for the rest of the test, on every
 * platform. A test that stages a reused live pid needs this: a differing `ps:`
 * token is unverified, not stale.
 */
export function stageProcStartTokens(): void {
  substitute("proc");
}
