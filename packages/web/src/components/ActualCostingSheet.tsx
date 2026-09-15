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
import { Check, Cloud, CloudOff, Lock, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import {
  computeCosting, rowCost, applyRowEdit, sanitiseOverrides,
  fmtMoney, fmtNumber, fmtPct, NOT_CALCULATED,
  type CostLineInput, type CostingResult, type OrderDetailDto,
  type OverrideKey, type RowField,
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
  /** Typed directly against an invoice total, rather than rate × quantity. */
  cost: string;
  /** Which of the three the system worked out. Never overwritten by the others. */
  derivedField: RowField | null;
  /** What the bill of materials planned. Shown, never costed. */
  estimatedQty: number | null;
  /** Where it came from, when it came from somewhere. */
  sourceRef: string | null;
  /** True while it is still the derivation's row and nobody has touched it. */
  derived: boolean;
}

/**
 * How long to wait after the last keystroke before writing to the database.
 *
 * Long enough that typing "1250" is one save rather than four, short enough
 * that nobody gets as far as closing the tab believing they are done. The
 * arithmetic on screen does not wait for any of this — it is recomputed on
 * every keystroke — so this delay is invisible except in the saved indicator.
 */
const AUTOSAVE_DELAY_MS = 1200;

type SaveState = 'clean' | 'pending' | 'saving' | 'saved' | 'error';

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
  // The plan lives on the bill of materials, not on the costing, so it is
  // matched back on by where the row came from rather than stored twice.
  const planned = new Map(derived.map((d) => [`${d.sourceRef}|${d.label}`, d.estimatedQty ?? null]));
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
    cost: numText(rowCost({ quantity: l.quantity, unitPriceUsd: l.unitPriceUsd })),
    derivedField: l.quantity != null && l.unitPriceUsd != null ? 'cost' : null,
    estimatedQty: l.estimatedQty ?? planned.get(`${l.sourceRef}|${l.label}`) ?? null,
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
  const [saveState, setSaveState] = useState<SaveState>('clean');
  // Read inside the re-seeding effect, which must not depend on it.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** True while a request is in flight, so two never overlap. */
  const inFlightRef = useRef(false);
  /** The draft as it was when the in-flight save was sent. */
  const sentRef = useRef('');

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
    const fromServer = JSON.stringify([s, o, r, h]);
    setBaseline(fromServer);

    // Take the server's copy when nothing would be lost by it: either nobody
    // is editing, or they are but have typed nothing since the last save
    // landed.
    //
    // That second case is what stops an endless save loop. Somebody types
    // "2.50"; the database stores 2.5 and hands back "2.5"; the draft still
    // says "2.50", so it looks unsaved, so it saves again — for ever. Adopting
    // the server's spelling the moment the person pauses settles it, and
    // cannot interrupt them, because by definition they have stopped typing.
    const idle = currentRef.current === sentRef.current;
    if (editingRef.current && !idle) return;
    setStored(s); setOver(o); setRows(r); setHidden(h);
  }, [serverState]);

  /** The draft, as one comparable string. Changing it is what "unsaved" means. */
  const current = JSON.stringify([stored, over, rows, hidden]);
  const currentRef = useRef(current);
  currentRef.current = current;
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
      // The draft as it was when this request left. Anything typed since is
      // still unsaved, and the effect below will notice and send it.
      setBaseline(sentRef.current);
      setSaveState('saved');
      void qc.invalidateQueries({ queryKey: ['costing', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: () => setSaveState('error'),
    onSettled: () => { inFlightRef.current = false; },
  });

  /** Send the draft, unless one is already on its way. */
  const saveNow = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    sentRef.current = currentRef.current;
    setSaveState('saving');
    save.mutate();
  };
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;

  /**
   * Write the draft once the typing stops.
   *
   * Re-armed on every change, so a burst of keystrokes is one request rather
   * than one each. A save already in flight is not interrupted — when it lands
   * the baseline moves to what was sent, and anything typed meanwhile leaves
   * the draft dirty again, which brings this effect straight back. That is what
   * stops the last edit being the one that goes missing.
   */
  useEffect(() => {
    if (!editable || !dirty) return;
    setSaveState((prev) => (prev === 'saving' ? prev : 'pending'));
    const timer = setTimeout(() => saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [current, dirty, editable]);

  /**
   * Leaving the tab must not cost the last thing typed. The debounce window is
   * short, but closing an order inside it is exactly when it would hurt.
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => () => { if (dirtyRef.current) saveRef.current(); }, []);

  /**
   * The whole costing, recomputed from the draft on every keystroke.
   *
   * This is the same `computeCosting` the server runs on save, given the same
   * inputs — the order's facts as the server published them, plus whatever is
   * currently in the form. So the chain updates as it is typed, and the figure
   * on screen cannot drift from the figure that gets stored, because there is
   * only one implementation of the arithmetic.
   */
  const live: CostingResult = useMemo(() => computeCosting({
    ...c.source,
    hasRecord: c.hasRecord,
    costingDate: stored.costingDate || null,
    notes: stored.notes || null,
    dollarRate: asNumber(stored.dollarRate),
    dailyCostEgp: asNumber(stored.dailyCostEgp),
    machineCount: asNumber(stored.machineCount),
    machineDaysUsed: asNumber(stored.machineDaysUsed),
    daysInLine: asNumber(stored.daysInLine),
    lineMachineQty: asNumber(stored.lineMachineQty),
    sublimationCostUsd: asNumber(stored.sublimationCostUsd),
    embroideryCostUsd: asNumber(stored.embroideryCostUsd),
    overrides: sanitiseOverrides(over),
    lines: rows.map<CostLineInput>((r) => ({
      group: r.group,
      label: r.label,
      quantity: asNumber(r.quantity),
      unit: r.unit,
      unitPriceUsd: asNumber(r.unitPrice),
      sourceRef: r.sourceRef,
    })),
  }), [c.source, c.hasRecord, stored, over, rows]);

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
      waiting={live.waiting[key]}
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

  /** A label or unit change: no arithmetic, just the row's description. */
  const editRow = (key: string, patch: Partial<RowDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, derived: false } : r)));

  /**
   * A consumption, price or cost change. Any one of the three can be typed and
   * the other two follow; the row remembers which one the system supplied so
   * that it, and never the person's own figure, is the one recomputed.
   */
  const editRowNumber = (key: string, field: RowField, text: string) =>
    setRows((rs) => rs.map((r) => {
      if (r.key !== key) return r;
      const next = applyRowEdit(
        { quantity: asNumber(r.quantity), unitPriceUsd: asNumber(r.unitPrice), derivedField: r.derivedField },
        field,
        asNumber(text),
      );
      // The edited field keeps exactly what was typed — reformatting a number
      // somebody is halfway through is how "1." becomes unparseable.
      return {
        ...r,
        derived: false,
        derivedField: next.derivedField,
        quantity: field === 'quantity' ? text : numText(next.quantity),
        unitPrice: field === 'unitPrice' ? text : numText(next.unitPriceUsd),
        cost: field === 'cost' ? text : numText(rowCost(next)),
      };
    }));

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
      unitPrice: '', cost: '', derivedField: null, estimatedQty: null,
      sourceRef: null, derived: false,
    }]);

  const fabricRows = rows.filter((r) => r.group === 'FABRIC');
  const accessoryRows = rows.filter((r) => r.group === 'ACCESSORY');
  const otherRows = rows.filter((r) => r.group !== 'FABRIC' && r.group !== 'ACCESSORY');

  /** What a row currently costs, from the same helper the engine uses. */
  const costOf = (r: RowDraft): number | null =>
    rowCost({ quantity: asNumber(r.quantity), unitPriceUsd: asNumber(r.unitPrice) });

  const liveFabric = live.groups.fabric.total;
  const liveAccessory = live.groups.accessory.total;
  const total = live.totalCostUsd;
  // What one piece of cut-and-make costs — the C.M total over the pieces it is
  // charged against. Derived here for display only; the engine owns the total.
  const cmPerPiece = live.cmCostUsd != null && live.firstDegreeQty
    ? live.cmCostUsd / live.firstDegreeQty
    : null;

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

      {/* Edit puts the section into a form, as everywhere else in OpsFlow. What
          is different is that there is nothing to press afterwards: changes are
          written a moment after the typing stops, and the indicator says so. */}
      <div className="no-print flex items-center justify-end gap-3">
        <SaveState state={saveState} dirty={dirty} onRetry={() => saveNow()} />
        <button className="btn-secondary btn-sm" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" /> Print
        </button>
        {editable && (
          <button
            className={editing ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
            onClick={() => {
              // Leaving edit mode must not strand an unsaved keystroke.
              if (editing && dirty) saveNow();
              setEditing(!editing);
            }}
          >
            {editing ? <><Check className="h-3.5 w-3.5" /> Done</> : <><Pencil className="h-3.5 w-3.5" /> Edit costing</>}
          </button>
        )}
      </div>

      {saveState === 'error' && (
        <div className="no-print">
          <ErrorNote error={save.error} onRetry={() => saveNow()} />
          <p className="mt-1 text-2xs text-ink-500">
            Your changes are still on screen and nothing has been lost. They will be written
            again as soon as the next edit is made, or press Try again.
          </p>
        </div>
      )}

      {live.overridden.length > 0 && (
        <p className="no-print text-xs text-violet-700">
          {live.overridden.length} figure{live.overridden.length === 1 ? '' : 's'} on this costing
          {live.overridden.length === 1 ? ' was' : ' were'} typed in rather than calculated. Each says
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
            {field('Customer', 'customer', live.source.customer, 'text', { from: 'the order' })}
            {field('Order Name', 'orderName', live.source.orderName, 'text', { from: 'the order' })}
            {field('Item Type', 'itemType', live.source.itemType, 'text', { from: 'the order' })}
            {field('Po No', 'poNumber', live.source.poNumber, 'text', { from: 'the order' })}
            {field('Style No', 'styleNumber', live.source.styleNumber, 'text', { from: 'the order' })}
          </div>
        </Card>

        <Card>
          <CardHeader title="The result" subtitle="Per piece, against what shipped." />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {field('Sell Price', 'sellPriceUsd', live.source.sellPriceUsd, 'money', { from: 'Order Details' })}
            {field('Actual Cost/Unit', 'unitActualCostUsd', live.unitActualCostUsd, 'money', {
              hint: 'total cost ÷ shipped quantity',
            })}
            {field('Profit', 'profitPerUnitUsd', live.profitPerUnitUsd, 'money', {
              hint: 'sell price − unit cost',
            })}
            {field('Pro. Percentage', 'profitPct', live.profitPct, 'percent', {
              hint: 'profit ÷ sell price',
            })}
            {field('Perfect price', 'targetPriceUsd', live.targetPriceUsd, 'money', {
              hint: live.isProfitable === true && over.targetPriceUsd == null
                ? 'nothing to fix at this price'
                : 'the price that would restore a 20% margin',
            })}
            <div className="flex items-end">
              <p className={clsx(
                'w-full rounded-md px-2.5 py-1.5 text-center text-xs font-medium',
                live.isProfitable === true && 'bg-emerald-50 text-emerald-800',
                live.isProfitable === false && 'bg-red-50 text-red-700',
                live.isProfitable == null && 'bg-ink-50 text-ink-500',
              )}>
                {live.isProfitable === true ? 'In profit'
                  : live.isProfitable === false ? 'At a loss'
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
          {/* Worked out from the line machines and the days in line, which sit
              two fields above it. Still typeable, like every calculated field
              on this sheet. Same field, same place, same label. */}
          {field('Machine Already Used', 'machineDaysUsed', live.machineDaysUsed, 'number', {
            hint: 'line machines × days in line',
          })}
          {field('Machine Cost', 'machineCostEgpPerDay', live.machineCostEgpPerDay, 'number', {
            places: 2, hint: 'daily cost ÷ machines, in EGP',
          })}
          {field('Work Days', 'workDays', live.workDays, 'number', {
            places: 1, hint: 'machine-days ÷ machines',
          })}
          {field('Productivity rate', 'productivityRate', live.productivityRate, 'number', {
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
          {field('Order Qty', 'orderQty', live.source.orderQty, 'number', { from: 'order ledger' })}
          {field('Cutted Qty', 'cutQty', live.source.cutQty, 'number', { from: 'cut ledger' })}
          {field('Shipped Qty', 'shippedQty', live.source.shippedQty, 'number', { from: 'shipped ledger' })}
          {field('1st Degree Qty', 'firstDegreeQty', live.source.firstDegreeQty, 'number', { from: 'out-line' })}
          {field('2nd Degree Qty', 'secondDegreeQty', live.source.secondDegreeQty, 'number', { from: '2nd-degree' })}
          {field('Diff. Percentage', 'diffPct', live.diffPct, 'percent', { hint: 'shipped vs ordered' })}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Costing"
          subtitle="Materials from the bill of materials, outside work from the External Order section. Rows can be edited, added and removed here without changing either."
        />
        <div className="overflow-x-auto">
          {/* Wide enough for the widest figure each column can hold: a unit
              price carries four decimals, so "$1,234.5678" has to fit without
              being cut off. The container scrolls sideways rather than
              squeezing the columns. */}
          <table className="w-full min-w-[64rem]">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th w-28">Section</th>
                <th className="th">Item</th>
                <th className="th w-28 text-right">Planned</th>
                <th className="th w-32 text-right">Actual Cons.</th>
                <th className="th w-24">Unit</th>
                <th className="th w-36 text-right">Unit Price</th>
                <th className="th w-36 text-right">Cost</th>
                <th className="th w-20 text-right">Percentage</th>
                {editing && <th className="th w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              <RowBlock
                caption="UsedFabric" rows={fabricRows} total={total} editing={editing}
                onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow}
                onAdd={() => addRow('FABRIC')} rowCost={costOf}
                emptyText="No fabric on the bill of materials yet"
              />
              <SubtotalRow
                label="Fabric Costing" cost={liveFabric} total={total} editing={editing}
                value={over.fabricCostUsd ?? ''} calculated={live.groups.fabric.total}
                onChange={setOverride('fabricCostUsd')} onRevert={revert('fabricCostUsd')}
              />

              <RowBlock
                caption="UsedAcc" rows={accessoryRows} total={total} editing={editing}
                onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow}
                onAdd={() => addRow('ACCESSORY')} rowCost={costOf}
                emptyText="No accessories on the bill of materials yet"
              />
              <SubtotalRow
                label="Accesory Costing" cost={liveAccessory} total={total} editing={editing}
                value={over.accessoryCostUsd ?? ''} calculated={live.groups.accessory.total}
                onChange={setOverride('accessoryCostUsd')} onRevert={revert('accessoryCostUsd')}
              />

              <OutsideRow
                label="Sublimation" cost={live.sublimationCostUsd} total={total} editing={editing}
                value={stored.sublimationCostUsd} onChange={setField('sublimationCostUsd')}
              />
              <OutsideRow
                label="Embroidery" cost={live.embroideryCostUsd} total={total} editing={editing}
                value={stored.embroideryCostUsd} onChange={setField('embroideryCostUsd')}
              />
              {otherRows.map((r) => (
                <EditableRow
                  key={r.key} row={r} total={total} editing={editing}
                  onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow} cost={costOf(r)}
                />
              ))}
              {editing && (
                <tr className="no-print">
                  <td className="td" />
                  <td className="td" colSpan={8}>
                    <button className="btn-ghost btn-sm text-2xs" onClick={() => addRow('EXTERNAL')}>
                      <Plus className="h-3 w-3" /> Add an outside-work or other cost
                    </button>
                  </td>
                </tr>
              )}

              {/* C.M — (machine cost × machine-days) ÷ productivity, charged
                  against the pieces that passed end-line inspection. The
                  consumption and unit price columns show that quantity and the
                  cost per piece, so the row multiplies out to its own total the
                  way every other row in this table does. */}
              <tr className="bg-ink-50">
                <td className="td font-semibold text-ink-900">C.M</td>
                <td className="td text-ink-600">Production — machine run cost per piece</td>
                <td className="td" />
                <td className="td tnum text-right">
                  {live.firstDegreeQty == null ? '—' : fmtNumber(live.firstDegreeQty)}
                </td>
                <td className="td">PCS</td>
                <td className="td tnum text-right">
                  {cmPerPiece == null ? '—' : fmtMoney(cmPerPiece, '$', 4)}
                </td>
                <td className="td text-right">
                  <CostCell
                    editing={editing} value={over.cmCostUsd ?? ''} calculated={live.cmCostUsd}
                    kind="money" onChange={setOverride('cmCostUsd')} onRevert={revert('cmCostUsd')}
                  />
                </td>
                <td className="td tnum text-right">{fmtPct(pctOf(live.cmCostUsd, total), 1)}</td>
                {editing && <td className="td" />}
              </tr>

              <tr className="bg-ink-100">
                <td className="td font-bold text-ink-900" colSpan={6}>Total</td>
                <td className="td text-right">
                  <CostCell
                    editing={editing} value={over.totalCostUsd ?? ''} calculated={live.totalCostUsd}
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

      <MissingNotes live={live} />
    </div>
  );
}

/**
 * Whether what is on screen has reached the database.
 *
 * Deliberately quiet: a costing screen that shouts after every keystroke is
 * worse than one that says nothing. It only speaks up when something is
 * outstanding or has failed.
 */
function SaveState({
  state, dirty, onRetry,
}: {
  state: SaveState; dirty: boolean; onRetry: () => void;
}) {
  if (state === 'error') {
    return (
      <button className="flex items-center gap-1.5 text-2xs font-medium text-red-700" onClick={onRetry}>
        <CloudOff className="h-3.5 w-3.5" /> Not saved — try again
      </button>
    );
  }
  if (state === 'saving') {
    return <span className="flex items-center gap-1.5 text-2xs text-ink-500"><Cloud className="h-3.5 w-3.5" /> Saving…</span>;
  }
  if (dirty || state === 'pending') {
    return <span className="flex items-center gap-1.5 text-2xs text-ink-400"><Cloud className="h-3.5 w-3.5" /> Unsaved changes</span>;
  }
  if (state === 'saved') {
    return <span className="flex items-center gap-1.5 text-2xs text-emerald-700"><Check className="h-3.5 w-3.5" /> All changes saved</span>;
  }
  return null;
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
  caption, rows, total, editing, onEdit, onEditNumber, onDelete, onAdd, rowCost, emptyText,
}: {
  caption: string;
  rows: RowDraft[];
  total: number | null;
  editing: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onEditNumber: (key: string, field: RowField, text: string) => void;
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
          <td className="td text-xs italic text-ink-400" colSpan={editing ? 8 : 7}>{emptyText}</td>
        </tr>
      ) : (
        rows.map((r, i) => (
          <EditableRow
            key={r.key}
            caption={i === 0 ? caption : ''}
            row={r} total={total} editing={editing}
            onEdit={onEdit} onEditNumber={onEditNumber} onDelete={onDelete} cost={rowCost(r)}
          />
        ))
      )}
      {editing && (
        <tr className="no-print">
          <td className="td" />
          <td className="td" colSpan={8}>
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
  caption, row, total, editing, onEdit, onEditNumber, onDelete, cost,
}: {
  caption?: string;
  row: RowDraft;
  total: number | null;
  editing: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onEditNumber: (key: string, field: RowField, text: string) => void;
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
      <td className="td tnum text-right text-2xs text-ink-400">
        {row.estimatedQty == null ? '—' : fmtNumber(row.estimatedQty, { places: 2 })}
      </td>
      <td className="td text-right">
        <NumberCell
          editing={editing} value={row.quantity}
          derived={row.derivedField === 'quantity'}
          display={row.quantity === '' ? '—' : fmtNumber(Number(row.quantity), { places: 2 })}
          onChange={(v) => onEditNumber(row.key, 'quantity', v)}
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
          derived={row.derivedField === 'unitPrice'}
          display={row.unitPrice === '' ? '—' : fmtMoney(Number(row.unitPrice), '$', 4)}
          onChange={(v) => onEditNumber(row.key, 'unitPrice', v)}
        />
      </td>
      <td className="td text-right">
        <NumberCell
          editing={editing} value={row.cost}
          derived={row.derivedField === 'cost'}
          display={cost == null ? '—' : fmtMoney(cost)}
          onChange={(v) => onEditNumber(row.key, 'cost', v)}
        />
      </td>
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
      <td className="td font-semibold text-ink-900" colSpan={6}>{label}</td>
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
      <td className="td" colSpan={4} />
      <td className="td text-right">
        <NumberCell
          editing={editing} value={value}
          display={cost == null ? '—' : fmtMoney(cost)}
          placeholder={cost == null ? '' : String(cost)}
          onChange={onChange}
        />
      </td>
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
function MissingNotes({ live }: { live: CostingResult }) {
  // Every "waiting for" the engine produced, once each, in the order the
  // screen reads. The engine names them because it is the only thing that
  // knows which input was missing.
  const seen = new Set<string>();
  const missing = ['sellPriceUsd', 'shippedQty', 'dollarRate', 'machineCostEgpPerDay', 'workDays', 'totalCostUsd']
    .map((k) => live.waiting[k])
    .filter((m): m is string => !!m && !seen.has(m) && (seen.add(m), true));

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
