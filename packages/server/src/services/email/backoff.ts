/**
 * When to try a failed email again.
 *
 * Its own module, with no imports at all, so the schedule can be tested without
 * a database — and because "how long before we give up" is a policy decision
 * worth reading on its own rather than buried in the queue's plumbing.
 *
 * Geometric rather than fixed: the failures worth retrying are the transient
 * ones — a network blip, a Graph throttle — and a client secret that expired
 * last week is not helped by trying every sixty seconds for a fortnight. The
 * total is deliberately over twelve hours, so an outage that starts in the
 * evening is still delivered the next morning rather than abandoned overnight.
 */

const BACKOFF_MINUTES = [1, 5, 25, 120, 600];

export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

export function nextAttemptDelayMs(attempts: number): number {
  const index = Math.min(Math.max(0, attempts), BACKOFF_MINUTES.length - 1);
  return (BACKOFF_MINUTES[index] ?? 600) * 60_000;
}
