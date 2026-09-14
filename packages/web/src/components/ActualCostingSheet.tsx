/**
 * Actual Costing — `Actual Costing_Coordinator` from the workbook.
 *
 * Every field, every grouping and every calculation is the sheet's; the look is
 * OpsFlow's. The coordinators reading this have the workbook's order of fields
 * in their heads — identity, then the machine figures, then the money, then the
 * two rows of production quantities, then the costing table with UsedFabric
 * above UsedAcc — so that order is kept exactly. What is not kept is Excel's
 * black banners and hairline borders: this is a screen in an application, and
 * it should look like the rest of it.
 *
 * Everything the application already knows is read rather than retyped. The
 * customer and the style come from the order, the quantities from their
 * ledgers, the materials from the bill of materials, the outside work from the
 * External Order section. So the costing is the cost of what actually happened.
 *
 * And every field can still be written by hand, calculated ones included.
 * Typing never rewrites the facts underneath — the typed figure is stored
 * beside them, the field is marked, and one click puts the calculated number
 * back. Overrides cascade: change the fabric total and the grand total, the
 * unit cost and the profit all move with it.
 *
 * The five `#DIV/0!` cells the live workbook shows today never appear. Every
 * division goes through `safeDiv` and renders as "Not calculated", with a note
 * naming the missing fact and the screen that records it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Printer, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  fmtMoney, fmtNumber, fmtPct, formatCell, isTypeableNumber, NOT_CALCULATED,
  type OrderDetailDto, type OverrideKey,
} from '@opsflow/shared';
import { api, type CostLineDto, type CostingDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CostValue } from './CostValue';
import { Card, CardHeader, ErrorNote, clsx } from './ui';

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

/** Empty means "nobody has said", which is not the same as zero. */
const asNumber = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

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
  for (const [k, v] of Object.entries(record?.overrides ?? {})) if (v != null) out[k] = String(v);
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

  /** A field that may be typed over the calculated figure. */
  const field = (
    key: OverrideKey, calculated: number | string | null,
    kind: 'money' | 'percent' | 'number' | 'text', places?: number,
  ) => (
    <CostValue
      value={over[key] ?? ''}
      calculated={calculated}
      kind={kind}
      places={places}
      editable={editable}
      align={kind === 'text' ? 'left' : 'right'}
      onChange={setOverride(key)}
      onRevert={revert(key)}
    />
  );

  /** A field backed by its own stored column. */
  const plain = (key: keyof Stored, placeholder?: string) => (
    <input
      className="input tnum text-right"
      type="text"
      inputMode="decimal"
      value={stored[key]}
      placeholder={placeholder}
      disabled={!editable}
      onChange={(e) => {
        const v = e.target.value;
        if (!isTypeableNumber(v)) return;
        setField(key)(v);
      }}
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

  /** Live arithmetic for a row being edited, so the table adds up as you type. */
  const rowCost = (r: RowDraft): number | null => {
    const q = asNumber(r.quantity), p = asNumber(r.unitPrice);
    return q == null || p == null ? null : q * p;
  };
  const groupTotal = (rs: RowDraft[]): number | null => {
    const costs = rs.map(rowCost).filter((v): v is number => v != null);
    return costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0);
  };

  const liveFabric = asNumber(over.fabricCostUsd ?? '') ?? groupTotal(fabricRows);
  const liveAccessory = asNumber(over.accessoryCostUsd ?? '') ?? groupTotal(accessoryRows);
  const total = asNumber(over.totalCostUsd ?? '') ?? c.totalCostUsd;

  return (
    <div className="print-document space-y-4 p-5">
      {!editable && (
        <div className="no-print flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs leading-relaxed text-amber-900">
            You can read this costing but not change it — that needs the
            <strong> costing:write </strong> permission, which your role does not carry.
            Everything below is shown as recorded.
          </p>
        </div>
      )}

      <Card>
        <CardHeader
          title="Actual costing"
          subtitle="Every figure can be typed over. Nothing typed here changes the order, the ledgers or the bill of materials."
          action={
            <div className="flex items-center gap-2">
              <button className="btn-secondary btn-sm no-print" onClick={() => window.print()}>
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              {editable && (
                <>
                  <button
                    className="btn-ghost btn-sm no-print"
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
                    className="btn-primary btn-sm no-print"
                    disabled={!dirty || save.isPending}
                    onClick={() => save.mutate()}
                  >
                    <Save className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save changes'}
                  </button>
                </>
              )}
            </div>
          }
        />
        {save.isError && <div className="p-4 pb-0"><ErrorNote error={save.error} /></div>}
        {c.overridden.length > 0 && (
          <p className="border-b border-ink-100 bg-violet-50 px-4 py-2 text-2xs text-violet-800">
            {c.overridden.length} field{c.overridden.length === 1 ? '' : 's'}
            {c.overridden.length === 1 ? ' is' : ' are'} showing a typed figure rather than the
            calculated one. They are outlined; each has a revert arrow that puts the calculated
            figure back.
          </p>
        )}

        <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Labelled label="Date">
            <input
              type="date"
              className="input"
              value={stored.costingDate}
              disabled={!editable}
              onChange={(e) => setField('costingDate')(e.target.value)}
            />
          </Labelled>
          <Labelled label="Customer" from="the order">{field('customer', order.client.name, 'text')}</Labelled>
          <Labelled label="Order Name" from="the order">{field('orderName', order.orderName, 'text')}</Labelled>
          <Labelled label="Item Type" from="the order">{field('itemType', order.itemType, 'text')}</Labelled>
          <Labelled label="Po No" from="the order">{field('poNumber', order.poNumber, 'text')}</Labelled>
          <Labelled label="Style No" from="the order">{field('styleNumber', order.styleNumber, 'text')}</Labelled>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Machines and time"
            subtitle="The factory's own figures. Nothing else in OpsFlow records them."
          />
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2">
            <Labelled label="Dollar Rate" hint="EGP per $">{plain('dollarRate', '48.5')}</Labelled>
            <Labelled label="Daily Cost" hint="EGP per day">{plain('dailyCostEgp')}</Labelled>
            <Labelled label="All F. Machines">{plain('machineCount')}</Labelled>
            <Labelled label="Line Machines Qty">{plain('lineMachineQty')}</Labelled>
            <Labelled label="Days in line">{plain('daysInLine')}</Labelled>
            <Labelled label="Machine Already Used" hint="machine-days">{plain('machineDaysUsed')}</Labelled>
            <Labelled label="Machine Cost" hint="daily cost ÷ machines, EGP">
              {field('machineCostEgpPerDay', c.machineCostEgpPerDay, 'number', 2)}
            </Labelled>
            <Labelled label="Work Days" hint="machine-days ÷ machines">
              {field('workDays', c.workDays, 'number', 1)}
            </Labelled>
            <Labelled label="Productivity rate" hint="pieces cut per work day">
              {field('productivityRate', c.productivityRate, 'number')}
            </Labelled>
          </div>
        </Card>

        <Card>
          <CardHeader title="The result" subtitle="Per piece, against what shipped." />
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2">
            <Labelled label="Sell Price" from="Order Details">
              {field('sellPriceUsd', c.sellPriceUsd, 'money')}
            </Labelled>
            <Labelled label="Actual Cost/Unit" hint="total ÷ shipped">
              {field('unitActualCostUsd', c.unitActualCostUsd, 'money')}
            </Labelled>
            <Labelled label="Profit" hint="sell price − unit cost">
              {field('profitPerUnitUsd', c.profitPerUnitUsd, 'money')}
            </Labelled>
            <Labelled label="Pro. Percentage" hint="profit ÷ sell price">
              {field('profitPct', c.profitPct, 'percent')}
            </Labelled>
            <Labelled
              label="Perfect price"
              hint={c.isProfitable === true && over.targetPriceUsd == null
                ? 'nothing to fix at this price'
                : 'the price that restores a 20% margin'}
            >
              {field('targetPriceUsd', c.targetPriceUsd, 'money')}
            </Labelled>
            <div className="flex items-end">
              <p className={clsx(
                'w-full rounded-md px-2.5 py-1.5 text-center text-xs font-medium',
                c.isProfitable === true && 'bg-emerald-50 text-emerald-800',
                c.isProfitable === false && 'bg-red-50 text-red-700',
                c.isProfitable == null && 'bg-ink-50 text-ink-500',
              )}>
                {c.isProfitable === true ? 'In profit'
                  : c.isProfitable === false ? 'At a loss'
                  : 'Not calculable yet'}
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Production quantities"
          subtitle="Counted on the floor and read from their ledgers. Typing here does not change them."
        />
        <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Labelled label="Order Qty" from="order ledger">{field('orderQty', c.orderQty, 'number')}</Labelled>
          <Labelled label="Cutted Qty" from="cut ledger">{field('cutQty', c.cutQty, 'number')}</Labelled>
          <Labelled label="Shipped Qty" from="shipped ledger">{field('shippedQty', c.shippedQty, 'number')}</Labelled>
          <Labelled label="1st Degree Qty" from="out-line">{field('firstDegreeQty', c.firstDegreeQty, 'number')}</Labelled>
          <Labelled label="2nd Degree Qty" from="second-degree ledger">{field('secondDegreeQty', c.secondDegreeQty, 'number')}</Labelled>
          <Labelled label="Diff. Percentage" hint="shipped vs ordered">{field('diffPct', c.diffPct, 'percent')}</Labelled>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Costing"
          subtitle="Materials from the bill of materials, outside work from the External Order section. Rows can be edited, added and removed here without changing either."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem]">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th w-28">Section</th>
                <th className="th">Item</th>
                <th className="th w-28 text-right">Actual Cons.</th>
                <th className="th w-20">Unit</th>
                <th className="th w-28 text-right">Unit Price</th>
                <th className="th w-28 text-right">Cost</th>
                <th className="th w-20 text-right">Percentage</th>
                {editable && <th className="th w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              <RowBlock
                caption="UsedFabric" rows={fabricRows} total={total} editable={editable}
                onEdit={editRow} onDelete={deleteRow} onAdd={() => addRow('FABRIC')} rowCost={rowCost}
                emptyText="No fabric on the bill of materials yet"
              />
              <SubtotalRow
                label="Fabric Costing" cost={liveFabric} total={total} editable={editable}
                value={over.fabricCostUsd ?? ''} calculated={c.groups.fabric.total}
                onChange={setOverride('fabricCostUsd')} onRevert={revert('fabricCostUsd')}
              />

              <RowBlock
                caption="UsedAcc" rows={accessoryRows} total={total} editable={editable}
                onEdit={editRow} onDelete={deleteRow} onAdd={() => addRow('ACCESSORY')} rowCost={rowCost}
                emptyText="No accessories on the bill of materials yet"
              />
              <SubtotalRow
                label="Accesory Costing" cost={liveAccessory} total={total} editable={editable}
                value={over.accessoryCostUsd ?? ''} calculated={c.groups.accessory.total}
                onChange={setOverride('accessoryCostUsd')} onRevert={revert('accessoryCostUsd')}
              />

              <OutsideRow
                label="Sublimation" cost={c.sublimationCostUsd} total={total} editable={editable}
                value={stored.sublimationCostUsd} onChange={setField('sublimationCostUsd')}
              />
              <OutsideRow
                label="Embroidery" cost={c.embroideryCostUsd} total={total} editable={editable}
                value={stored.embroideryCostUsd} onChange={setField('embroideryCostUsd')}
              />
              {otherRows.map((r) => (
                <EditableRow
                  key={r.key} row={r} total={total} editable={editable}
                  onEdit={editRow} onDelete={deleteRow} cost={rowCost(r)}
                />
              ))}
              {editable && (
                <tr className="no-print">
                  <td className="td" />
                  <td className="td" colSpan={7}>
                    <button className="btn-ghost btn-sm text-2xs" onClick={() => addRow('EXTERNAL')}>
                      <Plus className="h-3 w-3" /> Add an outside-work or other cost
                    </button>
                  </td>
                </tr>
              )}

              {/* C.M — the workbook's work days × daily cost, converted. */}
              <tr className="bg-ink-50">
                <td className="td font-semibold text-ink-900">C.M</td>
                <td className="td text-ink-600">Production — work days × daily cost</td>
                <td className="td tnum text-right">{fmtNumber(c.workDays, { places: 1 })}</td>
                <td className="td">DAY</td>
                <td className="td tnum text-right">
                  {c.dailyCostEgp == null || c.dollarRate == null
                    ? '—'
                    : fmtMoney(c.dailyCostEgp / c.dollarRate, '$', 4)}
                </td>
                <td className="td p-1">
                  <CostValue
                    value={over.cmCostUsd ?? ''} calculated={c.cmCostUsd} kind="money"
                    editable={editable} onChange={setOverride('cmCostUsd')} onRevert={revert('cmCostUsd')}
                  />
                </td>
                <td className="td tnum text-right">{fmtPct(pctOf(c.cmCostUsd, total), 1)}</td>
                {editable && <td className="td" />}
              </tr>

              <tr className="bg-ink-100">
                <td className="td font-bold text-ink-900" colSpan={5}>Total</td>
                <td className="td p-1">
                  <CostValue
                    value={over.totalCostUsd ?? ''} calculated={c.totalCostUsd} kind="money"
                    editable={editable} className="font-semibold"
                    onChange={setOverride('totalCostUsd')} onRevert={revert('totalCostUsd')}
                  />
                </td>
                <td className="td tnum text-right font-semibold">
                  {total == null ? '—' : '100.0%'}
                </td>
                {editable && <td className="td" />}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Notes" subtitle="Anything about this costing that the numbers do not say." />
        <div className="p-4">
          <textarea
            className="input min-h-[5rem] resize-y"
            value={stored.notes}
            disabled={!editable}
            onChange={(e) => setField('notes')(e.target.value)}
            placeholder={editable ? 'Why a figure was overridden, what an invoice said, anything the next reader needs.' : ''}
          />
        </div>
      </Card>

      <MissingNotes order={order} />
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

/** A labelled field, with a note of where its figure comes from. */
function Labelled({
  label, hint, from, children,
}: {
  label: string; hint?: string; from?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {from && <span className="text-2xs font-normal normal-case text-ink-400">from {from}</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
    </div>
  );
}

function RowBlock({
  caption, rows, total, editable, onEdit, onDelete, onAdd, rowCost, emptyText,
}: {
  caption: string;
  rows: RowDraft[];
  total: number | null;
  editable: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onDelete: (row: RowDraft) => void;
  onAdd: () => void;
  rowCost: (r: RowDraft) => number | null;
  emptyText: string;
}) {
  return (
    <>
      {rows.length === 0 ? (
        <tr>
          <td className="td font-semibold text-ink-700">{caption}</td>
          <td className="td text-xs italic text-ink-400" colSpan={editable ? 7 : 6}>{emptyText}</td>
        </tr>
      ) : (
        rows.map((r, i) => (
          <EditableRow
            key={r.key}
            caption={i === 0 ? caption : ''}
            row={r} total={total} editable={editable}
            onEdit={onEdit} onDelete={onDelete} cost={rowCost(r)}
          />
        ))
      )}
      {editable && (
        <tr className="no-print">
          <td className="td" />
          <td className="td" colSpan={7}>
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
  caption, row, total, editable, onEdit, onDelete, cost,
}: {
  caption?: string;
  row: RowDraft;
  total: number | null;
  editable: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onDelete: (row: RowDraft) => void;
  cost: number | null;
}) {
  const origin = row.sourceRef
    ? row.derived ? `From ${explain(row.sourceRef)}` : `Edited — was from ${explain(row.sourceRef)}`
    : 'Added by hand';
  const num = (v: string, set: (s: string) => void) => (
    <input
      className="input tnum py-1 text-right text-xs"
      type="text"
      inputMode="decimal"
      value={v}
      disabled={!editable}
      onChange={(e) => {
        const next = e.target.value;
        if (!isTypeableNumber(next)) return;
        set(next);
      }}
    />
  );

  return (
    <tr className={clsx(!row.derived && row.sourceRef && 'bg-violet-50/40')}>
      <td className="td font-semibold text-ink-700">{caption ?? ''}</td>
      <td className="td" title={origin}>
        <input
          className="input py-1 text-xs"
          value={row.label}
          placeholder="Item"
          disabled={!editable}
          onChange={(e) => onEdit(row.key, { label: e.target.value })}
        />
      </td>
      <td className="td">{num(row.quantity, (v) => onEdit(row.key, { quantity: v }))}</td>
      <td className="td">
        <input
          className="input py-1 text-center text-xs"
          value={row.unit}
          disabled={!editable}
          onChange={(e) => onEdit(row.key, { unit: e.target.value })}
        />
      </td>
      <td className="td">{num(row.unitPrice, (v) => onEdit(row.key, { unitPrice: v }))}</td>
      <td className="td tnum text-right">{cost == null ? '—' : fmtMoney(cost)}</td>
      <td className="td tnum text-right">{fmtPct(pctOf(cost, total), 1)}</td>
      {editable && (
        <td className="td text-right">
          <button
            type="button"
            className="no-print rounded p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
            title="Remove this row from the costing"
            aria-label={`Remove ${row.label || 'this row'}`}
            onClick={() => onDelete(row)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </td>
      )}
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
  label, cost, total, value, calculated, editable, onChange, onRevert,
}: {
  label: string;
  cost: number | null;
  total: number | null;
  value: string;
  calculated: number | null;
  editable: boolean;
  onChange: (v: string) => void;
  onRevert: () => void;
}) {
  return (
    <tr className="bg-ink-50">
      <td className="td font-semibold text-ink-900" colSpan={5}>{label}</td>
      <td className="td p-1">
        <CostValue
          value={value} calculated={calculated} kind="money"
          editable={editable} className="font-semibold"
          onChange={onChange} onRevert={onRevert}
        />
      </td>
      <td className="td tnum text-right font-semibold">{fmtPct(pctOf(cost, total), 1)}</td>
      {editable && <td className="td" />}
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
function OutsideRow({
  label, cost, total, editable, value, onChange,
}: {
  label: string; cost: number | null; total: number | null;
  editable: boolean; value: string; onChange: (v: string) => void;
}) {
  return (
    <tr>
      <td className="td" />
      <td className="td text-ink-800">
        {label}
        {value.trim() === '' && cost != null && (
          <span className="ml-2 text-2xs text-ink-400">from outside work</span>
        )}
      </td>
      <td className="td" colSpan={2} />
      <td className="td p-1">
        <input
          className="input tnum py-1 text-right text-xs"
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={cost == null ? '' : formatCell(cost, 'money')}
          disabled={!editable}
          onChange={(e) => {
            const next = e.target.value;
            if (!isTypeableNumber(next)) return;
            onChange(next);
          }}
        />
      </td>
      <td className="td tnum text-right">{cost == null ? '—' : fmtMoney(cost)}</td>
      <td className="td tnum text-right">{fmtPct(pctOf(cost, total), 1)}</td>
      {editable && <td className="td" />}
    </tr>
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
    missing.push('the shipped quantity (Packing & Shipping) — the unit cost, profit and difference percentage divide by it');
  }
  if (c.dailyCostEgp == null) missing.push("the factory's daily cost, above — C.M is work days × daily cost");
  if (c.machineCount == null) missing.push('the factory machine count, above — machine cost and work days divide by it');
  if (c.dollarRate == null) missing.push('the dollar rate, above — EGP figures convert through it');
  if (c.sellPriceUsd == null && !overridden.has('sellPriceUsd')) {
    missing.push('the price per piece (Order Details) — profit is the price less the unit cost');
  }

  if (missing.length === 0) return null;
  return (
    <div className="no-print rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
      <p className="text-xs font-medium text-blue-900">
        Some fields read "{NOT_CALCULATED}" because these are not recorded yet — you can type
        straight into any of them instead:
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-2xs leading-relaxed text-blue-800">
        {missing.map((m) => <li key={m}>{m}</li>)}
      </ul>
    </div>
  );
}
