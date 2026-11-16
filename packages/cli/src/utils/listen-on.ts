/**
 * Bind a server and settle once it is listening.
 *
 * A `WebSocketServer` built over an HTTP server re-emits that server's `error`.
 * A bind failure (EADDRINUSE) therefore reaches both emitters, and without a
 * listener for the second emission it is an uncaught `error` event that kills
 * the process before the caller can see the rejection. `listenOn` attaches
 * listeners to both emitters for the duration of the bind, rejects the promise
 * with the bind failure, and then replaces them with one handler that routes
 * every later error to the caller's failure path: the error is handled, never
 * dropped because the promise has settled and never left without a listener.
 */
export type ErrorListener = (error: Error) => void;

export interface ListenEmitter {
  once(event: "error", listener: ErrorListener): unknown;
  on(event: "error", listener: ErrorListener): unknown;
  off(event: "error", listener: ErrorListener): unknown;
}

export interface Listenable extends ListenEmitter {
  listen(port: number, host: string, callback: () => void): unknown;
}

export interface ListenOnOptions {
  /** Interface to bind; defaults to every interface. */
  host?: string;
  /** A second emitter that re-emits `server`'s errors, such as a WebSocketServer. */
  also?: ListenEmitter;
  /** The listener's failure path for an error after a successful bind. */
  onError: ErrorListener;
}

export function listenOn(
  server: Listenable,
  port: number,
  { host = "0.0.0.0", also, onError }: ListenOnOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let failedAfterBind = false;

    const onBindError = (error: Error) => {
      if (settled) return;
      settled = true;
      server.off("error", onBindError);
      also?.off("error", onBindError);
      reject(error);
    };

    const onRuntimeError = (error: Error) => {
      // `server` and `also` report one underlying error; run the failure path
      // once, on the listener it belongs to.
      if (!settled || failedAfterBind) return;
      failedAfterBind = true;
      onError(error);
    };

    server.once("error", onBindError);
    also?.once("error", onBindError);

    server.listen(port, host, () => {
      if (settled) return;
      settled = true;
      server.off("error", onBindError);
      also?.off("error", onBindError);
      server.on("error", onRuntimeError);
      also?.on("error", onRuntimeError);
      resolve();
    });
  });
}
