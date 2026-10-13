/**
 * Surviving a deploy with the app still open.
 *
 * Every build names its code chunks by content hash, and each screen's chunk
 * loads the first time that screen is opened. A tab opened before a deploy
 * still holds the old names; when it opens a screen it has not visited, the
 * server no longer has that file and answers with the HTML page instead —
 * "'text/html' is not a valid JavaScript MIME type". Nothing is wrong with
 * the data; the tab is simply running a build that no longer exists.
 *
 * Two answers, both here:
 *   - a chunk that fails to load reloads the page once, so the tab picks up
 *     the current build and lands on the screen it was going to;
 *   - the app checks the server's build id now and then, and once a newer
 *     build is live it reloads at the next screen change (and offers a
 *     Reload button meanwhile), so the failure above is rarely reached.
 */

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

declare const __BUILD_ID__: string;
/** The build this JavaScript came from, stamped at build time. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

const RELOAD_KEY = 'opsflow.reload-for-build';

/** True from the moment a reload has been asked for until the page is gone. */
let reloadPending = false;
export const isReloadPending = (): boolean => reloadPending;

/** A failure to load one of the app's own code chunks, however the browser phrases it. */
export function isChunkLoadError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return /not a valid JavaScript MIME type|Failed to fetch dynamically imported module|Importing a module script failed|Loading (CSS )?chunk|error loading dynamically imported module|Unable to preload CSS/i.test(text);
}

/**
 * Reload the page to pick up the current build — once. A second failure
 * within a minute means the problem is not a stale build, and the error is
 * shown instead of looping.
 */
export function reloadForNewBuild(): boolean {
  if (reloadPending) return true;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* private mode: reload anyway, once per page life */ }
  reloadPending = true;
  window.location.reload();
  return true;
}

/**
 * Catch chunk failures that happen outside React's render — Vite's preloads
 * of a chunk's dependencies. The event is not cancelled: cancelling it makes
 * Vite hand the screen an empty module, which fails a second way before the
 * reload lands. Left alone, the import rejects and the lazy loader handles it.
 */
export function installChunkErrorHandler(): void {
  window.addEventListener('vite:preloadError', () => { reloadForNewBuild(); });
}

/** Whether a newer build than this one is live on the server. Polled on focus and every few minutes. */
export function useNewBuildAvailable(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (BUILD_ID === 'dev') return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const body = (await res.json()) as { build?: string };
        if (!cancelled && body.build && body.build !== BUILD_ID) setStale(true);
      } catch { /* offline or restarting: try again later */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const timer = window.setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', onVisible);
    void check();
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return stale;
}

/**
 * Once a newer build is live, the next screen change reloads into it. A
 * screen change already leaves the current screen, so nothing typed there
 * is lost that would not have been lost anyway.
 */
export function useReloadOnNavigateWhenStale(stale: boolean): void {
  const location = useLocation();
  const [seenAt, setSeenAt] = useState<string | null>(null);
  useEffect(() => {
    if (!stale) return;
    if (seenAt == null) { setSeenAt(location.pathname); return; }
    if (location.pathname !== seenAt) reloadForNewBuild();
  }, [stale, location.pathname, seenAt]);
}
