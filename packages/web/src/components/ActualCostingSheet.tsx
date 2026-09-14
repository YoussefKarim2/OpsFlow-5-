/**
 * Actual Costing — the workbook's `Actual Costing_Coordinator` sheet.
 *
 * This is deliberately a worksheet and not a dashboard. The coordinators who
 * use it have read this exact grid in Excel for years: the header block on the
 * left, the machine economics in the middle, the money on the right, the two
 * rows of production quantities, then the costing table with UsedFabric above
 * UsedAcc. Rearranging it into cards would mean relearning where every number
 * lives, in exchange for nothing.
 *
 * What is different from the workbook is what is *behind* the cells. The sheet
 * is typed; this is read. The customer, the style, the order and shipped
 * quantities, the materials and their prices all come from the sections that
 * already record them, so the costing is the cost of what actually happened
 * rather than a second set of figures somebody retyped. Only the factory's own
 * inputs — the dollar rate, the daily cost, the machine counts — are typed
 * here, because nothing else in the application knows them.
 *
 * And the five `#DIV/0!` cells the live workbook shows today never appear.
 * Every division goes through `safeDiv` in @opsflow/shared and renders as
 * "Not calculated", with a note saying which fact is missing.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, RotateCcw, Save } from 'lucide-react';
import {
  fmtDate, fmtMoney, fmtNumber, fmtPct, NOT_CALCULATED,
  type CostLineResult, type OrderDetailDto,
} from '@opsflow/shared';
import { api, type CostLineDto, type CostingDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorNote, clsx } from './ui';

/** The six columns of the costing table, as the sheet prints them. */
const COLUMNS = ['Item', 'Actual Cons.', 'Unit', 'Unite Price', 'Cost', 'Percentage'] as const;

/** The factory's own numbers — the only cells on this sheet a person types. */
interface Draft {
  costingDate: string;
  dollarRate: string;
  dailyCostEgp: string;
  machineCount: string;
  lineMachineQty: string;
  daysInLine: string;
  machineDaysUsed: string;
  sublimationCostUsd: string;
  embroideryCostUsd: string;
  notes: string;
}

const numText = (v: number | null | undefined): string => (v == null ? '' : String(v));

function draftFrom(record: CostingDto | null): Draft {
  return {
    costingDate: record?.costingDate?.slice(0, 10) ?? '',
    dollarRate: numText(record?.dollarRate),
    dailyCostEgp: numText(record?.dailyCostEgp),
    machineCount: numText(record?.machineCount),
    lineMachineQty: numText(record?.lineMachineQty),
    daysInLine: numText(record?.daysInLine),
    machineDaysUsed: numText(record?.machineDaysUsed),
    sublimationCostUsd: numText(record?.sublimationCostUsd),
    embroideryCostUsd: numText(record?.embroideryCostUsd),
    notes: record?.notes ?? '',
  };
}

