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
 * rather than a second set of figures somebody retyped.
 *
 * But every cell can still be written by hand, calculated ones included — a
 * coordinator reconciling against an invoice has to be able to put the
 * invoice's number in the cell. Typing here never rewrites the facts
 * underneath: the ledgers, the bill of materials and the order stay exactly as
 * production recorded them, the typed figure is stored separately, the cell is
 * marked as overridden and carries the calculated value, and one click puts it
 * back. Overrides cascade the way a spreadsheet does.
 *
 * The five `#DIV/0!` cells the live workbook shows today never appear. Every
 * division goes through `safeDiv` in @opsflow/shared and renders as
 * "Not calculated", with a note saying which fact is missing.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Printer, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  fmtDate, fmtMoney, fmtNumber, fmtPct, NOT_CALCULATED,
  type OrderDetailDto, type OverrideKey,
} from '@opsflow/shared';
import { api, type CostLineDto, type CostingDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SheetCell } from './SheetCell';
import { ErrorNote, clsx } from './ui';

/** The six columns of the costing table, as the sheet prints them. */
const COLUMNS = ['Item', 'Actual Cons.', 'Unit', 'Unite Price', 'Cost', 'Percentage'] as const;

type Group = CostLineDto['group'];

/** The figures stored in their own columns, as opposed to typed over a formula. */
interface Stored {
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

/** One row of the costing table, while it is being edited. */
interface RowDraft {
  key: string;
  group: Group;
  label: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  /** Where it came from, when it came from somewhere. */
  sourceRef: string | null;
  /** True while it is still the derivation's row and nobody has touched it. */
  derived: boolean;
}

const numText = (v: number | null | undefined): string => (v == null ? '' : String(v));

function storedFrom(record: CostingDto | null): Stored {
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

function overridesFrom(record: CostingDto | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record?.overrides ?? {})) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

function rowsFrom(record: CostingDto | null, derived: CostLineDto[]): RowDraft[] {
  const stored = record?.lines ?? [];
  // Before the first save there is nothing stored, so the table shows what the
  // production sections would contribute — the screen is demonstrably working
  // rather than empty, and saving is what commits those rows.
  const source = stored.length > 0 ? stored : derived.map((d) => ({ ...d, source: 'DERIVED' as const }));
  return source.map((l, i) => ({
    key: l.id ?? `${l.sourceRef ?? 'row'}-${i}`,
    group: l.group,
    label: l.label,
    quantity: numText(l.quantity),
    unit: l.unit,
    unitPrice: numText(l.unitPriceUsd),
    sourceRef: l.sourceRef ?? null,
    derived: l.source !== 'MANUAL',
  }));
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
  const derivedLines = useMemo(() => costing.data?.derived ?? [], [costing.data]);

  const [stored, setStored] = useState<Stored>(() => storedFrom(record));
  const [over, setOver] = useState<Record<string, string>>(() => overridesFrom(record));
  const [rows, setRows] = useState<RowDraft[]>(() => rowsFrom(record, derivedLines));
  const [hidden, setHidden] = useState<string[]>(() => record?.hiddenCostRefs ?? []);
  const [baseline, setBaseline] = useState('');

  // Re-seed when the server's copy actually changes — including when the user
  // switches to a different order, which replaces the data without remounting.
  //
  // Keyed on the values rather than the object: the query refetches in the
  // background and hands back a new object every time, which would throw away
  // whatever the coordinator was in the middle of typing.
  const serverState = JSON.stringify([
    order.id, storedFrom(record), overridesFrom(record),
    rowsFrom(record, derivedLines), record?.hiddenCostRefs ?? [],
  ]);
  useEffect(() => {
    const [, s, o, r, h] = JSON.parse(serverState) as
      [string, Stored, Record<string, string>, RowDraft[], string[]];
    setStored(s); setOver(o); setRows(r); setHidden(h);
    setBaseline(JSON.stringify([s, o, r, h]));
  }, [serverState]);

  const current = JSON.stringify([stored, over, rows, hidden]);
  const dirty = baseline !== '' && current !== baseline;

  const save = useMutation({
    mutationFn: () => api.steps.saveCosting(order.id, {
      costingDate: stored.costingDate || null,
      dollarRate: asNumber(stored.dollarRate) ?? undefined,
      dailyCostEgp: asNumber(stored.dailyCostEgp),
      machineCount: asNumber(stored.machineCount),
      lineMachineQty: asNumber(stored.lineMachineQty),
      daysInLine: asNumber(stored.daysInLine),
      machineDaysUsed: asNumber(stored.machineDaysUsed),
      sublimationCostUsd: asNumber(stored.sublimationCostUsd),
      embroideryCostUsd: asNumber(stored.embroideryCostUsd),
      notes: stored.notes || null,
      overrides: over,
      hiddenCostRefs: hidden,
      // Rows the derivation should stop producing: everything somebody has
      // touched or added. A row still marked derived is left to it, so it goes
      // on following the bill of materials.
      manualLines: rows
        .filter((r) => !r.derived && r.label.trim() !== '')
        .map((r) => ({
          group: r.group,
          label: r.label.trim(),
          quantity: asNumber(r.quantity),
          unit: r.unit.trim() || 'LOT',
          unitPriceUsd: asNumber(r.unitPrice),
          sourceRef: r.sourceRef,
        })),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['costing', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
  });

  const setField = (key: keyof Stored) => (v: string) => setStored((s) => ({ ...s, [key]: v }));
  const setOverride = (key: OverrideKey) => (v: string) =>
    setOver((o) => (v.trim() === '' ? drop(o, key) : { ...o, [key]: v }));
  const revert = (key: OverrideKey) => () => setOver((o) => drop(o, key));

  /** A cell that overrides a calculated figure. */
  const cell = (
    key: OverrideKey, calculated: number | string | null,
    kind: 'money' | 'percent' | 'number' | 'text',
    opts: {
      places?: number; className?: string; align?: 'right' | 'center';
      colSpan?: number; label?: string;
    } = {},
  ) => (
    <SheetCell
      value={over[key] ?? ''}
      calculated={calculated}
      kind={kind}
      places={opts.places}
      editable={editable}
      align={opts.align ?? (kind === 'text' ? 'center' : 'right')}
      className={clsx(opts.className, over[key] != null && 'bg-violet-50')}
      colSpan={opts.colSpan}
      label={opts.label}
      onChange={setOverride(key)}
      onRevert={revert(key)}
    />
  );

  const editRow = (key: string, patch: Partial<RowDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, derived: false } : r)));

  const deleteRow = (row: RowDraft) => {
    setRows((rs) => rs.filter((r) => r.key !== row.key));
    // A derived row would be recreated by the next recomputation unless the
    // costing remembers it was removed.
    if (row.sourceRef) setHidden((h) => (h.includes(row.sourceRef!) ? h : [...h, row.sourceRef!]));
  };

  const addRow = (group: Group) =>
    setRows((rs) => [...rs, {
      key: `new-${Date.now()}-${rs.length}`,
      group, label: '', quantity: '', unit: group === 'FABRIC' ? 'MET' : 'PCS',
      unitPrice: '', sourceRef: null, derived: false,
    }]);

  const fabricRows = rows.filter((r) => r.group === 'FABRIC');
  const accessoryRows = rows.filter((r) => r.group === 'ACCESSORY');
  const otherRows = rows.filter((r) => r.group !== 'FABRIC' && r.group !== 'ACCESSORY');

  /** Live arithmetic for a row being edited, so the sheet adds up as you type. */
  const rowCost = (r: RowDraft): number | null => {
    const q = asNumber(r.quantity), p = asNumber(r.unitPrice);
    return q == null || p == null ? null : q * p;
  };
  const groupTotal = (rs: RowDraft[]): number | null => {
    const costs = rs.map(rowCost).filter((v): v is number => v != null);
    return costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0);
  };

