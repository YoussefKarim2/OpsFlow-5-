/**
 * One banner for every screen when the server cannot be reached.
 *
 * A database restart or a network blip fails whatever queries are on screen.
 * Each page handles its own loading state; not every one says anything on
 * failure, and a list that quietly renders empty during an outage reads as
 * "there are no orders". So the outage is announced once, above the page,
 * from the query cache itself: any query whose last error says the server or
 * its database was unreachable puts the banner up, and the failed queries are
 * asked again every few seconds until one succeeds, which takes it down.
 * Nothing on the page is replaced — what loaded before the outage stays.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';

const RECHECK_MS = 5_000;

function isOutage(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 503 || error.status === 502 || error.status === 504 || error.code === 'DATABASE_UNAVAILABLE';
  // fetch itself failed: no connection, DNS, the server not listening.
  return error instanceof TypeError;
}

export function OutageBanner() {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const message = useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () => {
      const failed = cache.getAll().find((q) => q.state.status === 'error' && isOutage(q.state.error));
      if (!failed) return null;
      const err = failed.state.error;
      return err instanceof ApiError ? err.message : 'The server could not be reached.';
    },
  );

  const retry = () => { void client.refetchQueries({ type: 'all', predicate: (q) => q.state.status === 'error' }); };

  useEffect(() => {
    if (!message) return;
    const t = setInterval(retry, RECHECK_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  if (!message) return null;
  return (
    <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <span className="font-medium">OpsFlow cannot reach the server right now.</span>{' '}
      <span>{message}</span>{' '}
      <span className="text-amber-700">Checking again every few seconds — nothing you did has been lost.</span>{' '}
      <button type="button" className="ml-2 underline" onClick={retry}>Try again now</button>
    </div>
  );
}
