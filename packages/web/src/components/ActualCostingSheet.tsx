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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus, Printer, Save, Trash2 } from 'lucide-react';
import {
  fmtMoney, fmtNumber, fmtPct, NOT_CALCULATED,
  type OrderDetailDto, type OverrideKey,
} from '@opsflow/shared';
import { api, type CostLineDto, type CostingDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CostCell, CostField, NumberCell, StoredField, TextCell } from './CostValue';
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
  // The rest of OpsFlow shows a record as text and turns it into a form on
  // "Edit". A screen of input boxes reads as a different application.
  const [editing, setEditing] = useState(false);
  // Read inside the re-seeding effect, which must not depend on it.
  const editingRef = useRef(editing);
  editingRef.current = editing;

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
    setBaseline(JSON.stringify([s, o, r, h]));
    // Not while somebody is typing: a background refetch, or a colleague
    // saving the same order, would otherwise wipe an edit in progress.
    if (editingRef.current) return;
    setStored(s); setOver(o); setRows(r); setHidden(h);
  }, [serverState]);

  // Kept so Cancel can restore exactly what the server last sent.
  void JSON.stringify([stored, over, rows, hidden]);

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
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['costing', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
  });

  const restore = () => {
    const [s, o, r, h] = JSON.parse(baseline) as
      [Stored, Record<string, string>, RowDraft[], string[]];
    setStored(s); setOver(o); setRows(r); setHidden(h);
  };

  const setField = (key: keyof Stored) => (v: string) => setStored((s) => ({ ...s, [key]: v }));
  const setOverride = (key: OverrideKey) => (v: string) =>
    setOver((o) => (v.trim() === '' ? drop(o, key) : { ...o, [key]: v }));
  const revert = (key: OverrideKey) => () => setOver((o) => drop(o, key));

  /** A field that may be typed over the calculated figure. */
  const field = (
    label: string, key: OverrideKey, calculated: number | string | null,
    kind: 'money' | 'percent' | 'number' | 'text',
    opts: { places?: number; hint?: string; from?: string } = {},
  ) => (
    <CostField
      label={label}
      editing={editing}
      value={over[key] ?? ''}
      calculated={calculated}
      kind={kind}
      places={opts.places}
      hint={opts.hint}
      from={opts.from}
      onChange={setOverride(key)}
      onRevert={revert(key)}
    />
  );

  /** A field backed by its own stored column. */
  const plain = (label: string, key: keyof Stored, hint?: string) => (
    <StoredField
      label={label}
      editing={editing}
      value={stored[key]}
      hint={hint}
      onChange={setField(key)}
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

      {/* The toolbar every other section puts here: read the record, press
          Edit to change it, Save or Cancel. */}
      <div className="no-print flex justify-end gap-2">
        <button className="btn-secondary btn-sm" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" /> Print
        </button>
        {editable && !editing && (
          <button className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" /> Edit costing
          </button>
        )}
        {editable && editing && (
          <>
            <button
              className="btn-secondary btn-sm"
              onClick={() => { restore(); setEditing(false); }}
            >
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </>
        )}
      </div>

      {save.isError && <ErrorNote error={save.error} />}

      {c.overridden.length > 0 && (
        <p className="no-print text-xs text-violet-700">
          {c.overridden.length} figure{c.overridden.length === 1 ? '' : 's'} on this costing
          {c.overridden.length === 1 ? ' was' : ' were'} typed in rather than calculated. Each says
          so under its value, and can be put back while editing.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="The order" subtitle="Read from the order record." />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <StoredField
              label="Date" editing={editing} type="date"
              value={stored.costingDate} onChange={setField('costingDate')}
            />
            {field('Customer', 'customer', order.client.name, 'text')}
            {field('Order Name', 'orderName', order.orderName, 'text')}
            {field('Item Type', 'itemType', order.itemType, 'text')}
            {field('Po No', 'poNumber', order.poNumber, 'text')}
            {field('Style No', 'styleNumber', order.styleNumber, 'text')}
          </div>
        </Card>

        <Card>
          <CardHeader title="The result" subtitle="Per piece, against what shipped." />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {field('Sell Price', 'sellPriceUsd', c.sellPriceUsd, 'money', { from: 'Order Details' })}
            {field('Actual Cost/Unit', 'unitActualCostUsd', c.unitActualCostUsd, 'money', {
              hint: 'total cost ÷ shipped quantity',
            })}
            {field('Profit', 'profitPerUnitUsd', c.profitPerUnitUsd, 'money', {
              hint: 'sell price − unit cost',
            })}
            {field('Pro. Percentage', 'profitPct', c.profitPct, 'percent', {
              hint: 'profit ÷ sell price',
            })}
            {field('Perfect price', 'targetPriceUsd', c.targetPriceUsd, 'money', {
              hint: c.isProfitable === true && over.targetPriceUsd == null
                ? 'nothing to fix at this price'
                : 'the price that would restore a 20% margin',
            })}
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
          title="Machines and time"
          subtitle="The factory's own figures. Nothing else in OpsFlow records them."
        />
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {plain('Dollar Rate', 'dollarRate', 'EGP per $')}
          {plain('Daily Cost', 'dailyCostEgp', 'EGP per day')}
          {plain('All F. Machines', 'machineCount')}
          {plain('Line Machines Qty', 'lineMachineQty')}
          {plain('Days in line', 'daysInLine')}
          {plain('Machine Already Used', 'machineDaysUsed', 'machine-days')}
          {field('Machine Cost', 'machineCostEgpPerDay', c.machineCostEgpPerDay, 'number', {
            places: 2, hint: 'daily cost ÷ machines, in EGP',
          })}
          {field('Work Days', 'workDays', c.workDays, 'number', {
            places: 1, hint: 'machine-days ÷ machines',
          })}
          {field('Productivity rate', 'productivityRate', c.productivityRate, 'number', {
            hint: 'pieces cut per work day',
          })}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Production quantities"
          subtitle="Counted on the floor and read from their ledgers. Typing here does not change them."
        />
        <div className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
          {field('Order Qty', 'orderQty', c.orderQty, 'number', { from: 'order ledger' })}
          {field('Cutted Qty', 'cutQty', c.cutQty, 'number', { from: 'cut ledger' })}
          {field('Shipped Qty', 'shippedQty', c.shippedQty, 'number', { from: 'shipped ledger' })}
          {field('1st Degree Qty', 'firstDegreeQty', c.firstDegreeQty, 'number', { from: 'out-line' })}
          {field('2nd Degree Qty', 'secondDegreeQty', c.secondDegreeQty, 'number', { from: '2nd-degree' })}
          {field('Diff. Percentage', 'diffPct', c.diffPct, 'percent', { hint: 'shipped vs ordered' })}
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
                {editing && <th className="th w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              <RowBlock
                caption="UsedFabric" rows={fabricRows} total={total} editing={editing}
                onEdit={editRow} onDelete={deleteRow} onAdd={() => addRow('FABRIC')} rowCost={rowCost}
                emptyText="No fabric on the bill of materials yet"
              />
              <SubtotalRow
                label="Fabric Costing" cost={liveFabric} total={total} editing={editing}
                value={over.fabricCostUsd ?? ''} calculated={c.groups.fabric.total}
                onChange={setOverride('fabricCostUsd')} onRevert={revert('fabricCostUsd')}
              />

              <RowBlock
                caption="UsedAcc" rows={accessoryRows} total={total} editing={editing}
                onEdit={editRow} onDelete={deleteRow} onAdd={() => addRow('ACCESSORY')} rowCost={rowCost}
                emptyText="No accessories on the bill of materials yet"
              />
              <SubtotalRow
                label="Accesory Costing" cost={liveAccessory} total={total} editing={editing}
                value={over.accessoryCostUsd ?? ''} calculated={c.groups.accessory.total}
                onChange={setOverride('accessoryCostUsd')} onRevert={revert('accessoryCostUsd')}
              />

              <OutsideRow
                label="Sublimation" cost={c.sublimationCostUsd} total={total} editing={editing}
                value={stored.sublimationCostUsd} onChange={setField('sublimationCostUsd')}
              />
              <OutsideRow
                label="Embroidery" cost={c.embroideryCostUsd} total={total} editing={editing}
                value={stored.embroideryCostUsd} onChange={setField('embroideryCostUsd')}
              />
              {otherRows.map((r) => (
                <EditableRow
                  key={r.key} row={r} total={total} editing={editing}
                  onEdit={editRow} onDelete={deleteRow} cost={rowCost(r)}
                />
              ))}
              {editing && (
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
                <td className="td text-right">
                  <CostCell
                    editing={editing} value={over.cmCostUsd ?? ''} calculated={c.cmCostUsd}
                    kind="money" onChange={setOverride('cmCostUsd')} onRevert={revert('cmCostUsd')}
                  />
                </td>
                <td className="td tnum text-right">{fmtPct(pctOf(c.cmCostUsd, total), 1)}</td>
                {editing && <td className="td" />}
              </tr>

              <tr className="bg-ink-100">
                <td className="td font-bold text-ink-900" colSpan={5}>Total</td>
                <td className="td text-right">
                  <CostCell
                    editing={editing} value={over.totalCostUsd ?? ''} calculated={c.totalCostUsd}
                    kind="money" className="font-semibold"
                    onChange={setOverride('totalCostUsd')} onRevert={revert('totalCostUsd')}
                  />
                </td>
                <td className="td tnum text-right font-semibold">
                  {total == null ? '—' : '100.0%'}
                </td>
                {editing && <td className="td" />}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Notes" subtitle="Anything about this costing that the numbers do not say." />
        <div className="p-4">
          {editing ? (
            <textarea
              className="input min-h-[5rem] resize-y"
              value={stored.notes}
              onChange={(e) => setField('notes')(e.target.value)}
              placeholder="Why a figure was overridden, what an invoice said, anything the next reader needs."
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-ink-800">{stored.notes || '—'}</p>
          )}
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

function RowBlock({
  caption, rows, total, editing, onEdit, onDelete, onAdd, rowCost, emptyText,
}: {
  caption: string;
  rows: RowDraft[];
  total: number | null;
  editing: boolean;
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
          <td className="td text-xs italic text-ink-400" colSpan={editing ? 7 : 6}>{emptyText}</td>
        </tr>
      ) : (
        rows.map((r, i) => (
          <EditableRow
            key={r.key}
            caption={i === 0 ? caption : ''}
            row={r} total={total} editing={editing}
            onEdit={onEdit} onDelete={onDelete} cost={rowCost(r)}
          />
        ))
      )}
      {editing && (
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
  caption, row, total, editing, onEdit, onDelete, cost,
}: {
  caption?: string;
  row: RowDraft;
  total: number | null;
  editing: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onDelete: (row: RowDraft) => void;
  cost: number | null;
}) {
  const origin = row.sourceRef
    ? row.derived ? `From ${explain(row.sourceRef)}` : `Edited — was from ${explain(row.sourceRef)}`
    : 'Added by hand';

  return (
    <tr className={clsx(!row.derived && row.sourceRef && 'bg-violet-50/40')}>
      <td className="td font-semibold text-ink-700">{caption ?? ''}</td>
      <td className="td" title={origin}>
        <TextCell
          editing={editing} value={row.label} placeholder="Item"
          onChange={(v) => onEdit(row.key, { label: v })}
        />
      </td>
      <td className="td text-right">
        <NumberCell
          editing={editing} value={row.quantity}
          display={row.quantity === '' ? '—' : fmtNumber(Number(row.quantity), { places: 2 })}
          onChange={(v) => onEdit(row.key, { quantity: v })}
        />
      </td>
      <td className="td">
        <TextCell
          editing={editing} value={row.unit} align="center"
          onChange={(v) => onEdit(row.key, { unit: v })}
        />
      </td>
      <td className="td text-right">
        <NumberCell
          editing={editing} value={row.unitPrice}
          display={row.unitPrice === '' ? '—' : fmtMoney(Number(row.unitPrice), '$', 4)}
          onChange={(v) => onEdit(row.key, { unitPrice: v })}
        />
      </td>
      <td className="td tnum text-right">{cost == null ? '—' : fmtMoney(cost)}</td>
      <td className="td tnum text-right">{fmtPct(pctOf(cost, total), 1)}</td>
      {editing && (
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
  label, cost, total, value, calculated, editing, onChange, onRevert,
}: {
  label: string;
  cost: number | null;
  total: number | null;
  value: string;
  calculated: number | null;
  editing: boolean;
  onChange: (v: string) => void;
  onRevert: () => void;
}) {
  return (
    <tr className="bg-ink-50">
      <td className="td font-semibold text-ink-900" colSpan={5}>{label}</td>
      <td className="td text-right">
        <CostCell
          editing={editing} value={value} calculated={calculated} kind="money"
          className="font-semibold" onChange={onChange} onRevert={onRevert}
        />
      </td>
      <td className="td tnum text-right font-semibold">{fmtPct(pctOf(cost, total), 1)}</td>
      {editing && <td className="td" />}
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
  label, cost, total, editing, value, onChange,
}: {
  label: string; cost: number | null; total: number | null;
  editing: boolean; value: string; onChange: (v: string) => void;
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
      <td className="td text-right">
        <NumberCell
          editing={editing} value={value}
          display={value === '' ? '—' : fmtMoney(Number(value), '$', 2)}
          onChange={onChange}
        />
      </td>
      <td className="td tnum text-right">{cost == null ? '—' : fmtMoney(cost)}</td>
      <td className="td tnum text-right">{fmtPct(pctOf(cost, total), 1)}</td>
      {editing && <td className="td" />}
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