  const liveFabric = groupTotal(fabricRows);
  const liveAccessory = groupTotal(accessoryRows);
  const displayTotal = asNumber(over.totalCostUsd ?? '') ?? c.totalCostUsd;

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
                onClick={() => {
                  const [s, o, r, h] = JSON.parse(baseline) as
                    [Stored, Record<string, string>, RowDraft[], string[]];
                  setStored(s); setOver(o); setRows(r); setHidden(h);
                }}
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
      {c.overridden.length > 0 && (
        <p className="no-print text-2xs text-violet-700">
          {c.overridden.length} cell{c.overridden.length === 1 ? '' : 's'} on this sheet
          {c.overridden.length === 1 ? ' is' : ' are'} showing a typed figure instead of the
          calculated one. They are outlined; hover one to see what it would say, or use its
          revert arrow to put it back.
        </p>
      )}

      <MissingNotes order={order} />

      <div className="print-document overflow-x-auto border border-ink-400 bg-white">
        <table className="xl min-w-[64rem]">
          <colgroup>
            <col className="w-[13%]" /><col className="w-[20%]" />
            <col className="w-[13%]" /><col className="w-[14%]" />
            <col className="w-[13%]" /><col className="w-[13%]" />
            <col className="w-[14%]" />
          </colgroup>