/** Empty means "nobody has said", which is not the same as zero. */
const asNumber = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function ActualCostingSheet({ order }: { order: OrderDetailDto }) {
  const c = order.costing;
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can('costing:write');

  const costing = useQuery({
    queryKey: ['costing', order.id],
    queryFn: () => api.steps.costing(order.id),
    enabled: can('costing:read'),
  });

  const record = costing.data?.data ?? null;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(record));
  const [baseline, setBaseline] = useState<Draft>(() => draftFrom(record));

  // Re-seed when the server's copy actually changes — including when the user
  // switches to a different order, which replaces the data without remounting.
  //
  // Keyed on the values rather than the object: the query refetches in the
  // background and hands back a new object every time, which would throw away
  // whatever the coordinator was in the middle of typing.
  const serverState = `${order.id}|${JSON.stringify(draftFrom(record))}`;
  useEffect(() => {
    const next = draftFrom(record);
    setDraft(next);
    setBaseline(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverState]);

  const dirty = useMemo(
    () => (Object.keys(draft) as Array<keyof Draft>).some((k) => draft[k] !== baseline[k]),
    [draft, baseline],
  );

  const save = useMutation({
    mutationFn: () => api.steps.saveCosting(order.id, {
      costingDate: draft.costingDate || null,
      dollarRate: asNumber(draft.dollarRate) ?? undefined,
      dailyCostEgp: asNumber(draft.dailyCostEgp),
      machineCount: asNumber(draft.machineCount),
      lineMachineQty: asNumber(draft.lineMachineQty),
      daysInLine: asNumber(draft.daysInLine),
      machineDaysUsed: asNumber(draft.machineDaysUsed),
      sublimationCostUsd: asNumber(draft.sublimationCostUsd),
      embroideryCostUsd: asNumber(draft.embroideryCostUsd),
      notes: draft.notes || null,
      // Derived lines are recomputed server-side on every save; only the
      // hand-entered ones are sent back, or they would be lost.
      manualLines: (record?.lines ?? [])
        .filter((l) => l.source === 'MANUAL')
        .map((l) => ({
          group: l.group, label: l.label, quantity: l.quantity,
          unit: l.unit, unitPriceUsd: l.unitPriceUsd, note: l.note ?? null,
        })),
    }),
    onSuccess: () => {
      setBaseline(draft);
      void qc.invalidateQueries({ queryKey: ['costing', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
  });

  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  // Before the first save the table shows what the production sections would
  // contribute, so the screen is demonstrably working rather than blank.
  const stored = c.lines;
  const fallback: CostLineResult[] = (costing.data?.derived ?? []).map((l: CostLineDto) => ({
    group: l.group, label: l.label, quantity: l.quantity, unit: l.unit,
    unitPriceUsd: l.unitPriceUsd, sourceRef: l.sourceRef ?? null,
    cost: l.quantity != null && l.unitPriceUsd != null ? l.quantity * l.unitPriceUsd : null,
    pctOfTotal: null,
  }));
  const showingProposed = stored.length === 0 && fallback.length > 0;

  const fabric = showingProposed ? fallback.filter((l) => l.group === 'FABRIC') : c.groups.fabric.lines;
  const accessory = showingProposed ? fallback.filter((l) => l.group === 'ACCESSORY') : c.groups.accessory.lines;
  const otherExternal = showingProposed
    ? fallback.filter((l) => l.group === 'EXTERNAL')
    : c.groups.external.lines;
  const otherLines = showingProposed ? fallback.filter((l) => l.group === 'OTHER') : c.groups.other.lines;

  return (
    <div className="space-y-3 p-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Legend />
        <div className="flex items-center gap-2">
          <button className="btn-secondary btn-sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
          {editable && (
            <>
              <button
                className="btn-ghost btn-sm"
                disabled={!dirty || save.isPending}
                onClick={() => setDraft(baseline)}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Discard
              </button>
              <button
                className="btn-primary btn-sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate()}
              >
                <Save className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      </div>

      {save.isError && <ErrorNote error={save.error} />}

      <MissingNotes order={order} />

      <div className="print-document overflow-x-auto border border-ink-400 bg-white">
        <table className="xl min-w-[62rem]">
          <colgroup>
            <col className="w-[13%]" /><col className="w-[20%]" />
            <col className="w-[13%]" /><col className="w-[14%]" />
            <col className="w-[13%]" /><col className="w-[13%]" />
            <col className="w-[14%]" />
          </colgroup>

          <tbody>
            {/* ── Title ─────────────────────────────────────────────────── */}
            <tr>
              <td className="xl-banner" colSpan={7}>Actual Costing_Coordinator</td>
            </tr>

            {/* ── Header: identity · machines · money ───────────────────── */}
            <HeaderRow
              left={['Date', c.costingDate ? fmtDate(c.costingDate) : fmtDate(order.poDate)]}
              mid={['Dollar Rate', editable
                ? <Cell value={draft.dollarRate} onChange={set('dollarRate')} placeholder="EGP/$" step="0.0001" />
                : <ReadOnly text={fmtNumber(c.dollarRate, { places: 2 })} />]}
              right={['Daily Cost', editable
                ? <Cell value={draft.dailyCostEgp} onChange={set('dailyCostEgp')} placeholder="EGP/day" step="0.01" />
                : <ReadOnly text={fmtNumber(c.dailyCostEgp, { places: 2 })} />]}
            />
            <HeaderRow
              left={['Customer', order.client.name]}
              mid={['All F. Machines', editable
                ? <Cell value={draft.machineCount} onChange={set('machineCount')} step="1" />
                : <ReadOnly text={fmtNumber(c.machineCount)} />]}
              right={['Sell Price', <Calc key="sp" text={fmtMoney(c.sellPriceUsd)} />]}
            />
            <HeaderRow
              left={['Order Name', order.orderName]}
              mid={['Machine Cost', <Calc key="mc" text={
                c.machineCostEgpPerDay == null ? NOT_CALCULATED : `${fmtNumber(c.machineCostEgpPerDay, { places: 2 })} EGP`
              } />]}
              right={['Actual Cost/Unit', <Calc key="acu" text={fmtMoney(c.unitActualCostUsd)} />]}
            />
            <HeaderRow
              left={['Item Type', order.itemType]}
              mid={['Line Machines Qty', editable
                ? <Cell value={draft.lineMachineQty} onChange={set('lineMachineQty')} step="1" />
                : <ReadOnly text={fmtNumber(c.lineMachineQty)} />]}
              right={['Profit', <Result key="pf" text={fmtMoney(c.profitPerUnitUsd)} tone={c.isProfitable} />]}
            />
            <HeaderRow
              left={['Po No', order.poNumber]}
              mid={['Days in line', editable
                ? <Cell value={draft.daysInLine} onChange={set('daysInLine')} step="1" />
                : <ReadOnly text={fmtNumber(c.daysInLine)} />]}
              right={['Pro. Percentage', <Result key="pp" text={fmtPct(c.profitPct, 1)} tone={c.isProfitable} />]}
            />
            <HeaderRow
              left={['Style No', order.styleNumber]}
              mid={['Machine Already Used', editable
                ? <Cell value={draft.machineDaysUsed} onChange={set('machineDaysUsed')} step="1" />
                : <ReadOnly text={fmtNumber(c.machineDaysUsed)} />]}
              right={['Perfect price', <Result key="tp" text={
                // The sheet's `=IF(profit<=0, cost×1.2, "Perfect")`: a price
                // that would restore a 20% margin, or the word when there is
                // nothing to fix.
                c.targetPriceUsd != null ? fmtMoney(c.targetPriceUsd)
                  : c.isProfitable === true ? 'Perfect'
                  : NOT_CALCULATED
              } tone={c.isProfitable} />]}
            />

            <tr><td className="h-1.5 border-0 bg-ink-50 p-0" colSpan={7} /></tr>

            {/* ── Production quantities ─────────────────────────────────── */}
            <tr>
              <td className="xl-label">Order Qty</td>
              <td className="xl-qty">{fmtNumber(c.orderQty)}</td>
              <td className="xl-label">Shipped Qty</td>
              <td className="xl-qty">{c.shippedQty == null ? '—' : fmtNumber(c.shippedQty)}</td>
              <td className="xl-label">Diff. Percentage</td>
              <td className="xl-result">{c.diffPct == null ? NOT_CALCULATED : fmtPct(c.diffPct, 1)}</td>
              <td className="xl-calc">
                <span className="float-left font-semibold text-ink-800">Work Days</span>
                {fmtNumber(c.workDays, { places: 1 })}
              </td>
            </tr>
            <tr>
              <td className="xl-label">Cutted Qty</td>
              <td className="xl-qty">{fmtNumber(c.cutQty)}</td>
              <td className="xl-label">1st Degree Qty</td>
              <td className="xl-qty">{c.firstDegreeQty == null ? '—' : fmtNumber(c.firstDegreeQty)}</td>
              <td className="xl-label">2nd Degree Qty</td>
              <td className="xl-qty">{c.secondDegreeQty == null ? '—' : fmtNumber(c.secondDegreeQty)}</td>
              <td className="xl-calc">
                <span className="float-left font-semibold text-ink-800">Productivity rate</span>
                {fmtNumber(c.productivityRate)}
              </td>
            </tr>

            {/* ── Costing table ────────────────────────────────────────── */}
            <tr>
              {COLUMNS.map((h, i) => (
                <td key={h} className="xl-banner" colSpan={i === 0 ? 2 : 1}>{h}</td>
              ))}
            </tr>

            <Section
              caption="UsedFabric"
              lines={fabric}
              emptyText="No fabric on the bill of materials yet"
            />
            <SubtotalRow
              label="Fabric Costing"
              cost={showingProposed ? null : c.groups.fabric.total}
              pct={showingProposed ? null : c.groups.fabric.pctOfTotal}
            />

            <Section
              caption="UsedAcc"
              lines={accessory}
              emptyText="No accessories on the bill of materials yet"
            />
            <SubtotalRow
              label="Accesory Costing"
              cost={showingProposed ? null : c.groups.accessory.total}
              pct={showingProposed ? null : c.groups.accessory.pctOfTotal}
            />

            {/* Outside work. The sheet prints two fixed rows; OpsFlow records
                whatever operations an order actually sent out, so anything
                beyond those two is listed rather than folded away. */}
            <ExternalRow
              label="Sublimation"
              cost={c.sublimationCostUsd}
              total={c.totalCostUsd}
              editable={editable}
              draftValue={draft.sublimationCostUsd}
              onChange={set('sublimationCostUsd')}
            />
            <ExternalRow
              label="Embroidery"
              cost={c.embroideryCostUsd}
              total={c.totalCostUsd}
              editable={editable}
              draftValue={draft.embroideryCostUsd}
              onChange={set('embroideryCostUsd')}
            />
            {otherExternal.map((l, i) => (
              <LineRow key={`ext-${i}`} line={l} total={showingProposed ? null : c.totalCostUsd} />
            ))}
            {otherLines.map((l, i) => (
              <LineRow key={`oth-${i}`} line={l} total={showingProposed ? null : c.totalCostUsd} />
            ))}

            {/* C.M — the workbook's `=work days × daily cost`, converted. */}
            <tr className="xl-subtotal">
              <td colSpan={2}>C.M</td>
              <td className="tnum text-right">{fmtNumber(c.workDays, { places: 1 })}</td>
              <td className="text-center">DAY</td>
              <td className="tnum text-right">
                {c.dailyCostEgp == null || c.dollarRate == null
                  ? NOT_CALCULATED
                  : fmtMoney(c.dailyCostEgp / c.dollarRate, '$', 4)}
              </td>
              <td className="tnum text-right">{fmtMoney(c.cmCostUsd)}</td>
              <td className="tnum text-right">{fmtPct(pctOf(c.cmCostUsd, c.totalCostUsd), 1)}</td>
            </tr>

            <tr className="xl-total">
              <td colSpan={4}>Total</td>
              <td />
              <td className="tnum text-right">{fmtMoney(c.totalCostUsd)}</td>
              <td className="tnum text-right">{c.totalCostUsd == null ? NOT_CALCULATED : '100.0%'}</td>
            </tr>

            {/* ── Notes ────────────────────────────────────────────────── */}
            <tr>
              <td className="xl-label bg-amber-100">Notes :</td>
              <td className="bg-amber-100 p-0" colSpan={6}>
                {editable ? (
                  <textarea
                    className="w-full resize-y border-0 bg-transparent px-2 py-1 text-xs text-ink-900
                               focus:bg-white focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent-500"
                    rows={2}
                    value={draft.notes}
                    onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                    placeholder="Anything about this costing that the numbers do not say."
                  />
                ) : (
                  <p className="whitespace-pre-wrap px-2 py-1 text-xs text-ink-800">{c.notes ?? '—'}</p>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {showingProposed && (
        <p className="no-print text-2xs text-ink-500">
          These material rows are what the bill of materials and the outside work currently support.
          They are stored against the costing the first time it is saved.
        </p>
      )}
    </div>
  );
}

/** cost ÷ total as a percentage, never a division by zero. */
function pctOf(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole === 0) return null;
  return (part / whole) * 100;
}

function HeaderRow({
  left, mid, right,
}: {
  left: [string, React.ReactNode];
  mid: [string, React.ReactNode];
  right: [string, React.ReactNode];
}) {
  return (
    <tr>
      <td className="xl-label">{left[0]}</td>
      <td className="xl-calc text-center">{left[1] || '—'}</td>
      <td className="xl-label">{mid[0]}</td>
      {typeof mid[1] === 'string' ? <td className="xl-calc">{mid[1]}</td> : mid[1]}
      <td className="xl-label">{right[0]}</td>
      {typeof right[1] === 'string' ? <td className="xl-calc" colSpan={2}>{right[1]}</td> : right[1]}
    </tr>
  );
}

/** A cell the coordinator types into. */
function Cell({
  value, onChange, placeholder, step,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; step?: string;
}) {
  return (
    <td className="xl-input">
      <input
        type="number"
        min={0}
        step={step ?? 'any'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </td>
  );
}

function ReadOnly({ text }: { text: string }) {
  return <td className="xl-calc">{text}</td>;
}

function Calc({ text }: { text: string }) {
  return <td className="xl-calc" colSpan={2}>{text}</td>;
}

function Result({ text, tone }: { text: string; tone: boolean | null }) {
  return (
    <td
      className={clsx(
        'xl-result',
        tone === true && 'text-emerald-800',
        tone === false && 'text-red-700',
      )}
      colSpan={2}
    >
      {text}
    </td>
  );
}

/** A block of material rows with the sheet's row-spanning caption on the left. */
function Section({
  caption, lines, emptyText,
}: {
  caption: string; lines: readonly CostLineResult[]; emptyText: string;
}) {
  if (lines.length === 0) {
    return (
      <tr>
        <td className="xl-section">{caption}</td>
        <td className="px-2 py-1 text-2xs italic text-ink-400" colSpan={6}>{emptyText}</td>
      </tr>
    );
  }
  return (
    <>
      {lines.map((l, i) => (
        <tr key={`${caption}-${i}`}>
          {i === 0 && <td className="xl-section" rowSpan={lines.length}>{caption}</td>}
          <td className="truncate text-ink-800" title={l.label}>{l.label}</td>
          <td className="tnum text-right">{fmtNumber(l.quantity, { places: 2, fallback: '—' })}</td>
          <td className="text-center text-ink-600">{l.unit || '—'}</td>
          <td className="tnum text-right">
            {l.unitPriceUsd == null ? '—' : fmtMoney(l.unitPriceUsd, '$', 4)}
          </td>
          <td className="tnum text-right">{l.cost == null ? '—' : fmtMoney(l.cost)}</td>
          <td className="tnum text-right">
            {l.pctOfTotal == null ? '—' : fmtPct(l.pctOfTotal, 1)}
          </td>
        </tr>
      ))}
    </>
  );
}

/** The "Fabric Costing" / "Accesory Costing" rows the sheet prints. */
function SubtotalRow({ label, cost, pct }: { label: string; cost: number | null; pct: number | null }) {
  return (
    <tr className="xl-subtotal">
      <td colSpan={5}>{label}</td>
      <td className="tnum text-right">{cost == null ? NOT_CALCULATED : fmtMoney(cost)}</td>
      <td className="tnum text-right">{pct == null ? '—' : fmtPct(pct, 1)}</td>
    </tr>
  );
}

function LineRow({ line, total }: { line: CostLineResult; total: number | null }) {
  return (
    <tr>
      <td className="xl-section" />
      <td className="truncate text-ink-800" title={line.label}>{line.label}</td>
      <td className="tnum text-right">{fmtNumber(line.quantity, { places: 2, fallback: '—' })}</td>
      <td className="text-center text-ink-600">{line.unit || '—'}</td>
      <td className="tnum text-right">
        {line.unitPriceUsd == null ? '—' : fmtMoney(line.unitPriceUsd, '$', 4)}
      </td>
      <td className="tnum text-right">{line.cost == null ? '—' : fmtMoney(line.cost)}</td>
      <td className="tnum text-right">{fmtPct(pctOf(line.cost, total), 1)}</td>
    </tr>
  );
}

/**
 * Sublimation and Embroidery.
 *
 * Either the External Order section already priced the work, in which case the
 * figure is read from there, or nobody has and a coordinator types it. A typed
 * figure replaces the derived one rather than adding to it — billing the same
 * sublimation twice is the kind of error a costing sheet exists to prevent.
 */
function ExternalRow({
  label, cost, total, editable, draftValue, onChange,
}: {
  label: string;
  cost: number | null;
  total: number | null;
  editable: boolean;
  draftValue: string;
  onChange: (v: string) => void;
}) {
  return (
    <tr>
      <td className="xl-section" />
      <td className="font-medium text-ink-800">{label}</td>
      <td colSpan={2} className="text-center text-2xs text-ink-400">
        {draftValue.trim() === '' && cost != null ? 'from outside work' : ''}
      </td>
      {editable ? (
        <td className="xl-input">
          <input
            type="number"
            min={0}
            step="0.01"
            value={draftValue}
            placeholder={cost == null ? '' : String(cost)}
            onChange={(e) => onChange(e.target.value)}
          />
        </td>
      ) : (
        <td className="xl-calc" />
      )}
      <td className="tnum text-right">{cost == null ? '—' : fmtMoney(cost)}</td>
      <td className="tnum text-right">{fmtPct(pctOf(cost, total), 1)}</td>
    </tr>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-2xs text-ink-500">
      <Swatch className="bg-orange-100" label="Counted in production" />
      <Swatch className="bg-amber-100" label="Calculated result" />
      <Swatch className="bg-sky-50" label="Typed here" />
      <Swatch className="bg-white" label="Read from the order" />
    </div>
  );
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={clsx('h-3 w-3 rounded-sm border border-ink-400', className)} />
      {label}
    </span>
  );
}

/**
 * What is missing, and where it is entered.
 *
 * The workbook shows `#DIV/0!` and leaves the reader to work out why. Naming
 * the missing fact, and the screen that holds it, is the whole point of
 * replacing the workbook.
 */
function MissingNotes({ order }: { order: OrderDetailDto }) {
  const c = order.costing;
  const missing: string[] = [];
  if (c.shippedQty == null) missing.push('the shipped quantity (recorded on Packing & Shipping) — the unit cost, profit and difference percentage divide by it');
  if (c.dailyCostEgp == null) missing.push("the factory's daily cost, typed on this sheet — the C.M cost is work days × daily cost");
  if (c.machineCount == null) missing.push('the factory machine count, typed on this sheet — machine cost and work days divide by it');
  if (c.dollarRate == null) missing.push('the dollar rate, typed on this sheet — EGP figures convert through it');
  if (c.sellPriceUsd == null) missing.push('the price per piece (Order Details) — profit is the price less the unit cost');

  if (missing.length === 0) return null;
  return (
    <div className="no-print rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
      <p className="text-xs font-medium text-blue-900">
        Some cells read "{NOT_CALCULATED}" because these are not recorded yet:
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-2xs leading-relaxed text-blue-800">
        {missing.map((m) => <li key={m}>{m}</li>)}
      </ul>
    </div>
  );
}
