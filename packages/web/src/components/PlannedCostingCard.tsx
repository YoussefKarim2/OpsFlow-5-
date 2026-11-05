/**
 * Planned costing — what the order should cost, from the plan, before the
 * floor has made a piece.
 *
 * Its own page beside the actual costing (a switch at the top of the Actual
 * Costing step), and runs the same engine (see
 * `computeExpectedCosting`). Every figure the order already holds is filled in
 * and marked "auto": the Main Order quantity, the PO price, the factory's daily
 * cost and machines, the Production step's line plan and target per day, the
 * bill of materials' required quantities and prices, and the External Order's
 * prices. Whatever the order does not hold is a box to type in, outlined in
 * amber until it is filled. A typed figure stands in only until the order has
 * its own; then the order's figure is used.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, CloudOff, TriangleAlert } from 'lucide-react';
import {
  computeExpectedCosting, fmtMoney, fmtNumber, fmtPct, readTypedNumber,
  type CostingResult, type ExpectedFigure, type ExpectedLineResult, type ExpectedSourceLine, type OrderDetailDto,
} from '@opsflow/shared';
import { api, type CostLineDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader, clsx } from './ui';

type CostingQuery = Awaited<ReturnType<typeof api.steps.costing>>;
type Kind = 'money' | 'price' | 'number';

const money = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n));
const price = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n, '$', Math.abs(n) < 1 ? 4 : 2));
const show = (n: number | null, kind: Kind) =>
  kind === 'money' ? money(n) : kind === 'price' ? price(n) : n == null ? '—' : fmtNumber(n, { places: Number.isInteger(n) ? 0 : 2 });

function plannedLines(planned: CostLineDto[]): ExpectedSourceLine[] {
  return planned.map((l, i) => ({
    group: l.group,
    label: l.label,
    unit: l.unit,
    ref: l.sourceRef ?? `row-${i}`,
    // The BOM's required quantity; outside work is planned in pieces sent out.
    plannedQty: l.estimatedQty ?? (l.group === 'EXTERNAL' ? l.quantity : null),
    unitPriceUsd: l.unitPriceUsd,
  }));
}

export function PlannedCostingCard({ order, c }: { order: OrderDetailDto; c: CostingResult }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const costing = useQuery({ queryKey: ['costing', order.id], queryFn: () => api.steps.costing(order.id) });
  const editable = can('costing:write') && costing.isSuccess;

  // What is typed, as typed: a half-written "0." must survive a re-render.
  const [text, setText] = useState<Record<string, string>>({});
  const seededFor = useRef<string | null>(null);
  const lastSaved = useRef('{}');
  const [save, setSave] = useState<'clean' | 'saving' | 'error'>('clean');

  useEffect(() => {
    if (!costing.isSuccess || seededFor.current === order.id) return;
    seededFor.current = order.id;
    const typed = costing.data.expectedTyped ?? {};
    lastSaved.current = JSON.stringify(typed);
    setText(Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, String(v)])));
  }, [costing.isSuccess, costing.data, order.id]);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(text)) {
      const r = readTypedNumber(v);
      if (r.ok && r.value != null && r.value >= 0) out[k] = r.value;
    }
    return out;
  }, [text]);

  const lines = useMemo(() => plannedLines(costing.data?.planned ?? []), [costing.data]);
  const e = useMemo(() => computeExpectedCosting({
    orderQty: c.source.orderQty,
    sellPriceUsd: c.source.sellPriceUsd,
    dailyCostUsd: c.dailyCostUsd,
    machineCount: c.machineCount,
    lineMachines: c.lineMachineQty,
    targetPerDay: c.targetPerDay,
    lines,
    typed: parsed,
  }), [c, lines, parsed]);

  // Saved a moment after typing stops. Only the figures the order still lacks
  // are worth keeping, but a typed one is kept even after the order fills it,
  // so it comes back if the order's figure is cleared again.
  useEffect(() => {
    if (!editable || seededFor.current !== order.id) return;
    const body = JSON.stringify(parsed);
    if (body === lastSaved.current) return;
    const t = setTimeout(async () => {
      setSave('saving');
      try {
        const r = await api.steps.saveExpectedCosting(order.id, parsed);
        lastSaved.current = JSON.stringify(r.typed);
        qc.setQueryData<CostingQuery>(['costing', order.id], (old) => (old ? { ...old, expectedTyped: r.typed } : old));
        setSave('clean');
      } catch {
        setSave('error');
      }
    }, 700);
    return () => clearTimeout(t);
  }, [parsed, editable, order.id, qc]);

  const type = (key: string) => (v: string) => setText((t) => ({ ...t, [key]: v }));

  const fig = (key: string, f: ExpectedFigure, kind: Kind, opts: { allowZero?: boolean } = {}) => (
    <Figure
      figure={f} kind={kind} editable={editable} text={text[key] ?? ''} onText={type(key)} allowZero={opts.allowZero}
    />
  );

  const groups: Array<{ title: string; swatch: string; rows: ExpectedLineResult[]; total: number | null }> = [
    { title: 'Fabric', swatch: 'bg-accent-500', rows: e.lines.filter((l) => l.group === 'FABRIC'), total: e.fabricCostUsd },
    { title: 'Accessories', swatch: 'bg-accent-300', rows: e.lines.filter((l) => l.group === 'ACCESSORY'), total: e.accessoryCostUsd },
    { title: 'Outside work', swatch: 'bg-ink-300', rows: e.lines.filter((l) => l.group === 'EXTERNAL'), total: e.externalCostUsd },
    { title: 'Other', swatch: 'bg-ink-600', rows: e.lines.filter((l) => l.group === 'LABOUR' || l.group === 'OTHER'), total: null },
  ].filter((g) => g.rows.length > 0);

  const actualUnit = c.unitActualCostUsd;
  const diff = actualUnit != null && e.unitCostUsd != null ? actualUnit - e.unitCostUsd : null;
  const profit = e.profitPerUnitUsd;

  return (
    <div className="screen-only">
      <Card className="overflow-hidden">
        <CardHeader
          title="Planned costing"
          subtitle="What this order should cost, worked out from the plan before production. Filled from the order where it can be; type what it cannot."
          action={editable ? <SaveNote state={save} /> : undefined}
        />

        {/* The answer first, as on the actual costing. */}
        <div className="grid grid-cols-2 gap-px border-b border-ink-100 bg-ink-100 sm:grid-cols-3 xl:grid-cols-5">
          <Stat label="Planned cost / piece" value={price(e.unitCostUsd)} strong />
          <Stat label="Selling price" value={price(e.sellPriceUsd.value)} />
          <Stat
            label="Planned profit / piece"
            value={price(profit)}
            tone={profit == null ? undefined : profit < 0 ? 'bad' : 'good'}
          />
          <Stat label="Planned margin" value={e.profitPct == null ? '—' : fmtPct(e.profitPct, 1)} tone={e.profitPct == null ? undefined : e.profitPct < 0 ? 'bad' : 'good'} />
          <Stat
            label="Actual cost / piece"
            value={price(actualUnit)}
            note={diff == null ? 'Once production is costed' : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${price(Math.abs(diff))} against planned`}
            tone={diff == null ? undefined : diff > 0.00005 ? 'bad' : 'good'}
            className="col-span-2 sm:col-span-1"
          />
        </div>

        {e.missing.length > 0 && (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              <span className="font-semibold">Still to fill: </span>
              {e.missing.join(', ')}. {editable ? 'Type them in the amber boxes below.' : 'Someone with costing access can type them.'}
            </p>
          </div>
        )}

        <div className="grid gap-x-8 gap-y-1 border-b border-ink-100 px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
          <Row label="Order quantity" note="pcs">{fig('orderQty', e.orderQty, 'number')}</Row>
          <Row label="Selling price" note="per piece">{fig('sellPriceUsd', e.sellPriceUsd, 'price')}</Row>
          <Row label="Factory daily cost">{fig('dailyCostUsd', e.dailyCostUsd, 'money')}</Row>
          <Row label="Factory machines">{fig('machineCount', e.machineCount, 'number')}</Row>
          <Row label="Machines on the line">{fig('lineMachines', e.lineMachines, 'number')}</Row>
          <Row label="Target per day" note="pcs">{fig('targetPerDay', e.targetPerDay, 'number')}</Row>
          <Row label="Days in line" note="qty ÷ target">
            <span className="tnum text-sm font-semibold text-ink-900">{e.daysInLine ?? '—'}</span>
          </Row>
          <Row label="C.M per piece" note="same formula as actual">
            <span className="tnum text-sm font-semibold text-ink-900">{price(e.cmCostPerPieceUsd)}</span>
          </Row>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Item</th>
                <th className="th text-right">Planned qty</th>
                <th className="th">Unit</th>
                <th className="th text-right">Unit price</th>
                <th className="th text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {groups.length === 0 && (
                <tr><td colSpan={5} className="td text-center text-ink-500">Nothing on the bill of materials or the External Order yet.</td></tr>
              )}
              {groups.map((g) => (
                <GroupRows key={g.title} title={g.title} swatch={g.swatch} total={g.total} count={g.rows.length}>
                  {g.rows.map((l) => (
                    <tr key={l.ref}>
                      <td className="td pl-8">{l.label}</td>
                      <td className="td text-right">{fig(`qty:${l.ref}`, l.qty, 'number')}</td>
                      <td className="td text-ink-500">{l.unit}</td>
                      <td className="td text-right">{fig(`price:${l.ref}`, l.price, 'price', { allowZero: true })}</td>
                      <td className={clsx('td tnum text-right', l.cost == null ? 'text-ink-300' : 'font-medium text-ink-900')}>{money(l.cost)}</td>
                    </tr>
                  ))}
                </GroupRows>
              ))}
              <tr className="bg-ink-50/60">
                <td className="td font-medium" colSpan={4}>
                  Cut &amp; make (C.M)
                  <span className="ml-2 text-2xs text-ink-400">
                    {e.daysInLine != null && e.lineMachines.value != null ? `${e.lineMachines.value} machines × ${e.daysInLine} day${e.daysInLine === 1 ? '' : 's'}` : 'needs the line figures above'}
                  </span>
                </td>
                <td className="td tnum text-right font-medium">{money(e.cmCostUsd)}</td>
              </tr>
              <tr className="bg-ink-50/60">
                <td className="td font-medium" colSpan={3}>
                  Other costs <span className="ml-2 text-2xs text-ink-400">for the whole order, optional</span>
                </td>
                <td className="td text-right" colSpan={2}>
                  <div className="flex justify-end">{fig('otherCostUsd', e.otherCostUsd, 'money', { allowZero: true })}</div>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="bg-ink-900 text-white">
                <td className="px-4 py-2.5 font-semibold" colSpan={3}>Planned total</td>
                <td className="px-4 py-2.5 text-right text-xs text-ink-300">{e.orderQty.value != null ? `${fmtNumber(e.orderQty.value)} pcs` : ''}</td>
                <td className="tnum px-4 py-2.5 text-right font-semibold">{money(e.totalCostUsd)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Figure({
  figure, kind, editable, text, onText, allowZero,
}: {
  figure: ExpectedFigure; kind: Kind; editable: boolean; text: string; onText: (v: string) => void; allowZero?: boolean;
}) {
  if (figure.source === 'auto') {
    return (
      <span className="inline-flex items-baseline gap-1.5" title="Filled from the order">
        <span className="tnum font-semibold text-ink-900">{show(figure.value, kind)}</span>
        <span className="text-2xs font-medium uppercase tracking-wide text-emerald-600">auto</span>
      </span>
    );
  }
  if (!editable) return <span className="tnum text-ink-300">{show(figure.value, kind)}</span>;
  const r = readTypedNumber(text);
  const bad = !r.ok || (r.value != null && (r.value < 0 || (!allowZero && r.value === 0)));
  const empty = text.trim() === '';
  return (
    <input
      className={clsx(
        'input h-8 w-28 text-right tnum',
        bad ? 'border-red-400 focus:border-red-500' : empty ? 'border-amber-400 bg-amber-50/60' : 'border-violet-300 text-violet-800',
      )}
      inputMode="decimal"
      placeholder={kind === 'number' ? '0' : '$0.00'}
      title={bad ? (r.ok ? 'Must be more than 0' : r.reason) : empty ? 'Not on the order — type it here' : 'Typed — the order’s own figure replaces it once known'}
      value={text}
      onChange={(ev) => onText(ev.target.value)}
    />
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-b border-ink-50 py-1">
      <span className="text-sm text-ink-600">
        {label}{note && <span className="ml-1.5 text-2xs text-ink-400">{note}</span>}
      </span>
      {children}
    </div>
  );
}

function Stat({
  label, value, note, strong, tone, className,
}: { label: string; value: string; note?: string; strong?: boolean; tone?: 'good' | 'bad'; className?: string }) {
  return (
    <div className={clsx('bg-white px-4 py-3', className)}>
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={clsx(
        'tnum mt-1 truncate font-semibold leading-tight',
        strong ? 'text-2xl text-ink-900' : 'text-lg',
        tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-700' : !strong && 'text-ink-900',
      )}>{value}</p>
      {note && <p className="mt-0.5 text-2xs text-ink-400">{note}</p>}
    </div>
  );
}

function GroupRows({ title, swatch, total, count, children }: { title: string; swatch: string; total: number | null; count: number; children: ReactNode }) {
  return (
    <>
      <tr className="bg-ink-50/60">
        <td className="td font-semibold text-ink-800" colSpan={4}>
          <span className={clsx('mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle', swatch)} />
          {title} <span className="ml-1 text-2xs font-normal text-ink-400">{count} row{count === 1 ? '' : 's'}</span>
        </td>
        <td className="td tnum text-right font-semibold">{money(total)}</td>
      </tr>
      {children}
    </>
  );
}

function SaveNote({ state }: { state: 'clean' | 'saving' | 'error' }) {
  if (state === 'error') return <span className="flex items-center gap-1 text-xs text-red-600"><CloudOff className="h-3.5 w-3.5" /> Not saved — keep typing to retry</span>;
  return (
    <span className="flex items-center gap-1 text-xs text-ink-400">
      <Cloud className="h-3.5 w-3.5" /> {state === 'saving' ? 'Saving…' : 'Saved'}
    </span>
  );
}