          <tbody>
            <tr><td className="xl-banner" colSpan={7}>Actual Costing_Coordinator</td></tr>

            {/* ── Header: identity · machines · money ───────────────────── */}
            <tr>
              <td className="xl-label">Date</td>
              <td className="xl-input p-0">
                {editable ? (
                  <input
                    type="date"
                    className="w-full border-0 bg-transparent px-2 py-1 text-center text-xs
                               focus:bg-white focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent-500"
                    value={stored.costingDate}
                    onChange={(e) => setField('costingDate')(e.target.value)}
                  />
                ) : (
                  <span className="block px-2 py-1 text-center">
                    {fmtDate(c.costingDate ?? order.poDate)}
                  </span>
                )}
              </td>
              <td className="xl-label">Dollar Rate</td>
              <Stored2 value={stored.dollarRate} onChange={setField('dollarRate')} editable={editable} placeholder="EGP/$" />
              <td className="xl-label">Daily Cost</td>
              <Stored2 value={stored.dailyCostEgp} onChange={setField('dailyCostEgp')} editable={editable} placeholder="EGP/day" colSpan={2} />
            </tr>
            <tr>
              <td className="xl-label">Customer</td>
              {cell('customer', order.client.name, 'text')}
              <td className="xl-label">All F. Machines</td>
              <Stored2 value={stored.machineCount} onChange={setField('machineCount')} editable={editable} />
              <td className="xl-label">Sell Price</td>
              {cell('sellPriceUsd', c.sellPriceUsd, 'money', { colSpan: 2 })}
            </tr>
            <tr>
              <td className="xl-label">Order Name</td>
              {cell('orderName', order.orderName, 'text')}
              <td className="xl-label">Machine Cost</td>
              {cell('machineCostEgpPerDay', c.machineCostEgpPerDay, 'number', { places: 2 })}
              <td className="xl-label">Actual Cost/Unit</td>
              {cell('unitActualCostUsd', c.unitActualCostUsd, 'money', { colSpan: 2 })}
            </tr>
            <tr>
              <td className="xl-label">Item Type</td>
              {cell('itemType', order.itemType, 'text')}
              <td className="xl-label">Line Machines Qty</td>
              <Stored2 value={stored.lineMachineQty} onChange={setField('lineMachineQty')} editable={editable} />
              <td className="xl-label">Profit</td>
              {cell('profitPerUnitUsd', c.profitPerUnitUsd, 'money', {
                className: clsx('bg-amber-100', c.isProfitable === false && 'text-red-700'),
              })}
              <td className="xl-calc text-2xs text-ink-500">
                {c.isProfitable === true ? 'in profit' : c.isProfitable === false ? 'at a loss' : ''}
              </td>
            </tr>
            <tr>
              <td className="xl-label">Po No</td>
              {cell('poNumber', order.poNumber, 'text')}
              <td className="xl-label">Days in line</td>
              <Stored2 value={stored.daysInLine} onChange={setField('daysInLine')} editable={editable} />
              <td className="xl-label">Pro. Percentage</td>
              {cell('profitPct', c.profitPct, 'percent', { className: 'bg-amber-100', colSpan: 2 })}
            </tr>
            <tr>
              <td className="xl-label">Style No</td>
              {cell('styleNumber', order.styleNumber, 'text')}
              <td className="xl-label">Machine Already Used</td>
              <Stored2 value={stored.machineDaysUsed} onChange={setField('machineDaysUsed')} editable={editable} />
              <td className="xl-label">Perfect price</td>
              {c.targetPriceUsd == null && over.targetPriceUsd == null && c.isProfitable === true ? (
                <td className="xl-result" colSpan={2}>Perfect</td>
              ) : (
                cell('targetPriceUsd', c.targetPriceUsd, 'money', { className: 'bg-amber-100', colSpan: 2 })
              )}
            </tr>

