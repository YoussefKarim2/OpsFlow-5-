/**
 * A support overlay for a layout that cannot be reproduced here: ⌃⌥L
 * (Control + Option + L) shows the window's and the content area's sizes and
 * scroll extents, and the element that reaches lowest on the page. Press it
 * again to hide. Reads only; changes nothing.
 */

import { useEffect, useState } from 'react';

interface Probe {
  window: string;
  html: string;
  main: string;
  lowest: string;
  tall: string[];
  build: string;
}

function measure(): Probe {
  const se = document.scrollingElement ?? document.documentElement;
  const main = document.querySelector('main');
  const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).trim().split(/\s+/).slice(0, 4).join('.')}`;
  let lowest = 0;
  let who = '';
  const tall: string[] = [];
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const bottom = r.bottom + (main?.scrollTop ?? 0);
    if (bottom > lowest) { lowest = bottom; who = desc(el); }
    if (r.height > window.innerHeight * 1.5) tall.push(`${desc(el)} h=${Math.round(r.height)}`);
  }
  return {
    window: `${window.innerWidth}×${window.innerHeight} zoom=${Math.round(window.devicePixelRatio * 100) / 100} standalone=${window.matchMedia('(display-mode: standalone)').matches}`,
    html: `scrollHeight=${se.scrollHeight} clientHeight=${se.clientHeight} scrollTop=${Math.round(se.scrollTop)}`,
    main: main ? `scrollHeight=${main.scrollHeight} clientHeight=${main.clientHeight} scrollTop=${Math.round(main.scrollTop)} overflow=${getComputedStyle(main).overflowY}` : 'no <main>',
    lowest: `${Math.round(lowest)}px ${who}`,
    tall: tall.slice(0, 6),
    build: (document.querySelector('meta[name="build"]') as HTMLMetaElement | null)?.content ?? '',
  };
}

export function LayoutProbe() {
  const [on, setOn] = useState(false);
  const [p, setP] = useState<Probe | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L' || e.code === 'KeyL')) { e.preventDefault(); setOn((v) => !v); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!on) return;
    const tick = () => setP(measure());
    tick();
    const t = setInterval(tick, 700);
    return () => clearInterval(t);
  }, [on]);
  if (!on || !p) return null;
  return (
    <div className="no-print pointer-events-none fixed left-2 top-16 z-[80] max-w-[36rem] rounded-md border border-ink-300 bg-ink-950/90 p-3 font-mono text-[11px] leading-relaxed text-white shadow-lg">
      <p className="font-semibold">Layout — ⌃⌥L to hide</p>
      <p>window: {p.window}</p>
      <p>page: {p.html}</p>
      <p>content: {p.main}</p>
      <p>lowest element: {p.lowest}</p>
      {p.tall.length > 0 && <p>tall: {p.tall.join(' · ')}</p>}
      <p>path: {window.location.pathname} {p.build && `build ${p.build}`}</p>
    </div>
  );
}
