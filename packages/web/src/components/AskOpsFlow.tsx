/**
 * Ask OpsFlow — the chat panel.
 *
 * A button in the header opens a panel on the right where a person can ask
 * about orders in plain English or Arabic. The server does the work (see
 * packages/server/src/services/assistant/): it looks orders up through the
 * same permissions the screens use, so the answer never shows anything this
 * person could not open themselves.
 *
 * The conversation lives only in this component. Nothing is stored on the
 * server, and closing the browser tab forgets it. The last 12 turns are sent
 * with each question so follow-ups ("and its printing?") make sense.
 *
 * Hidden entirely when the assistant is switched off (no AI key on the
 * server) or the account cannot read orders.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageCircleQuestion, Send, X, RotateCcw } from 'lucide-react';
import { isArabic } from '@opsflow/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clsx } from './ui';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  orders?: Array<{ id: string; poNumber: string }>;
  failed?: boolean;
}

const EXAMPLES = [
  'Which orders need attention today?',
  'How is PO 13506 doing?',
  'What is late this week?',
  'ما هي حالة الأوردر 13506؟',
];

const HISTORY_SENT = 12;

export function AskOpsFlowButton() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['assistant-status'],
    queryFn: () => api.assistant.status(),
    enabled: can('order:read'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!data?.enabled) return null;
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium',
          open ? 'bg-accent-600 text-white' : 'text-accent-700 hover:bg-accent-50',
        )}
        aria-expanded={open}
        aria-controls="ask-opsflow-panel"
        title="Ask OpsFlow about any order"
      >
        <MessageCircleQuestion className="h-4 w-4" />
        <span className="hidden sm:inline">Ask OpsFlow</span>
      </button>
      {open && <AskOpsFlowPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function AskOpsFlowPanel({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history = [...turns.filter((t) => !t.failed), { role: 'user' as const, content: question }];
    setTurns((t) => [...t, { role: 'user', content: question }]);
    setDraft('');
    setBusy(true);
    try {
      const r = await api.assistant.ask(history.slice(-HISTORY_SENT).map(({ role, content }) => ({ role, content })));
      setTurns((t) => [...t, { role: 'assistant', content: r.answer, orders: r.orders }]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      setTurns((t) => [...t, { role: 'assistant', content: msg, failed: true }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) { e.preventDefault(); void send(draft); }

  return (
    <aside
      id="ask-opsflow-panel"
      role="dialog"
      aria-label="Ask OpsFlow"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-ink-200 bg-white shadow-panel sm:w-[420px]"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-ink-200 px-4">
        <MessageCircleQuestion className="h-5 w-5 text-accent-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-900">Ask OpsFlow</p>
          <p className="truncate text-xs text-ink-500">Questions about orders, in English or Arabic. It can only read.</p>
        </div>
        {turns.length > 0 && (
          <button onClick={() => setTurns([])} className="rounded p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700" title="Start a new conversation" aria-label="Start a new conversation">
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        <button onClick={onClose} className="rounded p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700" title="Close (Esc)" aria-label="Close Ask OpsFlow">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {turns.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-ink-600">
              Ask about any order you can see in OpsFlow: where it stands, what is blocking it, what is late, what is short.
            </p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  onClick={() => void send(q)}
                  dir={isArabic(q) ? 'rtl' : 'ltr'}
                  className="rounded-full border border-ink-200 px-3 py-1 text-xs text-ink-700 hover:border-accent-300 hover:bg-accent-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => <Bubble key={i} turn={t} onNavigate={onClose} />)}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-ink-500">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400 [animation-delay:-0.2s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400 [animation-delay:-0.1s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400" />
            </span>
            Looking it up…
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-ink-200 p-3">
        <textarea
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
          dir="auto"
          rows={2}
          maxLength={1500}
          placeholder="e.g. how is PO 13506 doing?"
          className="input min-h-[2.5rem] flex-1 resize-none"
          aria-label="Your question"
        />
        <button type="submit" disabled={busy || !draft.trim()} className="btn-primary h-10 px-3" title="Send (Enter)" aria-label="Send question">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </aside>
  );
}

function Bubble({ turn, onNavigate }: { turn: ChatTurn; onNavigate: () => void }) {
  const mine = turn.role === 'user';
  return (
    <div className={clsx('flex flex-col', mine ? 'items-end' : 'items-start')}>
      {/* `auto` takes the direction from the first strong character, so an
          English answer that quotes an Arabic task title stays left-to-right. */}
      <div
        dir="auto"
        className={clsx(
          'max-w-[90%] whitespace-pre-line rounded-lg px-3 py-2 text-sm leading-relaxed',
          mine ? 'bg-accent-600 text-white' : turn.failed ? 'border border-red-200 bg-red-50 text-red-800' : 'bg-ink-100 text-ink-900',
        )}
      >
        {mine ? turn.content : linkify(turn.content, turn.orders ?? [], onNavigate)}
      </div>
      {!mine && turn.orders && turn.orders.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {turn.orders.slice(0, 6).map((o) => (
            <Link
              key={o.id}
              to={`/orders/${o.id}`}
              onClick={onNavigate}
              className="rounded border border-ink-200 px-1.5 py-0.5 font-mono text-[11px] text-accent-700 hover:bg-accent-50"
            >
              Open {o.poNumber}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Turns the PO numbers in an answer into links to their orders. Only the
 * orders the server said the answer drew on are linked — text is never
 * parsed into an id, so a model that writes an unknown number gets plain
 * text, not a link to the wrong order. Everything is rendered as text, never
 * as HTML.
 */
function linkify(text: string, orders: Array<{ id: string; poNumber: string }>, onNavigate: () => void): ReactNode {
  const known = orders.filter((o) => o.poNumber.length >= 3);
  if (!known.length) return text;
  const escaped = known.map((o) => o.poNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![A-Za-z0-9])(${escaped.join('|')})(?![A-Za-z0-9])`, 'g');
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const order = known.find((o) => o.poNumber === m[1]);
    if (!order || m.index === undefined) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <Link key={`${m.index}-${order.id}`} to={`/orders/${order.id}`} onClick={onNavigate} className="font-mono font-semibold text-accent-700 underline decoration-accent-300 hover:decoration-accent-600">
        {m[1]}
      </Link>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