            <tr><td className="h-1.5 border-0 bg-ink-50 p-0" colSpan={7} /></tr>

            {/* ── Production quantities ─────────────────────────────────── */}
            <tr>
              <td className="xl-label">Order Qty</td>
              {cell('orderQty', c.orderQty, 'number', { className: 'bg-orange-100' })}
              <td className="xl-label">Shipped Qty</td>
              {cell('shippedQty', c.shippedQty, 'number', { className: 'bg-orange-100' })}
              <td className="xl-label">Diff. Percentage</td>
              {cell('diffPct', c.diffPct, 'percent', { className: 'bg-amber-100' })}
              {cell('workDays', c.workDays, 'number', { places: 1, className: 'bg-white', label: 'Work Days' })}
            </tr>
            <tr>
              <td className="xl-label">Cutted Qty</td>
              {cell('cutQty', c.cutQty, 'number', { className: 'bg-orange-100' })}
              <td className="xl-label">1st Degree Qty</td>
              {cell('firstDegreeQty', c.firstDegreeQty, 'number', { className: 'bg-orange-100' })}
              <td className="xl-label">2nd Degree Qty</td>
              {cell('secondDegreeQty', c.secondDegreeQty, 'number', { className: 'bg-orange-100' })}
              {cell('productivityRate', c.productivityRate, 'number', { className: 'bg-white', label: 'Productivity' })}
            </tr>
            {/* ── Costing table ────────────────────────────────────────── */}
            <tr>
              {COLUMNS.map((h, i) => (
                <td key={h} className="xl-banner" colSpan={i === 0 ? 2 : 1}>{h}</td>
              ))}
            </tr>

            <RowBlock
              caption="UsedFabric"
              rows={fabricRows}
              total={displayTotal}
              editable={editable}
              onEdit={editRow}
              onDelete={deleteRow}
              onAdd={() => addRow('FABRIC')}
              rowCost={rowCost}
            />
            <SubtotalRow
              label="Fabric Costing"
              cost={liveFabric}
              total={displayTotal}
              overrideValue={over.fabricCostUsd ?? ''}
              calculated={c.groups.fabric.total}
              editable={editable}
              onChange={setOverride('fabricCostUsd')}
              onRevert={revert('fabricCostUsd')}
            />

            <RowBlock
              caption="UsedAcc"
              rows={accessoryRows}
              total={displayTotal}
              editable={editable}
              onEdit={editRow}
              onDelete={deleteRow}
              onAdd={() => addRow('ACCESSORY')}
              rowCost={rowCost}
            />
            <SubtotalRow
              label="Accesory Costing"
              cost={liveAccessory}
              total={displayTotal}
              overrideValue={over.accessoryCostUsd ?? ''}
              calculated={c.groups.accessory.total}
              editable={editable}
              onChange={setOverride('accessoryCostUsd')}
              onRevert={revert('accessoryCostUsd')}
            />

            {/* Outside work. The sheet prints two fixed rows; OpsFlow records
                whatever operations an order actually sent out, so anything
                beyond those two is listed rather than folded away. */}
            <ExternalRow
              label="Sublimation" cost={c.sublimationCostUsd} total={displayTotal}
              editable={editable} value={stored.sublimationCostUsd}
              onChange={setField('sublimationCostUsd')}
            />
            <ExternalRow
              label="Embroidery" cost={c.embroideryCostUsd} total={displayTotal}
              editable={editable} value={stored.embroideryCostUsd}
              onChange={setField('embroideryCostUsd')}
            />
            {otherRows.map((r) => (
              <EditableRow
                key={r.key} row={r} total={displayTotal} editable={editable}
                onEdit={editRow} onDelete={deleteRow} cost={rowCost(r)}
              />
            ))}
            {editable && (
              <tr className="no-print">
                <td className="xl-section" />
                <td colSpan={6} className="p-1">
                  <button className="btn-ghost btn-sm text-2xs" onClick={() => addRow('EXTERNAL')}>
                    <Plus className="h-3 w-3" /> Add an outside-work or other cost
                  </button>
                </td>
              </tr>
            )}

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
              {cell('cmCostUsd', c.cmCostUsd, 'money', { className: 'bg-ink-100' })}
              <td className="tnum text-right">{fmtPct(pctOf(c.cmCostUsd, displayTotal), 1)}</td>
            </tr>

