/**
 * Last-resort guards for errors that escape every other net.
 *
 * Express already catches anything thrown while handling a request (see
 * `asyncHandler` and the error middleware). What reaches here came from
 * somewhere with no such net — a background timer, a socket, a promise nobody
 * awaited — and Node's default answer to that is to kill the process. For a
 * factory running its orders through this system, "the whole site is down
 * because an email retry threw" is not an acceptable trade.
 *
 * The two cases are treated differently, because they genuinely are:
 *
 *   **unhandledRejection** — a promise nobody awaited. The process is fine;
 *     one background job isn't. Log it and keep serving. This is the common
 *     one, and killing the server over it would be the bug.
 *
 *   **uncaughtException** — a synchronous throw that unwound to the top. The
 *     process may now hold state nobody reasoned about, and carrying on risks
 *     writing *wrong data* — which is worse than being unavailable for the two
 *     seconds a restart takes. Log it, close cleanly, let the platform restart
 *     us. That is what the healthcheck and restart policy are for.
 *
 * Either way the error is logged *first*: an unexplained restart at 3am is a
 * far harder problem than a crash with a stack trace sitting next to it.
 */

export interface GuardHooks {
  /** Called for an uncaught exception, to shut down and let the platform restart. */
  shutdown: (reason: string) => void;
  log?: (...args: unknown[]) => void;
}

export function installProcessGuards({ shutdown, log = console.error }: GuardHooks): void {
  process.on('unhandledRejection', (reason) => {
    log('[unhandledRejection]', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });

  process.on('uncaughtException', (err: Error) => {
    log('[uncaughtException]', err.stack ?? err.message);
    shutdown('uncaughtException');
  });
}
