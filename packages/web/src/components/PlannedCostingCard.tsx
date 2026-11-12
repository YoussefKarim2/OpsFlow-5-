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
 * amber until it is filled.
 *
 * Every figure is a box: the order's, the calculated ones (days in line, C.M,
 * subtotals, the total, the profit) and the missing ones. A typed figure wins
 * and turns violet; ↺ beside it puts the order's or the calculated figure back.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Cloud, CloudOff, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  EXPECTED_SIGNED_KEYS, computeExpectedCosting, fmtMoney, fmtNumber, fmtPct, readTypedNumber,
  type CostingResult, type ExpectedFigure, type ExpectedLineResult, type ExpectedSourceLine, type OrderDetailDto,
} from '@opsflow/shared';
import { api, type CostLineDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader, clsx } from './ui';

type CostingQuery = Awaited<ReturnType<typeof api.steps.costing>>;
type Kind = 'money' | 'price' | 'number' | 'pct';

const money = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n));
const price = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n, '$', Math.abs(n) < 1 ? 4 : 2));
const show = (n: number | null, kind: Kind) =>
  kind === 'money' ? money(n) : kind === 'price' ? price(n) : n == null ? '—'
    : kind === 'pct' ? fmtPct(n, 1) : fmtNumber(n, { places: Number.isInteger(n) ? 0 : 2 });