            <tr className="xl-total">
              <td colSpan={4}>Total</td>
              <td />
              {cell('totalCostUsd', c.totalCostUsd, 'money', { className: 'bg-ink-200 font-bold' })}
              <td className="tnum text-right">{displayTotal == null ? NOT_CALCULATED : '100.0%'}</td>
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
                    value={stored.notes}
                    onChange={(e) => setField('notes')(e.target.value)}
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
    </div>
  );
}

function drop(map: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _gone, ...rest } = map;
  return rest;
}

/** cost ÷ total as a percentage, never a division by zero. */
function pctOf(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole === 0) return null;
  return (part / whole) * 100;
}

/** A cell backed by its own stored column rather than by an override. */
function Stored2({
  value, onChange, editable, placeholder, colSpan,
}: {
  value: string; onChange: (v: string) => void; editable: boolean;
  placeholder?: string; colSpan?: number;
}) {
  if (!editable) return <td className="xl-calc" colSpan={colSpan}>{value === '' ? '—' : value}</td>;
  return (
    <td className="xl-input" colSpan={colSpan}>
      <input
        type="number"
        step="any"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </td>
  );
}

function RowBlock({
  caption, rows, total, editable, onEdit, onDelete, onAdd, rowCost,
}: {
  caption: string;
  rows: RowDraft[];
  total: number | null;
  editable: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onDelete: (row: RowDraft) => void;
  onAdd: () => void;
  rowCost: (r: RowDraft) => number | null;
}) {
  return (
    <>
      {rows.length === 0 ? (
        <tr>
          <td className="xl-section">{caption}</td>
          <td className="px-2 py-1 text-2xs italic text-ink-400" colSpan={6}>
            Nothing on the bill of materials yet — add a row below, or record it there.
          </td>
        </tr>
      ) : (
        rows.map((r, i) => (
          <EditableRow
            key={r.key}
            caption={i === 0 ? caption : undefined}
            captionSpan={i === 0 ? rows.length : undefined}
            spanned={i > 0}
            row={r}
            total={total}
            editable={editable}
            onEdit={onEdit}
            onDelete={onDelete}
            cost={rowCost(r)}
          />
        ))
      )}
      {editable && (
        <tr className="no-print">
          <td className="xl-section" />
          <td colSpan={6} className="p-1">
            <button className="btn-ghost btn-sm text-2xs" onClick={onAdd}>
              <Plus className="h-3 w-3" /> Add a {caption === 'UsedFabric' ? 'fabric' : 'accessory'} row
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function EditableRow({
  caption, captionSpan, spanned, row, total, editable, onEdit, onDelete, cost,
}: {
  caption?: string;
  captionSpan?: number;
  /** True when the caption column is already covered by a rowSpan above. */
  spanned?: boolean;
  row: RowDraft;
  total: number | null;
  editable: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onDelete: (row: RowDraft) => void;
  cost: number | null;
}) {
  const cls = 'w-full border-0 bg-transparent px-2 py-1 text-xs text-ink-900 focus:bg-white '
    + 'focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent-500';
  const origin = row.sourceRef
    ? row.derived ? `From ${explain(row.sourceRef)}` : `Edited — was from ${explain(row.sourceRef)}`
    : 'Added by hand';

  return (
    <tr className={clsx(!row.derived && row.sourceRef && 'bg-violet-50/40')}>
      {caption !== undefined && <td className="xl-section" rowSpan={captionSpan}>{caption}</td>}
      {caption === undefined && !spanned && <td className="xl-section" />}
      <td className="p-0" title={origin}>
        {editable
          ? <input className={cls} value={row.label} placeholder="Item"
                   onChange={(e) => onEdit(row.key, { label: e.target.value })} />
          : <span className="block px-2 py-1">{row.label}</span>}
      </td>
      <td className="p-0">
        {editable
          ? <input className={clsx(cls, 'tnum text-right')} type="number" step="any" value={row.quantity}
                   onChange={(e) => onEdit(row.key, { quantity: e.target.value })} />
          : <span className="tnum block px-2 py-1 text-right">{row.quantity || '—'}</span>}
      </td>
      <td className="p-0">
        {editable
          ? <input className={clsx(cls, 'text-center')} value={row.unit}
                   onChange={(e) => onEdit(row.key, { unit: e.target.value })} />
          : <span className="block px-2 py-1 text-center">{row.unit}</span>}
      </td>
      <td className="p-0">
        {editable
          ? <input className={clsx(cls, 'tnum text-right')} type="number" step="any" value={row.unitPrice}
                   onChange={(e) => onEdit(row.key, { unitPrice: e.target.value })} />
          : <span className="tnum block px-2 py-1 text-right">{row.unitPrice || '—'}</span>}
      </td>
      <td className="tnum text-right">{cost == null ? '—' : fmtMoney(cost)}</td>
      <td className="tnum relative text-right">
        {fmtPct(pctOf(cost, total), 1)}
        {editable && (
          <button
            type="button"
            className="no-print absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5
                       text-ink-400 hover:bg-red-50 hover:text-red-600"
            title="Remove this row from the costing"
            aria-label={`Remove ${row.label || 'this row'}`}
            onClick={() => onDelete(row)}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </td>
    </tr>
  );
}

/** "bom:FABRIC" → "the bill of materials · fabric". */
function explain(ref: string): string {
  const [section, detail] = ref.split(':');
  const name = section === 'bom' ? 'the bill of materials'
    : section === 'external' ? 'outside work'
    : section === 'production' ? 'the production follow-up'
    : section;
  const tail = (detail ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  return tail ? `${name} · ${tail}` : name;
}

/** The "Fabric Costing" / "Accesory Costing" rows the sheet prints. */
function SubtotalRow({
  label, cost, total, overrideValue, calculated, editable, onChange, onRevert,
}: {
  label: string;
  cost: number | null;
  total: number | null;
  overrideValue: string;
  calculated: number | null;
  editable: boolean;
  onChange: (v: string) => void;
  onRevert: () => void;
}) {
  const shown = overrideValue.trim() !== '' ? Number(overrideValue) : cost;
  return (
    <tr className="xl-subtotal">
      <td colSpan={5}>{label}</td>
      <SheetCell
        value={overrideValue}
        calculated={calculated}
        kind="money"
        editable={editable}
        className="bg-ink-100 font-semibold"
        onChange={onChange}
        onRevert={onRevert}
      />
      <td className="tnum text-right">{fmtPct(pctOf(shown, total), 1)}</td>
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
  label, cost, total, editable, value, onChange,
}: {
  label: string; cost: number | null; total: number | null;
  editable: boolean; value: string; onChange: (v: string) => void;
}) {
  return (
    <tr>
      <td className="xl-section" />
      <td className="font-medium text-ink-800">{label}</td>
      <td colSpan={2} className="text-center text-2xs text-ink-400">
        {value.trim() === '' && cost != null ? 'from outside work' : ''}
      </td>
      {editable ? (
        <td className="xl-input">
          <input
            type="number" min={0} step="0.01" value={value}
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
      <Swatch className="bg-violet-50 ring-1 ring-inset ring-violet-400" label="Overridden — hover to see the calculated figure" />
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
  const overridden = new Set<OverrideKey>(c.overridden);
  const missing: string[] = [];
  if (c.shippedQty == null && !overridden.has('shippedQty')) {
    missing.push('the shipped quantity (recorded on Packing & Shipping) — the unit cost, profit and difference percentage divide by it');
  }
  if (c.dailyCostEgp == null) missing.push("the factory's daily cost, typed on this sheet — C.M is work days × daily cost");
  if (c.machineCount == null) missing.push('the factory machine count, typed on this sheet — machine cost and work days divide by it');
  if (c.dollarRate == null) missing.push('the dollar rate, typed on this sheet — EGP figures convert through it');
  if (c.sellPriceUsd == null) missing.push('the price per piece (Order Details) — profit is the price less the unit cost');

  if (missing.length === 0) return null;
  return (
    <div className="no-print rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
      <p className="text-xs font-medium text-blue-900">
        Some cells read "{NOT_CALCULATED}" because these are not recorded yet — you can type
        straight into any of them instead:
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-2xs leading-relaxed text-blue-800">
        {missing.map((m) => <li key={m}>{m}</li>)}
      </ul>
    </div>
  );
}
