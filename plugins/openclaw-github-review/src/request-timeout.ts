/**
 * request-timeout.ts — the one bound on every outbound request the plugin
 * makes: the GitHub GETs and POST (github.ts) and the Flair audit POST
 * (flair-sink.ts).
 *
 * REQUEST_TIMEOUT_MS = 30 s: GitHub and a local Flair answer these requests in
 * well under a second normally and in a few seconds under load, so 30 s only
 * cuts off a request that has stalled. Without a bound, a stalled POST would
 * hold the dispatch's claim until the gateway process stops (every later call
 * refused `dispatch_in_flight`), and a stalled audit write would never reach
 * the retention path.
 */

export const REQUEST_TIMEOUT_MS = 30_000;

/** fetch with `signal: AbortSignal.timeout(timeoutMs)`, and a race against
 *  the same signal, so the call returns (rejecting with the signal's reason)
 *  after `timeoutMs` even if the fetch implementation ignores its signal.
 *  The signal also covers reading the body of a response that arrived. */
export function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error(`request timed out after ${timeoutMs} ms`));
    signal.addEventListener("abort", onAbort, { once: true });
    fetchImpl(url, { ...init, signal }).then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