/** A figure as it sits in its box, ready to be typed over. */
const plain = (n: number | null, kind: Kind) =>
  n == null ? '' : String(Number(n.toFixed(kind === 'money' || kind === 'price' ? 4 : 2)));

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
  // On the data, not the last fetch's success: a failed background refetch
  // keeps the data and must not stop the saving mid-edit.
  const editable = can('costing:write') && costing.data != null;

  // What is typed, as typed: a half-written "0." must survive a re-render.
  const [text, setText] = useState<Record<string, string>>({});
  const seededFor = useRef<string | null>(null);
  /** The figures as this screen last saved them (or loaded them). */
  const savedRef = useRef<Record<string, number>>({});
  const [save, setSave] = useState<'clean' | 'saving' | 'error'>('clean');

  useEffect(() => {
    if (!costing.data || seededFor.current === order.id) return;
    seededFor.current = order.id;
    const typed = costing.data.expectedTyped ?? {};
    savedRef.current = { ...typed };
    setText(Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, String(v)])));
  }, [costing.data, order.id]);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(text)) {
      const r = readTypedNumber(v);
      if (r.ok && r.value != null && (r.value >= 0 || EXPECTED_SIGNED_KEYS.includes(k))) out[k] = r.value;
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

  // Saving. Only what changed since this screen's last save is sent, and the
  // server applies it onto the stored figures, so two people typing different
  // prices both keep theirs. One request at a time; a change made while one is
  // out goes when it lands. Leaving the page sends whatever is still unsaved.
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const inFlight = useRef(false);
  const queued = useRef(false);

  const pendingChange = () => {
    const now = parsedRef.current;
    const was = savedRef.current;
    const set: Record<string, number> = {};
    for (const [k, v] of Object.entries(now)) if (was[k] !== v) set[k] = v;
    const remove = Object.keys(was).filter((k) => !(k in now));
    return Object.keys(set).length > 0 || remove.length > 0 ? { set, remove, snapshot: now } : null;
  };

  const flush = async (): Promise<void> => {
    if (!editableRef.current || seededFor.current !== order.id) return;
    const change = pendingChange();
    if (!change) return;
    if (inFlight.current) { queued.current = true; return; }
    inFlight.current = true;
    setSave('saving');
    try {
      const r = await api.steps.saveExpectedCosting(order.id, { set: change.set, remove: change.remove });
      savedRef.current = { ...change.snapshot };
      qc.setQueryData<CostingQuery>(['costing', order.id], (old) => (old ? { ...old, expectedTyped: r.typed } : old));
      setSave('clean');
    } catch {
      setSave('error');
    } finally {
      inFlight.current = false;
    }
    if (queued.current) { queued.current = false; await flush(); }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!editable || seededFor.current !== order.id || !pendingChange()) return;
    const t = setTimeout(() => { void flushRef.current(); }, 700);
    return () => clearTimeout(t);
  }, [parsed, editable, order.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching to the actual costing or another tab within the pause still saves.
  useEffect(() => () => { void flushRef.current(); }, []);
  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => {
      if (pendingChange() || inFlight.current) { ev.preventDefault(); ev.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const type = (key: string) => (v: string) => setText((t) => ({ ...t, [key]: v }));
  const reset = (key: string) => setText((t) => { const n = { ...t }; delete n[key]; return n; });
  /** Leaving a box: an empty one, or one typed back to the order's figure, is not an override. */
  const settle = (key: string, f: ExpectedFigure) => {
    const v = text[key];
    if (v == null) return;
    const r = readTypedNumber(v);
    if (v.trim() === '' || (r.ok && r.value != null && f.base != null && Math.abs(r.value - f.base) < 1e-9)) reset(key);
  };

  const fig = (key: string, f: ExpectedFigure, kind: Kind, opts: { allowZero?: boolean; dark?: boolean } = {}) => (
    <Figure
      figure={f} kind={kind} editable={editable} typing={key in text} text={text[key] ?? ''}
      onText={type(key)} onDone={() => settle(key, f)} onReset={() => reset(key)}
      allowZero={opts.allowZero} signed={EXPECTED_SIGNED_KEYS.includes(key)} dark={opts.dark} worked={key in e.derived}
    />
  );
  const d = e.derived;

  const qty = e.orderQty.value;
  const perPc = (n: number | null) => (n != null && qty != null && qty > 0 ? n / qty : null);
  const lineMissing = (l: ExpectedLineResult) => (l.qty.value == null ? 1 : 0) + (l.price.value == null ? 1 : 0);

  const groups: Array<{ key: string; title: string; swatch: string; rows: ExpectedLineResult[]; total: number | null; typeKey: string | null }> = [
    { key: 'fabric', title: 'Fabric', swatch: 'bg-accent-500', rows: e.lines.filter((l) => l.group === 'FABRIC'), total: e.fabricCostUsd, typeKey: 'fabricCostUsd' },
    { key: 'acc', title: 'Accessories', swatch: 'bg-accent-300', rows: e.lines.filter((l) => l.group === 'ACCESSORY'), total: e.accessoryCostUsd, typeKey: 'accessoryCostUsd' },
    { key: 'ext', title: 'Outside work', swatch: 'bg-ink-300', rows: e.lines.filter((l) => l.group === 'EXTERNAL'), total: e.externalCostUsd, typeKey: 'externalCostUsd' },
    { key: 'other', title: 'Other', swatch: 'bg-ink-600', rows: e.lines.filter((l) => l.group === 'LABOUR' || l.group === 'OTHER'), total: null, typeKey: null },
  ].filter((g) => g.rows.length > 0);

  // A section that has figures to fill when the page opens starts open; a
  // complete one starts folded to its subtotal. Decided once, so a section
  // does not fold shut under the cursor as its last price is typed. Once
  // somebody opens or closes one, theirs wins.
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const startOpen = useRef<Record<string, boolean> | null>(null);
  if (startOpen.current == null && costing.data != null && seededFor.current === order.id) {
    startOpen.current = Object.fromEntries(groups.map((g) => [g.key, g.rows.some((l) => lineMissing(l) > 0)]));
  }
  const isOpen = (key: string, missing: number) => fold[key] ?? startOpen.current?.[key] ?? missing > 0;

  // How much of the plan is known: the six order and line figures, and a
  // quantity and a price for every row.
  const head = [e.orderQty, e.sellPriceUsd, e.dailyCostUsd, e.machineCount, e.lineMachines, e.targetPerDay];
  const totalFigures = head.length + e.lines.length * 2;
  const filled = head.filter((f) => f.value != null).length
    + e.lines.reduce((a, l) => a + (l.qty.value != null ? 1 : 0) + (l.price.value != null ? 1 : 0), 0);
  const toFill = totalFigures - filled;

  const actualUnit = c.unitActualCostUsd;
  const diff = actualUnit != null && e.unitCostUsd != null ? actualUnit - e.unitCostUsd : null;
  const profit = e.profitPerUnitUsd;
  // Missing figures leave the cost too low, so the profit is only provisional:
  // shown in plain white, not as good news, until every figure is known.
  const provisional = toFill > 0;
  const profitTone = profit == null || provisional ? 'text-white' : profit < 0 ? 'text-red-300' : 'text-emerald-300';
  const provisionalNote = `provisional — ${toFill} figure${toFill === 1 ? '' : 's'} still to fill`;
  const revenue = qty != null && e.sellPriceUsd.value != null ? qty * e.sellPriceUsd.value : null;
  const identity = [c.identity.customer, c.identity.orderName, c.identity.poNumber && `PO ${c.identity.poNumber}`]
    .filter(Boolean).join(' · ');

  const parts = [
    { key: 'fabric', name: 'Fabric', swatch: 'bg-accent-500', cost: e.fabricCostUsd },
    { key: 'acc', name: 'Accessories', swatch: 'bg-accent-300', cost: e.accessoryCostUsd },
    { key: 'ext', name: 'Outside work', swatch: 'bg-ink-300', cost: e.externalCostUsd },
    { key: 'cm', name: 'Cut & make', swatch: 'bg-ink-500', cost: e.cmCostUsd },
    { key: 'other', name: 'Other', swatch: 'bg-ink-600', cost: e.otherTotalUsd },
  ].filter((p) => p.key !== 'other' || p.cost != null);
  const partsSum = parts.reduce((a, p) => a + (p.cost != null && p.cost > 0 ? p.cost : 0), 0);
  const share = (n: number | null) => (n != null && e.totalCostUsd ? fmtPct((n / e.totalCostUsd) * 100, 1) : '—');

  return (
    <div className="screen-only space-y-4">
      {/* ── The answer: one dark band, as on the actual costing. ───────── */}
      <section className="overflow-hidden rounded-lg bg-ink-900 text-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/10 px-5 py-3">
          <p className="min-w-0 truncate text-2xs font-semibold uppercase tracking-wider text-ink-400">
            Planned costing{identity && <span className="ml-2 font-normal normal-case tracking-normal text-ink-300">{identity}</span>}
          </p>
          <div className="flex shrink-0 items-center gap-3">
            {editable && <SaveNote state={save} />}
            <span className={clsx(
              'rounded-full px-2.5 py-1 text-2xs font-semibold ring-1 ring-inset',
              toFill === 0 ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/40' : 'bg-amber-400/15 text-amber-300 ring-amber-400/40',
            )}>
              {toFill === 0 ? 'Complete' : `${toFill} figure${toFill === 1 ? '' : 's'} to fill`}
            </span>
          </div>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <div className="border-b border-white/10 px-5 py-5 lg:border-b-0 lg:border-r">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">Planned profit per piece</p>
            <p className={clsx('tnum mt-1 truncate text-4xl font-semibold leading-none tracking-tight', profit == null ? 'text-ink-500' : profitTone)}>
              {profit == null ? '—' : price(profit)}
            </p>
            <p className="mt-1.5 text-2xs leading-snug text-ink-400">
              {profit != null && qty != null
                ? `${money(profit * qty)} in all, on ${fmtNumber(qty)} pieces ordered`
                : 'selling price − planned cost per piece'}
            </p>
            {provisional && profit != null && (
              <p className="mt-1 text-2xs font-medium text-amber-300">{provisionalNote[0]!.toUpperCase() + provisionalNote.slice(1)}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-px bg-white/10 xl:grid-cols-4 [&>*]:bg-ink-900 [&>*]:px-5 [&>*]:py-5">
            <DarkStat label="Planned cost / piece" value={price(e.unitCostUsd)} note={provisional && e.unitCostUsd != null ? 'so far — figures still to fill' : 'planned total ÷ order quantity'} />
            <DarkStat label="Planned total" value={money(e.totalCostUsd)} note={provisional && e.totalCostUsd != null ? 'so far — figures still to fill' : 'every cost row, added up'} />
            <DarkStat label="Selling price" value={price(e.sellPriceUsd.value)} note={e.sellPriceUsd.source === 'typed' ? 'typed here' : 'from the PO'} />
            <DarkStat
              label="Planned margin"
              value={e.profitPct == null ? '—' : fmtPct(e.profitPct, 1)}
              note="profit ÷ selling price"
              valueClass={e.profitPct == null ? undefined : profitTone}
            />
          </div>
        </div>

        <div className="grid gap-x-8 gap-y-5 border-t border-white/10 px-5 py-4 lg:grid-cols-2">
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">What the cost is made of</p>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/10" aria-hidden>
              {partsSum > 0 && parts.map((p) => (p.cost ? (
                <div key={p.key} className={p.swatch} style={{ width: `${(p.cost / partsSum) * 100}%` }} />
              ) : null))}
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
              {parts.map((p) => (
                <li key={p.key} className="flex items-center gap-1.5 text-xs">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-sm', p.swatch)} />
                  <span className="text-ink-300">{p.name}</span>
                  <span className={clsx('tnum font-semibold', p.cost == null ? 'text-ink-500' : 'text-white')}>{money(p.cost)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">Planned against actual</p>
            {diff != null ? (
              <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-ink-300">
                <span>Planned <span className="tnum font-semibold text-white">{price(e.unitCostUsd)}</span></span>
                <span>Actual <span className="tnum font-semibold text-white">{price(actualUnit)}</span></span>
                <span className={clsx('tnum font-semibold', diff > 0.00005 ? 'text-red-300' : 'text-emerald-300')}>
                  {Math.abs(diff) < 0.00005 ? 'on plan' : `${price(Math.abs(diff))} a piece ${diff > 0 ? 'over' : 'under'} plan`}
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-400">Shown once the actual costing has a cost per piece.</p>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 px-5 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-300">Figures known</span>
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
              <div className={clsx('h-full rounded-full', toFill === 0 ? 'bg-emerald-400' : 'bg-amber-400')} style={{ width: `${totalFigures ? (filled / totalFigures) * 100 : 0}%` }} />
            </div>
            <span className="tnum text-xs text-ink-300">{filled} of {totalFigures}</span>
            {e.missing.length > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-amber-300">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                Still to fill: {e.missing.join(', ')}.
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ── The figures the cost is worked out from. ───────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={<Numbered n={1}>Order</Numbered>} subtitle="What is being made, and what it sells for." />
          <div className="divide-y divide-ink-100">
            <Row label="Order quantity" note="Main Order total, pieces">{fig('orderQty', e.orderQty, 'number')}</Row>
            <Row label="Selling price" note="per piece, from the PO">{fig('sellPriceUsd', e.sellPriceUsd, 'price')}</Row>
            <Row label="Planned revenue" note="quantity × selling price"><Calc value={money(revenue)} /></Row>
            <Row label="Profit per piece" note="selling price − planned cost per piece">{fig('profitPerUnitUsd', d.profitPerUnitUsd, 'price', { allowZero: true })}</Row>
            <Row label="Planned margin" note="profit ÷ selling price, %">{fig('profitPct', d.profitPct, 'pct', { allowZero: true })}</Row>
            <Row label="Planned profit" note="profit per piece × quantity">
              <Calc value={money(profit != null && qty != null ? profit * qty : null)} />
            </Row>
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={<Numbered n={2}>Line &amp; cut-and-make</Numbered>} subtitle="The factory's figures and the line plan, giving the C.M." />
          <div className="divide-y divide-ink-100">
            <Row label="Factory daily cost" note="dollars a day, whole factory">{fig('dailyCostUsd', e.dailyCostUsd, 'money')}</Row>
            <Row label="Factory machines" note="all machines">{fig('machineCount', e.machineCount, 'number')}</Row>
            <Row label="Machines on the line" note="from the Production line plan">{fig('lineMachines', e.lineMachines, 'number')}</Row>
            <Row label="Target per day" note="pieces, from Production">{fig('targetPerDay', e.targetPerDay, 'number')}</Row>
            <Row label="Machine cost per day" note="daily cost ÷ factory machines">{fig('machineCostPerDay', d.machineCostPerDay, 'price')}</Row>
            <Row label="Days in line" note="quantity ÷ target, rounded up">{fig('daysInLine', d.daysInLine, 'number')}</Row>
            <Row label="C.M per piece" note="same formula as the actual costing">{fig('cmPerPieceUsd', d.cmPerPieceUsd, 'price', { allowZero: true })}</Row>
          </div>
        </Card>
      </div>

      {/* ── Every planned cost row. ───────────────────────────────────── */}
      <Card className="overflow-hidden">
        <CardHeader
          title={<Numbered n={3}>Cost breakdown</Numbered>}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Planned quantities and prices for the whole order.</span>
              <Legend swatch="text-emerald-600" label="auto — from the order" />
              <Legend swatch="border border-amber-400 bg-amber-50" box label="to fill" />
              <Legend swatch="border border-violet-300" box label="typed — ↺ puts the figure back" />
            </span>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Item</th>
                <th className="th text-right">Planned qty</th>
                <th className="th">Unit</th>
                <th className="th text-right">Unit price</th>
                <th className="th text-right">Cost</th>
                <th className="th text-right">Per piece</th>
                <th className="th text-right">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {groups.length === 0 && (
                <tr><td colSpan={7} className="td py-6 text-center text-ink-500">Nothing on the bill of materials or the External Order yet.</td></tr>
              )}
              {groups.map((g) => {
                const missing = g.rows.reduce((a, l) => a + lineMissing(l), 0);
                const open = isOpen(g.key, missing);
                return (
                  <GroupRows
                    key={g.key}
                    title={g.title}
                    swatch={g.swatch}
                    count={g.rows.length}
                    missing={missing}
                    open={open}
                    onToggle={() => setFold((f) => ({ ...f, [g.key]: !open }))}
                    total={g.typeKey
                      ? fig(g.typeKey, d[g.typeKey as 'fabricCostUsd' | 'accessoryCostUsd' | 'externalCostUsd'], 'money', { allowZero: true })
                      : money(g.total)}
                    perPiece={perPc(g.total)}
                    share={share(g.total)}
                  >
                    {open && g.rows.map((l) => (
                      <tr key={l.ref} className="hover:bg-ink-50/50">
                        <td className="td pl-10 text-ink-800">{l.label}</td>
                        <td className="td text-right">{fig(`qty:${l.ref}`, l.qty, 'number')}</td>
                        <td className="td text-ink-500">{l.unit}</td>
                        <td className="td text-right">{fig(`price:${l.ref}`, l.price, 'price', { allowZero: true })}</td>
                        <td className={clsx('td tnum text-right', l.cost == null ? 'text-ink-300' : 'font-medium text-ink-900')}>{money(l.cost)}</td>
                        <td className="td tnum text-right text-ink-500">{price(perPc(l.cost))}</td>
                        <td className="td tnum text-right text-ink-400">{share(l.cost)}</td>
                      </tr>
                    ))}
                  </GroupRows>
                );
              })}
              <tr className="bg-ink-50/70">
                <td className="td font-semibold text-ink-800" colSpan={4}>
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-ink-500 align-middle" />
                  Cut &amp; make (C.M)
                  <span className="ml-2 text-2xs font-normal text-ink-400">
                    {e.daysInLine != null && e.lineMachines.value != null
                      ? `${e.lineMachines.value} machines × ${e.daysInLine} day${e.daysInLine === 1 ? '' : 's'}`
                      : 'needs the line figures in section 2'}
                  </span>
                </td>
                <td className="td tnum text-right font-semibold">{money(e.cmCostUsd)}</td>
                <td className="td tnum text-right text-ink-500">{price(e.cmCostPerPieceUsd)}</td>
                <td className="td tnum text-right text-ink-400">{share(e.cmCostUsd)}</td>
              </tr>
              <tr className="bg-ink-50/70">
                <td className="td font-semibold text-ink-800" colSpan={3}>
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-ink-600 align-middle" />
                  Other costs <span className="ml-2 text-2xs font-normal text-ink-400">whole order, optional</span>
                </td>
                <td className="td text-right" colSpan={2}>
                  <div className="flex justify-end">{fig('otherCostUsd', e.otherCostUsd, 'money', { allowZero: true })}</div>
                </td>
                <td className="td tnum text-right text-ink-500">{price(perPc(e.otherCostUsd.value))}</td>
                <td className="td tnum text-right text-ink-400">{share(e.otherCostUsd.value)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="bg-ink-900 text-white">
                <td className="px-4 py-3 font-semibold" colSpan={3}>Planned total</td>
                <td className="px-4 py-3 text-right text-xs text-ink-300">{qty != null ? `${fmtNumber(qty)} pcs` : ''}</td>
                <td className="tnum px-4 py-3 text-right font-semibold">{fig('totalCostUsd', d.totalCostUsd, 'money', { allowZero: true, dark: true })}</td>
                <td className="tnum px-4 py-3 text-right font-semibold">{fig('unitCostUsd', d.unitCostUsd, 'price', { allowZero: true, dark: true })}</td>
                <td className="tnum px-4 py-3 text-right text-ink-300">{e.totalCostUsd != null ? '100%' : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Figure({
  figure, kind, editable, typing, text, onText, onDone, onReset, allowZero, signed, dark, worked,
}: {
  figure: ExpectedFigure; kind: Kind; editable: boolean; typing: boolean; text: string;
  onText: (v: string) => void; onDone: () => void; onReset: () => void;
  /** A worked-out figure: blank only until the figures it comes from are known, so never "to fill". */
  allowZero?: boolean; signed?: boolean; dark?: boolean; worked?: boolean;
}) {
  const tag = figure.source === 'typed' || typing
    ? null
    : figure.source === 'auto'
      ? <span className="w-7 text-[10px] font-semibold uppercase tracking-wide text-emerald-600" title="From the order">auto</span>
      : figure.source === 'calc'
        ? <span className={clsx('w-7 text-[10px] font-semibold uppercase tracking-wide', dark ? 'text-ink-400' : 'text-ink-400')} title="Worked out from the figures above">calc</span>
        : <span className="w-7" />;
  if (!editable) {
    return (
      <span className="inline-flex items-baseline justify-end gap-1.5 whitespace-nowrap">
        <span className={clsx('tnum font-semibold', figure.value == null ? 'text-ink-300' : figure.source === 'typed' ? 'text-violet-700' : dark ? 'text-white' : 'text-ink-900')}>
          {show(figure.value, kind)}
        </span>
        {tag ?? <span className="w-7 text-[10px] font-semibold uppercase tracking-wide text-violet-500">typed</span>}
      </span>
    );
  }
  const r = readTypedNumber(text);
  const bad = typing && (!r.ok || (r.value != null && !signed && (r.value < 0 || (!allowZero && r.value === 0))));
  const typed = typing && text.trim() !== '';
  const empty = !typing && figure.value == null && !worked;
  const canReset = typing && figure.base != null;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      <input
        className={clsx(
          'input h-8 w-28 text-right tnum',
          bad ? 'border-red-400 focus:border-red-500'
            : typed ? 'border-violet-300 text-violet-800'
              : empty ? 'border-amber-400 bg-amber-50/60' : 'text-ink-900',
        )}
        inputMode="decimal"
        placeholder={figure.base != null ? plain(figure.base, kind) : worked ? '—' : kind === 'number' || kind === 'pct' ? '0' : '$0.00'}
        title={bad
          ? (r.ok ? 'Must be more than 0' : r.reason)
          : typed ? (figure.base != null ? `Typed — was ${show(figure.base, kind)}` : 'Typed')
            : empty ? 'Not known yet — type it here'
              : figure.value == null ? 'Worked out once the figures it comes from are known — or type it'
              : figure.source === 'auto' ? 'From the order — type to change it' : 'Worked out — type to change it'}
        value={typing ? text : plain(figure.value, kind)}
        onChange={(ev) => onText(ev.target.value)}
        onBlur={onDone}
      />
      {canReset ? (
        <button
          type="button"
          className="grid w-7 place-items-center rounded text-violet-500 hover:bg-violet-50 hover:text-violet-700"
          title={`Put back ${show(figure.base, kind)}`}
          aria-label={`Put back ${show(figure.base, kind)}`}
          onClick={onReset}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      ) : (tag ?? <span className="w-7" />)}
    </span>
  );
}

function Numbered({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="tnum grid h-5 w-5 shrink-0 place-items-center rounded bg-ink-900 text-2xs font-semibold text-white">{n}</span>
      {children}
    </span>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[3.25rem] items-center justify-between gap-4 px-4 py-2">
      <div className="min-w-0">
        <p className="text-sm text-ink-800">{label}</p>
        {note && <p className="text-2xs text-ink-400">{note}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Calc({ value, strong }: { value: string; strong?: boolean }) {
  return <span className={clsx('tnum text-sm', strong ? 'font-semibold text-ink-900' : 'font-medium text-ink-700', value === '—' && 'text-ink-300')}>{value}</span>;
}

function DarkStat({ label, value, note, valueClass }: { label: string; value: string; note?: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">{label}</p>
      <p className={clsx('tnum mt-1 truncate text-lg font-semibold leading-none', value === '—' ? 'text-ink-500' : (valueClass ?? 'text-white'))}>{value}</p>
      {note && <p className="mt-1.5 text-2xs leading-snug text-ink-400">{note}</p>}
    </div>
  );
}

function Legend({ swatch, label, box }: { swatch: string; label: string; box?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-ink-500">
      {box ? <span className={clsx('inline-block h-3 w-4 rounded-sm', swatch)} /> : <span className={clsx('text-[10px] font-semibold uppercase', swatch)}>auto</span>}
      {box ? label : label.replace(/^auto — /, '')}
    </span>
  );
}

function GroupRows({
  title, swatch, count, missing, open, onToggle, total, perPiece, share, children,
}: {
  title: string; swatch: string; count: number; missing: number; open: boolean; onToggle: () => void;
  total: ReactNode; perPiece: number | null; share: string; children: ReactNode;
}) {
  return (
    <>
      <tr className="cursor-pointer bg-ink-50/70 hover:bg-ink-100/60" onClick={onToggle}>
        <td className="td font-semibold text-ink-800" colSpan={4}>
          <button
            type="button"
            className="flex items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 rounded"
            aria-expanded={open}
            onClick={(ev) => { ev.stopPropagation(); onToggle(); }}
          >
            <ChevronDown className={clsx('h-4 w-4 text-ink-400 transition-transform', !open && '-rotate-90')} />
            <span className={clsx('inline-block h-2.5 w-2.5 rounded-sm', swatch)} />
            {title}
            <span className="text-2xs font-normal text-ink-400">{count} row{count === 1 ? '' : 's'}</span>
            {missing > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-2xs font-medium text-amber-800">{missing} to fill</span>
            )}
          </button>
        </td>
        <td className="td tnum text-right font-semibold" onClick={(ev) => ev.stopPropagation()}>{total}</td>
        <td className="td tnum text-right text-ink-500">{price(perPiece)}</td>
        <td className="td tnum text-right text-ink-400">{share}</td>
      </tr>
      {children}
    </>
  );
}

function SaveNote({ state }: { state: 'clean' | 'saving' | 'error' }) {
  if (state === 'error') return <span className="flex items-center gap-1 text-2xs text-red-300"><CloudOff className="h-3.5 w-3.5" /> Not saved — keep typing to retry</span>;
  return (
    <span className="flex items-center gap-1 text-2xs text-ink-400">
      <Cloud className="h-3.5 w-3.5" /> {state === 'saving' ? 'Saving…' : 'Saved'}
    </span>
  );
}
