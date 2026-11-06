/**
 * Actual Costing — `Actual Costing_Coordinator` from the workbook.
 *
 * Every field, every grouping and every calculation is the sheet's; the look is
 * OpsFlow's. The coordinators reading this have the workbook's order of fields
 * in their heads — identity, then the machine figures, then the money, then the
 * two rows of production quantities, then the costing table with UsedFabric
 * above UsedAcc — and the table keeps that order. Above it, though, the page
 * leads with the answer the sheet exists to give: the profit on one piece, in
 * a dark panel at the top, with what the cost is made of beside it. The
 * figures under that are two sheets of label and value, and the costing table
 * folds each section to its subtotal. What is not kept is Excel's black
 * banners and hairline borders: this is a screen in an application, and it
 * should look like the rest of it.
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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Cloud, CloudOff, Download, Lock, Pencil, Plus, Printer, RotateCcw, Trash2 } from 'lucide-react';
import {
  computeCosting, rowCost, applyRowEdit, sanitiseOverrides, visibleDerivedLines, outsideWorkKind, editableText, sourceRefCovers,
  bomRefItemId, isOverrideKey, isTextOverride, typedNumberOrNull,
  fmtMoney, fmtNumber, fmtPct, formatCell, NOT_CALCULATED,
  type CostLineInput, type CostingResult, type OrderDetailDto,
  type OverrideKey, type RowField,
} from '@opsflow/shared';
import { api, ApiError, type CostLineDto, type CostingDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  CostCell, CostField, NumberCell, SheetRow, StoredField, TextCell,
} from './CostValue';
import { Card, CardHeader, ErrorNote, clsx, useToast } from './ui';

type Group = CostLineDto['group'];

/** The figures stored in their own columns, as opposed to typed over a formula. */
interface Stored {
  costingDate: string;
  dailyCostUsd: string;
  machineCount: string;
  lineMachineQty: string;
  daysInLine: string;
  machineDaysUsed: string;
  sublimationCostUsd: string;
  embroideryCostUsd: string;
  /** An outside-work figure typed before the Sublimation and Embroidery rows existed. */
  externalOpCostUsd: string;
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

/**
 * `conflict`: somebody else saved this costing after it was loaded here. The
 * server refused the save, and autosave stops — retrying would only be refused
 * again, and the person needs to see the other version before deciding.
 */
type SaveState = 'clean' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

const numText = (v: number | null | undefined): string => (v == null ? '' : String(v));

/**
 * Empty means "nobody has said", which is not the same as zero. Read the one
 * way every OpsFlow figure is read (`readTypedNumber`), so "1,250.00" is 1250
 * in the calculation and in the save alike; an unreadable figure is null.
 */
const asNumber = (s: string): number | null => typedNumberOrNull(s);

/**
 * The stored figures that are counts — machines and days — and are kept as
 * whole numbers. The server refuses a fraction for any of them, and because a
 * save carries the whole draft, one "5.5" used to fail every autosave after it.
 */
const WHOLE_FIELDS = ['machineCount', 'lineMachineQty', 'daysInLine', 'machineDaysUsed'] as const;

/**
 * A count as typed: the number, null when blank, or undefined when it is not a
 * whole number. Undefined is left out of the save entirely, so the rest of the
 * draft is written and the stored count stays as it was until it is fixed.
 */
const asWhole = (s: string): number | null | undefined => {
  const n = asNumber(s);
  if (n == null) return s.trim() === '' ? null : undefined;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** The stored amounts, which the server keeps between nothing and this. */
const MONEY_FIELDS = ['dailyCostUsd', 'sublimationCostUsd', 'embroideryCostUsd', 'externalOpCostUsd'] as const;
const MAX_AMOUNT = 99_999_999;
/** The columns a row's consumption and price are stored in. */
const MAX_QUANTITY = 9_999_999_999;
/** The bound the server puts on a figure typed over a calculation. */
const MAX_OVERRIDE = 1e12;

/**
 * An amount that cannot be negative, as typed: the number, null when blank,
 * or undefined when it cannot be stored (negative, too large, unreadable).
 * Undefined is left out of the save, as `asWhole` leaves out a fraction, so
 * one bad figure no longer fails every save after it.
 */
const asAmount = (s: string, max: number): number | null | undefined => {
  const n = asNumber(s);
  if (n == null) return s.trim() === '' ? null : undefined;
  return n >= 0 && n <= max ? n : undefined;
};

/**
 * The typed overrides as the engine and the server read them: a figure parsed
 * the sheet's one way (so "1,250" is 1250, not dropped), identity text as
 * typed. An override may be negative — a loss typed over the profit is real.
 */
function overrideValues(over: Record<string, string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(over)) {
    if (!isOverrideKey(k)) continue;
    if (isTextOverride(k)) { out[k] = v; continue; }
    const n = asNumber(v);
    if (n != null && Math.abs(n) <= MAX_OVERRIDE) out[k] = n;
  }
  return out;
}

/**
 * A row nobody has named yet. The server needs a name for every row, so it is
 * not sent — and it is kept on screen across re-seeds, left out of the live
 * total so the total on screen is the one stored, and marked until named.
 */
const isUnsent = (r: RowDraft) => !r.derived && r.label.trim() === '';

/**
 * The server's rows, taken over the draft's without disturbing what is on
 * screen.
 *
 * The server recreates every line on save, with new ids, so its copy came
 * back with new React keys: the input being typed in was remounted and lost
 * its focus, and an edited derived row jumped to the end of its section. Each
 * server row takes the key of the draft row it is (matched by where it came
 * from, else by section and name), and when every one matched, the draft's
 * order is kept. Rows not sent — no name yet — are kept, and the derived row
 * the server re-created in place of an unnamed edited one is not shown beside
 * it.
 */
function adoptRows(prev: RowDraft[], server: RowDraft[]): RowDraft[] {
  const unsent = prev.filter(isUnsent);
  const unsentRefs = new Set(unsent.flatMap((r) => (r.sourceRef ? [r.sourceRef] : [])));
  const incoming = server.filter((r) => r.sourceRef == null || !unsentRefs.has(r.sourceRef));
  const used = new Set<number>();
  const take = (match: (r: RowDraft) => boolean): number | undefined => {
    const i = prev.findIndex((r, j) => !used.has(j) && !isUnsent(r) && match(r));
    if (i < 0) return undefined;
    used.add(i);
    return i;
  };
  const placed = incoming.map((s) => {
    const at = s.sourceRef != null
      ? take((r) => r.sourceRef === s.sourceRef)
      : take((r) => r.sourceRef == null && r.group === s.group && r.label.trim() === s.label.trim());
    return { row: at == null ? s : { ...s, key: prev[at].key }, at };
  });
  const kept = unsent.map((r) => ({ row: r, at: prev.indexOf(r) as number | undefined }));
  const all = [...placed, ...kept];
  if (all.every((x) => x.at != null)) return all.sort((a, b) => a.at! - b.at!).map((x) => x.row);
  return all.map((x) => x.row);
}

function storedFrom(record: CostingDto | null): Stored {
  return {
    costingDate: record?.costingDate?.slice(0, 10) ?? '',
    // Money is held to two decimals, as the sheet shows it; a figure stored
    // with more (a converted one, say) reads and saves as its rounded self.
    dailyCostUsd: editableText(record?.dailyCostUsd, 'money'),
    machineCount: numText(record?.machineCount),
    lineMachineQty: numText(record?.lineMachineQty),
    daysInLine: numText(record?.daysInLine),
    machineDaysUsed: numText(record?.machineDaysUsed),
    sublimationCostUsd: editableText(record?.sublimationCostUsd, 'money'),
    embroideryCostUsd: editableText(record?.embroideryCostUsd, 'money'),
    externalOpCostUsd: editableText(record?.externalOpCostUsd, 'money'),
    notes: record?.notes ?? '',
  };
}

function overridesFrom(record: CostingDto | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record?.overrides ?? {})) if (v != null) out[k] = String(v);
  return out;
}

/**
 * The costing table's rows: what the production sections say now, and what
 * somebody typed.
 *
 * The derived rows come from the live derivation, never from the lines the last
 * save stored. Those are a snapshot, so the sheet went stale the moment the
 * warehouse issued more fabric, while the reports and the order detail — which
 * derive afresh — moved on. Only the hand-entered rows are read from the
 * record, and the derived rows they replace or that were removed are taken out
 * by the same rule the server applies, so the sheet and the stored costing
 * cannot disagree.
 */
function rowsFrom(record: CostingDto | null, derived: CostLineDto[]): RowDraft[] {
  const manual = (record?.lines ?? []).filter((l) => l.source === 'MANUAL');
  // The plan lives on the bill of materials, not on the costing, so it is
  // matched back on by where the row came from rather than stored twice —
  // a BOM row by its line id alone, so an edited row keeps its plan after the
  // line's category changes.
  const planKey = (ref: string) => bomRefItemId(ref) ?? ref;
  const planned = new Map(derived.map((d) => [planKey(d.sourceRef ?? ''), d.estimatedQty ?? null]));
  const live = visibleDerivedLines(
    derived.map((d) => ({ ...d, sourceRef: d.sourceRef ?? '' })),
    manual.map((l) => l.sourceRef),
    record?.hiddenCostRefs ?? [],
  );
  const source = [
    ...live.map((d) => ({ ...d, source: 'DERIVED' as const })),
    ...manual,
  ];
  return source.map((l, i) => ({
    key: l.id ?? `${l.sourceRef ?? 'row'}-${i}`,
    group: l.group,
    label: l.label,
    quantity: numText(l.quantity),
    unit: l.unit,
    unitPrice: numText(l.unitPriceUsd),
    cost: numText(rowCost({ quantity: l.quantity, unitPriceUsd: l.unitPriceUsd })),
    derivedField: l.quantity != null && l.unitPriceUsd != null ? 'cost' : null,
    estimatedQty: l.estimatedQty ?? (l.sourceRef ? planned.get(planKey(l.sourceRef)) : null) ?? null,
    sourceRef: l.sourceRef ?? null,
    derived: l.source !== 'MANUAL',
  }));
}

export function ActualCostingSheet({ order }: { order: OrderDetailDto }) {
  const { can } = useAuth();
  // The server withholds the costing from a role without costing:read, and
  // the sheet must not so much as load for one: it could never show the
  // record, so anything it saved would be an empty draft over the real one.
  if (!can('costing:read') || order.costing == null) {
    return (
      <div className="p-5">
        <div className="flex items-start gap-2.5 rounded-md border border-ink-200 bg-ink-50 px-4 py-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
          <p className="text-xs leading-relaxed text-ink-700">
            Your role cannot see this order's costing. That needs the
            <strong> costing:read </strong> permission.
          </p>
        </div>
      </div>
    );
  }
  return <ReloadableCostingSheet order={order} c={order.costing} />;
}

/**
 * The sheet, remounted from the server's copy when a save was refused because
 * somebody else had changed the costing. A remount, rather than resetting the
 * draft in place, because the draft lives in half a dozen pieces of state and
 * one forgotten among them is how the stale copy would come back.
 */
function ReloadableCostingSheet({ order, c }: { order: OrderDetailDto; c: CostingResult }) {
  const qc = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const reload = async () => {
    await Promise.all([
      qc.refetchQueries({ queryKey: ['costing', order.id] }),
      qc.invalidateQueries({ queryKey: ['order', order.id] }),
    ]);
    setGeneration((g) => g + 1);
  };
  return <CostingSheet key={generation} order={order} c={c} onReload={reload} />;
}

function CostingSheet({ order, c, onReload }: { order: OrderDetailDto; c: CostingResult; onReload: () => Promise<void> }) {
  const { can } = useAuth();
  const qc = useQueryClient();

  const costing = useQuery({
    queryKey: ['costing', order.id],
    queryFn: () => api.steps.costing(order.id),
  });

  // Writing needs the record loaded first. A role that could write but not
  // read — or anyone, in the moment before the record arrives — would
  // otherwise autosave a blank draft, and the server would replace the notes,
  // the figures and every hand-added row with it.
  const mayWrite = can('costing:read') && can('costing:write');
  // On the data, not the query's status: a background refetch that fails
  // flipped isSuccess off and took the form away mid-edit.
  const editable = mayWrite && costing.data != null;
  const toast = useToast();

  const record = costing.data?.data ?? null;
  const derivedLines = useMemo(() => costing.data?.derived ?? [], [costing.data]);

  const [stored, setStored] = useState<Stored>(() => storedFrom(record));
  /** The record held an old outside-work figure: its row stays while it is being cleared. */
  const initialOuter = record?.externalOpCostUsd != null;
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
  /** A save asked for while one was in flight (leaving the tab): sent when that one lands. */
  const queuedRef = useRef(false);
  /**
   * The server's version this draft was edited from: taken from the record
   * when the draft adopts it, and from each save's answer. Sent with every
   * save so one made over somebody else's newer copy is refused.
   */
  const versionRef = useRef<string | null>(record?.updatedAt ?? null);
  /** Set once a save is refused as stale; nothing more is sent from this copy. */
  const staleRef = useRef(false);

  // Re-seed when the server's copy actually changes — including when the user
  // switches to a different order, which replaces the data without remounting.
  //
  // Keyed on the values rather than the object: the query refetches in the
  // background and hands back a new object every time, which would throw away
  // whatever the coordinator was in the middle of typing.
  const serverState = JSON.stringify([
    order.id, storedFrom(record), overridesFrom(record),
    rowsFrom(record, derivedLines), record?.hiddenCostRefs ?? [], record?.updatedAt ?? null,
  ]);
  /** The draft as last rendered, for the re-seed below to merge into. */
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  /** The order whose copy the draft last took; another order's draft is never merged in. */
  const seededOrderRef = useRef<string | null>(null);
  useEffect(() => {
    const [orderId, s, o, r, h, version] = JSON.parse(serverState) as
      [string, Stored, Record<string, string>, RowDraft[], string[], string | null];
    const sameOrder = seededOrderRef.current === orderId;
    // A copy fetched while a save is on its way, or one older than the copy
    // this draft already holds, is behind what is on screen: adopted, it was
    // then autosaved over the newer save. The save's own refetch follows.
    if (sameOrder && inFlightRef.current) return;
    if (sameOrder && version != null && versionRef.current != null
      && Date.parse(version) < Date.parse(versionRef.current)) return;
    const fromServer = JSON.stringify([s, o, r, h]);

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
    if (editingRef.current && !idle) { setBaseline(fromServer); return; }
    // The draft is now the server's copy, so its version is the server's too.
    // Not before: a draft kept over a newer copy must still name the old one,
    // so its save is refused instead of overwriting the newer copy.
    versionRef.current = version;
    seededOrderRef.current = orderId;
    // A count that is not a whole number, or an amount that cannot be stored,
    // was never sent, so the server's copy still holds the old one. Keep what
    // was typed on screen, marked, rather than silently putting the old figure
    // back under the person's cursor.
    const nextStored = { ...s };
    const nextRows = sameOrder ? adoptRows(rowsRef.current, r) : r;
    if (sameOrder) {
      const prev = storedRef.current;
      for (const k of WHOLE_FIELDS) if (asWhole(prev[k]) === undefined) nextStored[k] = prev[k];
      for (const k of MONEY_FIELDS) if (asAmount(prev[k], MAX_AMOUNT) === undefined) nextStored[k] = prev[k];
    }
    // The baseline is the draft as adopted: what was kept on screen because it
    // could not be sent is not "unsaved", or it would be sent again for ever.
    setBaseline(JSON.stringify([nextStored, o, nextRows, h]));
    setStored(nextStored); setOver(o); setRows(nextRows); setHidden(h);
  }, [serverState]);

  /** The draft, as one comparable string. Changing it is what "unsaved" means. */
  const current = JSON.stringify([stored, over, rows, hidden]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const dirty = baseline !== '' && current !== baseline;

  const save = useMutation({
    mutationFn: () => api.steps.saveCosting(order.id, {
      costingDate: stored.costingDate || null,
      // Undefined — a count that is not a whole number, an amount below zero
      // — is dropped from the request, so the rest of the draft still saves.
      dailyCostUsd: asAmount(stored.dailyCostUsd, MAX_AMOUNT),
      machineCount: asWhole(stored.machineCount),
      lineMachineQty: asWhole(stored.lineMachineQty),
      daysInLine: asWhole(stored.daysInLine),
      machineDaysUsed: asWhole(stored.machineDaysUsed),
      sublimationCostUsd: asAmount(stored.sublimationCostUsd, MAX_AMOUNT),
      embroideryCostUsd: asAmount(stored.embroideryCostUsd, MAX_AMOUNT),
      externalOpCostUsd: asAmount(stored.externalOpCostUsd, MAX_AMOUNT),
      notes: stored.notes || null,
      overrides: overrideValues(over),
      hiddenCostRefs: hidden,
      expectedUpdatedAt: versionRef.current,
      // Rows the derivation should stop producing: everything somebody has
      // touched or added. A row still marked derived is left to it, so it goes
      // on following the bill of materials.
      manualLines: rows
        .filter((r) => !r.derived && !isUnsent(r))
        .map((r) => ({
          group: r.group,
          label: r.label.trim(),
          quantity: asAmount(r.quantity, MAX_QUANTITY),
          unit: r.unit.trim() || 'LOT',
          unitPriceUsd: asAmount(r.unitPrice, MAX_AMOUNT),
          sourceRef: r.sourceRef,
        })),
    }),
    onSuccess: (saved) => {
      // The draft as it was when this request left. Anything typed since is
      // still unsaved, and the effect below will notice and send it.
      versionRef.current = saved.updatedAt;
      setBaseline(sentRef.current);
      setSaveState('saved');
      void qc.invalidateQueries({ queryKey: ['costing', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        staleRef.current = true;
        setSaveState('conflict');
        return;
      }
      setSaveState('error');
    },
    onSettled: () => {
      inFlightRef.current = false;
      if (queuedRef.current) { queuedRef.current = false; saveRef.current(); }
    },
  });

  /** Send the draft, unless one is already on its way or this copy is out of date. */
  const saveNow = () => {
    if (inFlightRef.current || staleRef.current) return;
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
    if (!editable || !dirty || staleRef.current) return;
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
  useEffect(() => () => {
    if (!dirtyRef.current) return;
    // A save already on its way returns `saveNow` early; the edit typed
    // after it was sent would be dropped. Queue one behind it instead.
    if (inFlightRef.current) queuedRef.current = true; else saveRef.current();
  }, []);
  // Closing or reloading the page inside the debounce (the deploy's own
  // reload included) must ask first, or the last keystrokes go missing.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

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
    // Only what would be saved, so the figures on screen are the ones stored.
    dailyCostUsd: asAmount(stored.dailyCostUsd, MAX_AMOUNT) ?? null,
    machineCount: asWhole(stored.machineCount) ?? null,
    machineDaysUsed: asWhole(stored.machineDaysUsed) ?? null,
    daysInLine: asWhole(stored.daysInLine) ?? null,
    lineMachineQty: asWhole(stored.lineMachineQty) ?? null,
    sublimationCostUsd: asAmount(stored.sublimationCostUsd, MAX_AMOUNT) ?? null,
    embroideryCostUsd: asAmount(stored.embroideryCostUsd, MAX_AMOUNT) ?? null,
    externalOpCostUsd: asAmount(stored.externalOpCostUsd, MAX_AMOUNT) ?? null,
    overrides: sanitiseOverrides(overrideValues(over)),
    // A row with no name is not saved, so it is not in the total either.
    lines: rows.filter((r) => !isUnsent(r)).map<CostLineInput>((r) => ({
      group: r.group,
      label: r.label,
      quantity: r.derived ? asNumber(r.quantity) : asAmount(r.quantity, MAX_QUANTITY) ?? null,
      unit: r.unit,
      unitPriceUsd: r.derived ? asNumber(r.unitPrice) : asAmount(r.unitPrice, MAX_AMOUNT) ?? null,
      sourceRef: r.sourceRef,
    })),
  }), [c.source, c.hasRecord, stored, over, rows]);

  /**
   * The costing as a PDF, from what the server holds. Held back while a save
   * is outstanding, so the document can never be a keystroke behind the
   * screen; the autosave lands a moment after typing stops, and the button
   * comes back with it.
   */
  const pdf = useMutation({ mutationFn: () => api.steps.downloadCostingPdf(order.id) });
  const pdfReady = !dirty && saveState !== 'saving' && saveState !== 'pending';

  const setField = (key: keyof Stored) => (v: string) => setStored((s) => ({ ...s, [key]: v }));
  const setOverride = (key: OverrideKey) => (v: string) =>
    setOver((o) => (v.trim() === '' ? drop(o, key) : { ...o, [key]: v }));
  const revert = (key: OverrideKey) => () => setOver((o) => drop(o, key));

  /**
   * What a cell would say without its override. Once typed over, the live
   * figure *is* the typed one; the engine keeps the calculated one, and that
   * is the figure offered back.
   */
  const calc = (key: OverrideKey, liveValue: number | string | null) =>
    over[key] != null && live.calculated[key] !== undefined ? live.calculated[key] : liveValue;

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
      calculated={calc(key, calculated)}
      kind={kind}
      places={opts.places}
      hint={opts.hint}
      from={opts.from}
      waiting={live.waiting[key]}
      onChange={setOverride(key)}
      onRevert={revert(key)}
    />
  );

  /**
   * A field backed by its own stored column. `fallback` is the figure OpsFlow
   * uses while the box is blank, and where it holds it.
   */
  const plain = (
    label: string, key: keyof Stored,
    opts: { hint?: string; kind?: 'money' | 'number'; fallback?: { value: string; note: string } | null } = {},
  ) => {
    const whole = (WHOLE_FIELDS as readonly string[]).includes(key);
    return (
      <StoredField
        label={label}
        editing={editing}
        value={stored[key]}
        kind={opts.kind}
        hint={opts.hint}
        fallback={opts.fallback ?? undefined}
        invalid={whole && asWhole(stored[key]) === undefined
          ? 'A whole number — this one is not saved until it is'
          : (MONEY_FIELDS as readonly string[]).includes(key) && asAmount(stored[key], MAX_AMOUNT) === undefined
            ? 'Not a figure that can be stored — this one is not saved until it is'
            : undefined}
        onChange={setField(key)}
      />
    );
  };

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
    // costing remembers it was removed. The reference names this BOM row
    // alone, so removing one fabric leaves the others where they were.
    if (row.sourceRef) setHidden((h) => (h.includes(row.sourceRef!) ? h : [...h, row.sourceRef!]));
  };

  /**
   * Put back every bill-of-materials row the costing no longer shows: the
   * ones removed here (by accident, often) and any added to the BOM since.
   * A row edited here keeps the figures typed into it — that is the person's
   * own work, not something the BOM should overwrite.
   */
  // The live lines and the removed ones together: the server leaves removed
  // rows out of the live list, so without these the button saw nothing missing.
  const removedLines = useMemo(() => costing.data?.removed ?? [], [costing.data]);
  const bomRows = useMemo(
    () => rowsFrom(null, [...derivedLines, ...removedLines]).filter((r) => r.sourceRef?.startsWith('bom:')),
    [derivedLines, removedLines],
  );
  const missingFromBom = bomRows.filter((b) => !rows.some((r) => r.sourceRef
    && (sourceRefCovers(r.sourceRef, b.sourceRef!) || sourceRefCovers(b.sourceRef!, r.sourceRef))));
  const restoreFromBom = () => {
    const back = missingFromBom;
    setHidden((h) => h.filter((ref) => !ref.startsWith('bom:')));
    if (back.length > 0) {
      setRows((rs) => {
        // Each group in the bill's own order: the restored rows go back where they were.
        const order = new Map(bomRows.map((b, i) => [b.sourceRef, i]));
        const at = (r: RowDraft) => (r.sourceRef != null && order.has(r.sourceRef) ? order.get(r.sourceRef)! : Number.MAX_SAFE_INTEGER);
        const all = [...rs, ...back];
        const derivedBom = all.filter((r) => r.derived && r.sourceRef?.startsWith('bom:')).sort((a, b) => at(a) - at(b));
        const rest = all.filter((r) => !(r.derived && r.sourceRef?.startsWith('bom:')));
        return [...derivedBom, ...rest];
      });
    }
    toast.success(back.length > 0
      ? `${back.length} row${back.length === 1 ? '' : 's'} brought back from the bill of materials`
      : 'Every row on the bill of materials is already on the costing');
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
  /**
   * Sublimation and embroidery are totalled on their own rows below, by the
   * same `outsideWorkKind` split the engine uses. A derived line for either is
   * therefore not listed again here — it was, and the same cost appeared twice
   * with shares adding past 100%. A hand-added one stays listed, so it can
   * still be edited or removed, but says where it is counted instead of
   * claiming a share of its own.
   */
  const kindOf = (r: RowDraft) =>
    r.group === 'EXTERNAL' ? outsideWorkKind({ label: r.label, sourceRef: r.sourceRef }) : null;
  const otherRows = rows.filter((r) =>
    r.group !== 'FABRIC' && r.group !== 'ACCESSORY' && !(r.derived && kindOf(r) != null));
  /**
   * Labour and other costs are listed in this section too, so its subtotal
   * counts them: it was the outside work alone, and the rows under it did not
   * add up to it.
   */
  const hasOther = otherRows.some((r) => r.group === 'OTHER' || r.group === 'LABOUR');
  const outsideSubtotal = hasOther && live.otherCostUsd != null
    ? (live.externalCostUsd ?? 0) + live.otherCostUsd
    : live.externalCostUsd;

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

  /** How many columns the costing table has: one more while editing, for the remove button. */
  const cols = editing ? 8 : 7;

  /** Which sections of the table are folded to their subtotal. Editing unfolds them all. */
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const isOpen = (k: string) => editing || !closed[k];
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));

  /** The cost, split the way the engine adds it up. Shares are of the parts' own sum, so they always close to 100%. */
  const parts = [
    { key: 'fabric', name: 'Fabric', cost: live.fabricCostUsd, swatch: 'bg-accent-500' },
    { key: 'accessory', name: 'Accessories', cost: live.accessoryCostUsd, swatch: 'bg-accent-300' },
    { key: 'external', name: 'Outside work', cost: live.externalCostUsd, swatch: 'bg-ink-300' },
    { key: 'cm', name: 'Cut & make', cost: live.cmCostUsd, swatch: 'bg-ink-500' },
    ...(live.otherCostUsd != null ? [{ key: 'other', name: 'Other', cost: live.otherCostUsd, swatch: 'bg-ink-600' }] : []),
  ];
  const partsSum = parts.reduce((a, p) => a + (p.cost ?? 0), 0);

  // Cost per unit against the sell price, as a bar: the one picture that says
  // "did we make money" without a number being read.
  const costRatio = live.unitActualCostUsd != null && live.sellPriceUsd ? live.unitActualCostUsd / live.sellPriceUsd : null;
  /** A profit figure exists, but parts of the cost are not known yet, so no verdict is given on it. */
  const incomplete = live.isProfitable == null && live.profitPerUnitUsd != null && live.incomplete.length > 0;
  const profitTone = live.isProfitable === true ? 'text-emerald-300' : live.isProfitable === false ? 'text-red-300' : 'text-white';
  const identity = [live.identity.customer, live.identity.orderName, live.identity.poNumber && `PO ${live.identity.poNumber}`, live.identity.styleNumber && `Style ${live.identity.styleNumber}`]
    .filter(Boolean).join(' · ');

  return (
    <div className="print-document space-y-4 p-5">
      {!mayWrite && (
        <div className="no-print flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs leading-relaxed text-amber-900">
            You can read this costing but not change it — that needs the
            <strong> costing:write </strong> permission, which your role does not carry.
            Everything below is shown as recorded.
          </p>
        </div>
      )}

      {/* Edit puts the sheet into a form, as everywhere else in OpsFlow. What
          is different is that there is nothing to press afterwards: changes are
          written a moment after the typing stops, and the indicator says so. */}
      <div className="no-print toolbar">
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-ink-900">Actual costing</span>
          {stored.costingDate && <span className="tnum text-xs text-ink-500">{stored.costingDate}</span>}
          <SaveState state={saveState} dirty={dirty} onRetry={() => saveNow()} onReload={() => void onReload()} />
          {live.overridden.length > 0 && (
            <span
              className="chip bg-violet-50 text-violet-700 ring-violet-200"
              title="Typed in rather than calculated. Each says so under its value, and can be put back while editing."
            >
              {live.overridden.length} typed figure{live.overridden.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!pdfReady || pdf.isPending}
          title={pdfReady ? 'Download this costing as a PDF' : 'Waiting for the last change to save'}
          onClick={() => pdf.mutate()}
        >
          <Download className="h-3.5 w-3.5" /> {pdf.isPending ? 'Creating PDF…' : 'Costing PDF'}
        </button>
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

      {pdf.isError && (
        <div className="no-print">
          <ErrorNote error={pdf.error} onRetry={() => pdf.mutate()} />
        </div>
      )}

      {saveState === 'error' && (
        <div className="no-print">
          <ErrorNote error={save.error} onRetry={() => saveNow()} />
          <p className="mt-1 text-2xs text-ink-500">
            Your changes are still on screen and nothing has been lost. They will be written
            again as soon as the next edit is made, or press Try again.
          </p>
        </div>
      )}

      {/* ── The answer ──────────────────────────────────────────────────
          One dark summary band across the page: the profit on one piece in
          the largest type, the five figures it is made of beside it, and
          under both what the cost is made of and how it stands against the
          sell price. A coordinator should be able to answer "did we make
          money on this?" without reading anything below. */}
      <section className="overflow-hidden rounded-lg bg-ink-900 text-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/10 px-5 py-3">
          <p className="min-w-0 truncate text-2xs font-semibold uppercase tracking-wider text-ink-400">
            Costing summary{identity && <span className="ml-2 font-normal normal-case tracking-normal text-ink-300">{identity}</span>}
          </p>
          <span className={clsx(
            'shrink-0 rounded-full px-2.5 py-1 text-2xs font-semibold ring-1 ring-inset',
            live.isProfitable === true && 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/40',
            live.isProfitable === false && 'bg-red-400/15 text-red-300 ring-red-400/40',
            live.isProfitable == null && incomplete && 'bg-amber-400/15 text-amber-300 ring-amber-400/40',
            live.isProfitable == null && !incomplete && 'bg-white/10 text-ink-300 ring-white/20',
          )}>
            {live.isProfitable === true ? 'In profit' : live.isProfitable === false ? 'At a loss' : incomplete ? 'Incomplete' : 'Not calculated yet'}
          </span>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <div className="border-b border-white/10 px-5 py-5 lg:border-b-0 lg:border-r">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">Profit per piece</p>
            <HeroStat
              big editing={editing} kind="money"
              value={over.profitPerUnitUsd ?? ''} calculated={calc('profitPerUnitUsd', live.profitPerUnitUsd)}
              waiting={live.waiting.profitPerUnitUsd} valueClass={profitTone}
              onChange={setOverride('profitPerUnitUsd')} onRevert={revert('profitPerUnitUsd')}
              note={live.totalProfitUsd != null && live.shippedQty != null
                ? `${fmtMoney(live.totalProfitUsd)} in all, on ${fmtNumber(live.shippedQty)} pieces shipped`
                : 'sell price − actual cost per unit, against what shipped'}
            />
          </div>
          <div className="grid grid-cols-2 gap-px bg-white/10 sm:grid-cols-3 xl:grid-cols-5 [&>*]:bg-ink-900 [&>*]:px-5 [&>*]:py-5 [&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1">
            <HeroStat
              label="Total cost" editing={editing} kind="money"
              value={over.totalCostUsd ?? ''} calculated={calc('totalCostUsd', live.totalCostUsd)} waiting={live.waiting.totalCostUsd}
              onChange={setOverride('totalCostUsd')} onRevert={revert('totalCostUsd')} note="every cost row, added up"
            />
            <HeroStat
              label="Cost / unit" editing={editing} kind="money"
              value={over.unitActualCostUsd ?? ''} calculated={calc('unitActualCostUsd', live.unitActualCostUsd)} waiting={live.waiting.unitActualCostUsd}
              onChange={setOverride('unitActualCostUsd')} onRevert={revert('unitActualCostUsd')} note="total cost ÷ shipped qty"
            />
            <HeroStat
              label="Sell price" editing={editing} kind="money"
              value={over.sellPriceUsd ?? ''} calculated={calc('sellPriceUsd', live.source.sellPriceUsd)} waiting={live.waiting.sellPriceUsd}
              onChange={setOverride('sellPriceUsd')} onRevert={revert('sellPriceUsd')} note="from Order Details"
            />
            <HeroStat
              label="Profit %" editing={editing} kind="percent"
              value={over.profitPct ?? ''} calculated={calc('profitPct', live.profitPct)} waiting={live.waiting.profitPct}
              onChange={setOverride('profitPct')} onRevert={revert('profitPct')} note="profit ÷ sell price" valueClass={profitTone}
            />
            <HeroStat
              label="Perfect price" editing={editing} kind="money"
              value={over.targetPriceUsd ?? ''} calculated={calc('targetPriceUsd', live.targetPriceUsd)} waiting={live.waiting.targetPriceUsd}
              onChange={setOverride('targetPriceUsd')} onRevert={revert('targetPriceUsd')}
              note={live.isProfitable === true && over.targetPriceUsd == null ? 'nothing to fix at this price' : 'cost per unit + 20% mark-up'}
            />
          </div>
        </div>

        <div className="grid gap-x-8 gap-y-5 border-t border-white/10 px-5 py-4 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">What the cost is made of</p>
              {over.totalCostUsd != null && <span className="text-2xs text-violet-300">total typed</span>}
            </div>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/10" aria-hidden>
              {partsSum > 0 && parts.map((p) => p.cost ? (
                <div key={p.key} className={p.swatch} style={{ width: `${(p.cost / partsSum) * 100}%` }} title={`${p.name} ${fmtPct((p.cost / partsSum) * 100, 1)}`} />
              ) : null)}
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
              {parts.map((p) => (
                <li key={p.key} className="flex items-center gap-1.5 text-xs">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-sm', p.swatch)} />
                  <span className="text-ink-300">{p.name}</span>
                  <span className={clsx('tnum font-semibold', p.cost == null ? 'text-ink-500' : 'text-white')}>{p.cost == null ? '—' : fmtMoney(p.cost)}</span>
                  {p.cost != null && partsSum > 0 && <span className="tnum text-ink-400">{fmtPct((p.cost / partsSum) * 100, 1)}</span>}
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">Cost against the sell price</p>
            {costRatio != null ? (
              <>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={clsx('h-full rounded-full', live.incomplete.length > 0 ? 'bg-ink-400' : costRatio > 1 ? 'bg-red-400' : 'bg-emerald-400')}
                    style={{ width: `${Math.min(costRatio, 1) * 100}%` }}
                  />
                </div>
                <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-ink-300">
                  <span>Cost per unit <span className="tnum font-semibold text-white">{fmtMoney(live.unitActualCostUsd!)}</span></span>
                  <span>
                    {costRatio > 1
                      ? <span className="text-red-300">{fmtPct((costRatio - 1) * 100, 1)} above the sell price</span>
                      : <>{fmtPct(costRatio * 100, 1)} of the sell price</>}
                  </span>
                  <span>Sell price <span className="tnum font-semibold text-white">{fmtMoney(live.sellPriceUsd!)}</span></span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-ink-400">Shown once the cost per unit and the sell price are both known.</p>
            )}
          </div>
        </div>

        <MissingNotes live={live} />
      </section>

      {/* ── 2. The figures ──────────────────────────────────────────────
          Two sheets of label and value, side by side: what the order is and
          what it produced on the left; the factory's own figures and what is
          worked out from them on the right. Each row says where its figure
          came from, so nothing has to be taken on trust. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={<Numbered n={1}>Order &amp; quantities</Numbered>} subtitle="Read from the order and its ledgers." />
          <Band>Order</Band>
          <div className="divide-y divide-ink-100">
            {field('Customer', 'customer', live.source.customer, 'text')}
            {field('Order name', 'orderName', live.source.orderName, 'text')}
            {field('PO no', 'poNumber', live.source.poNumber, 'text')}
            {field('Style no', 'styleNumber', live.source.styleNumber, 'text')}
            {field('Item type', 'itemType', live.source.itemType, 'text')}
          </div>
          <Band className="border-t">Quantities</Band>
          <div className="divide-y divide-ink-100">
            {field('Order qty', 'orderQty', live.source.orderQty, 'number', { from: 'the order ledger' })}
            {field('Cut qty', 'cutQty', live.source.cutQty, 'number', { from: live.source.cutQtySource === 'recorded' ? 'the cutting records' : 'the cut order' })}
            {field('1st degree qty', 'firstDegreeQty', live.source.firstDegreeQty, 'number', { from: 'the out-line ledger' })}
            {field('2nd degree qty', 'secondDegreeQty', live.source.secondDegreeQty, 'number', { from: 'the 2nd-degree ledger' })}
            {field('Shipped qty', 'shippedQty', live.source.shippedQty, 'number', { from: 'the shipped ledger' })}
            {field('Diff. %', 'diffPct', live.diffPct, 'percent', { hint: 'shipped ÷ ordered − 100%' })}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={<Numbered n={2}>Production figures</Numbered>} subtitle="The factory's own figures, in dollars, and what OpsFlow works out from them." />
          <Band>
            Entered here
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-400">left blank, a figure is taken from where OpsFlow already holds it</span>
          </Band>
          <div className="divide-y divide-ink-100">
            <StoredField
              label="Date" editing={editing} type="date"
              value={stored.costingDate} onChange={setField('costingDate')}
              hint="the day this costing was made"
            />
            {plain('Daily cost', 'dailyCostUsd', {
              kind: 'money',
              hint: '$ per day, the whole factory',
              fallback: live.dailyCostSource === 'factory' && live.dailyCostUsd != null
                ? { value: fmtMoney(live.dailyCostUsd), note: `the factory's daily cost${live.defaultsFromPo ? `, last entered on PO ${live.defaultsFromPo}` : ''}` }
                : null,
            })}
            {plain('All F. machines', 'machineCount', {
              hint: 'every machine in the factory',
              fallback: live.machineCountSource === 'factory' && live.machineCount != null
                ? { value: fmtNumber(live.machineCount), note: "the factory's machine count" }
                : null,
            })}
            {plain('Line machines', 'lineMachineQty', {
              hint: "machines on this order's line",
              fallback: live.lineMachineSource === 'production' && live.lineMachineQty != null
                ? { value: fmtNumber(live.lineMachineQty), note: "the Production step's machine table" }
                : null,
            })}
            {plain('Days in line', 'daysInLine', {
              hint: 'days the order occupied the line',
              fallback: live.daysInLineSource === 'production' && live.daysInLineUsed != null
                ? { value: fmtNumber(live.daysInLineUsed), note: 'days with sewing recorded' }
                : null,
            })}
          </div>
          <Band className="border-t">Worked out</Band>
          <div className="divide-y divide-ink-100">
            {field('Machine cost', 'machineCostPerDay', live.machineCostPerDay, 'money', {
              places: 2, hint: 'daily cost ÷ all machines, per machine-day',
            })}
            {field('Machine-days used', 'machineDaysUsed', live.machineDaysUsed, 'number', {
              hint: 'line machines × days in line',
            })}
            {field('Work days', 'workDays', live.workDays, 'number', {
              places: 2, hint: 'machine-days ÷ all machines',
            })}
            {field('Productivity rate', 'productivityRate', live.productivityRate, 'number', {
              places: 2, hint: "the Production step's target per day",
            })}
            <ReadRow
              label="C.M / piece"
              value={cmPerPiece == null ? null : perPiece(cmPerPiece)}
              note="the cut-and-make total over the pieces passed"
            />
          </div>
        </Card>
      </div>

      {/* ── 3. The costing table ────────────────────────────────────────
          UsedFabric above UsedAcc, then the outside work and the C.M, as the
          workbook has them — each a section that folds to its subtotal, so
          forty accessory rows do not stand between the reader and the total. */}
      <Card>
        <CardHeader
          title={<Numbered n={3}>Cost breakdown</Numbered>}
          subtitle="Materials from the bill of materials, outside work from the External Order section. Rows can be edited, added and removed here without changing either."
          action={editable && (
            <button
              type="button"
              className="no-print btn-secondary btn-sm shrink-0"
              title={missingFromBom.length > 0
                ? `Put back ${missingFromBom.length} row${missingFromBom.length === 1 ? '' : 's'} of the bill of materials that ${missingFromBom.length === 1 ? 'is' : 'are'} not on the costing`
                : 'Every row of the bill of materials is on the costing'}
              onClick={restoreFromBom}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Take all from the BOM
              {missingFromBom.length > 0 && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-2xs font-semibold text-amber-800">{missingFromBom.length}</span>}
            </button>
          )}
        />
        <div className="overflow-x-auto">
          {/* Wide enough for the widest figure each column can hold — every
              figure on this sheet is shown to two decimals, so "$1,234.56"
              has to fit without being cut off. The container scrolls
              sideways rather than squeezing the columns. */}
          <table className="w-full min-w-[42rem]">
            <thead className="border-b border-ink-200">
              <tr>
                <th className="th pl-4">Item</th>
                <th className="th text-right">Planned</th>
                <th className="th text-right">Actual cons.</th>
                <th className="th text-center">Unit</th>
                <th className="th text-right">Unit price</th>
                <th className="th text-right">Cost</th>
                <th className="th pr-4 text-right">Share</th>
                {editing && <th className="th w-8 px-1" />}
              </tr>
            </thead>
            <tbody className="[&>tr]:border-t [&>tr]:border-ink-100">
              <SectionRow
                cols={cols} swatch="bg-accent-500" title="Fabric" note="UsedFabric · bill of materials" count={fabricRows.length}
                open={isOpen('fabric')} onToggle={() => toggle('fabric')} share={pctCell(pctOf(liveFabric, total))}
                subtotal={
                  <CostCell
                    editing={editing} value={over.fabricCostUsd ?? ''} calculated={calc('fabricCostUsd', live.groups.fabric.total)} kind="money"
                    className="font-semibold" onChange={setOverride('fabricCostUsd')} onRevert={revert('fabricCostUsd')}
                  />
                }
              />
              <RowBlock
                rows={fabricRows} total={total} editing={editing} cols={cols} hidden={!isOpen('fabric')}
                onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow}
                onAdd={() => addRow('FABRIC')} addLabel="Add a fabric row" rowCost={costOf}
                emptyText="No fabric on the bill of materials yet"
              />

              <SectionRow
                cols={cols} swatch="bg-accent-300" title="Accessories" note="UsedAcc · bill of materials" count={accessoryRows.length}
                open={isOpen('accessory')} onToggle={() => toggle('accessory')} share={pctCell(pctOf(liveAccessory, total))}
                subtotal={
                  <CostCell
                    editing={editing} value={over.accessoryCostUsd ?? ''} calculated={calc('accessoryCostUsd', live.groups.accessory.total)} kind="money"
                    className="font-semibold" onChange={setOverride('accessoryCostUsd')} onRevert={revert('accessoryCostUsd')}
                  />
                }
              />
              <RowBlock
                rows={accessoryRows} total={total} editing={editing} cols={cols} hidden={!isOpen('accessory')}
                onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow}
                onAdd={() => addRow('ACCESSORY')} addLabel="Add an accessory row" rowCost={costOf}
                emptyText="No accessories on the bill of materials yet"
              />

              <SectionRow
                cols={cols} swatch="bg-ink-300" title={hasOther ? 'Outside work & other' : 'Outside work'} note="External Order section" count={2 + otherRows.length}
                open={isOpen('external')} onToggle={() => toggle('external')} share={pctCell(pctOf(outsideSubtotal, total))}
                subtotal={<span className="tnum font-semibold text-ink-900">{outsideSubtotal == null ? '—' : fmtMoney(outsideSubtotal)}</span>}
              />
              <OutsideRow
                label="Sublimation" cost={live.sublimationCostUsd} total={total} editing={editing} hidden={!isOpen('external')}
                value={stored.sublimationCostUsd} onChange={setField('sublimationCostUsd')}
              />
              <OutsideRow
                label="Embroidery" cost={live.embroideryCostUsd} total={total} editing={editing} hidden={!isOpen('external')}
                value={stored.embroideryCostUsd} onChange={setField('embroideryCostUsd')}
              />
              {/* A figure from before the two rows above existed. It is in the
                  total, so it is shown — and can be cleared — rather than
                  adding to the subtotal from nowhere. */}
              {(stored.externalOpCostUsd.trim() !== '' || initialOuter) && (
                <OutsideRow
                  label="Other outside work" cost={asNumber(stored.externalOpCostUsd)} total={total} editing={editing} hidden={!isOpen('external')}
                  value={stored.externalOpCostUsd} onChange={setField('externalOpCostUsd')}
                />
              )}
              {otherRows.map((r) => {
                const kind = kindOf(r);
                return (
                  <EditableRow
                    key={r.key} row={r} total={total} editing={editing} hidden={!isOpen('external')}
                    onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow} cost={costOf(r)}
                    countedIn={kind === 'SUBLIMATION' ? 'Sublimation' : kind === 'EMBROIDERY' ? 'Embroidery' : undefined}
                  />
                );
              })}
              {editing && <AddRow cols={cols} label="Add an outside-work or other cost" onAdd={() => addRow('EXTERNAL')} />}

              {/* C.M — the factory's formula: machine cost × machine-days ÷
                  productivity rate, charged against the pieces that passed
                  end-line inspection. The consumption and unit price columns
                  show that quantity and the cost per piece, so the row
                  multiplies out to its own total like every other row. */}
              <SectionRow cols={cols} swatch="bg-ink-500" title="Cut & make" note="production figures" />
              <tr>
                <td className={clsx(TD, 'pl-4')}>
                  <span className="font-medium text-ink-900">C.M</span>
                  <span className="block max-w-[16rem] whitespace-normal text-2xs leading-snug text-ink-400">machine cost × machine-days ÷ productivity rate, per piece passed</span>
                </td>
                <td className={TD} />
                <td className={clsx(TD, 'tnum text-right')}>
                  {live.firstDegreeQty == null ? '—' : fmtNumber(live.firstDegreeQty)}
                </td>
                <td className={clsx(TD, 'text-center')}>PCS</td>
                <td className={clsx(TD, 'tnum text-right')}>
                  {cmPerPiece == null ? '—' : perPiece(cmPerPiece)}
                </td>
                <td className={clsx(TD, 'text-right')}>
                  <CostCell
                    editing={editing} value={over.cmCostUsd ?? ''} calculated={calc('cmCostUsd', live.cmCostUsd)}
                    kind="money" onChange={setOverride('cmCostUsd')} onRevert={revert('cmCostUsd')}
                  />
                </td>
                <td className={clsx(TD, 'tnum pr-4 text-right')}>{pctCell(pctOf(live.cmCostUsd, total))}</td>
                {editing && <td className={TDX} />}
              </tr>

              <tr className="!border-t-0 bg-ink-900 text-white">
                <td className={clsx(TD, 'pl-4 py-3 font-semibold text-white')} colSpan={5}>Total actual cost</td>
                <td className={clsx(TD, 'py-3 text-right')}>
                  <CostCell
                    editing={editing} value={over.totalCostUsd ?? ''} calculated={calc('totalCostUsd', live.totalCostUsd)}
                    kind="money" className={clsx('font-semibold', !editing && '!text-white')}
                    onChange={setOverride('totalCostUsd')} onRevert={revert('totalCostUsd')}
                  />
                </td>
                <td className={clsx(TD, 'tnum py-3 pr-4 text-right font-semibold text-white')}>
                  {total == null ? '—' : '100.00%'}
                </td>
                {editing && <td className={TDX} />}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title={<Numbered n={4}>Notes</Numbered>} subtitle="Anything about this costing that the numbers do not say." />
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
/** A per-piece cost: four decimals below a dollar, where two would round $0.028 to $0.03. */
const perPiece = (n: number) => fmtMoney(n, '$', Math.abs(n) < 1 ? 4 : 2);


function SaveState({
  state, dirty, onRetry, onReload,
}: {
  state: SaveState; dirty: boolean; onRetry: () => void; onReload: () => void;
}) {
  if (state === 'conflict') {
    // Not quiet: what is on screen is no longer what is stored, and nothing
    // typed from here on will be saved.
    return (
      <span role="alert" className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-2xs text-red-800">
        <CloudOff className="h-3.5 w-3.5 shrink-0" />
        Changed by someone else — not saved.
        <button type="button" className="font-semibold underline" onClick={onReload}>Reload</button>
      </span>
    );
  }
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

/** A cell of the costing table. Tighter than `.td`: the table has fifty rows. */
const TD = 'whitespace-nowrap px-3 py-2 text-sm text-ink-700';
/** The slim last column that holds a row's remove button while editing. */
const TDX = 'px-1 py-2';

/** A card title with its place on the page, so the sheet reads as one numbered document. */
function Numbered({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="tnum grid h-5 w-5 shrink-0 place-items-center rounded bg-ink-900 text-2xs font-semibold text-white">{n}</span>
      {children}
    </span>
  );
}

/** A thin caption across a card, splitting one group of rows from the next. */
function Band({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('border-b border-ink-100 bg-ink-50/70 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500', className)}>
      {children}
    </div>
  );
}

/** A figure shown for information only, in the same row shape as the typeable ones. */
function ReadRow({ label, value, note }: { label: string; value: string | null; note?: string }) {
  return (
    <SheetRow label={label} note={note}>
      <p className={clsx('tnum text-sm font-semibold', value == null ? 'text-ink-300' : 'text-ink-900')}>{value ?? '—'}</p>
    </SheetRow>
  );
}

/**
 * One figure of the dark result panel: a label, the figure, and a line under
 * it. Typeable like every other figure on the sheet, with the same violet
 * marking and the same way back to the calculated number.
 */
function HeroStat({
  label, big, editing, kind, value, calculated, waiting, note, valueClass, onChange, onRevert,
}: {
  label?: string;
  big?: boolean;
  editing: boolean;
  kind: 'money' | 'percent';
  value: string;
  calculated: number | string | null;
  waiting?: string;
  note?: string;
  valueClass?: string;
  onChange: (v: string) => void;
  onRevert: () => void;
}) {
  const overridden = value.trim() !== '';
  const unknown = !overridden && calculated == null;
  const shown = overridden ? formatCell(asNumber(value), kind) : formatCell(calculated, kind);
  const under = overridden
    ? <span className="text-violet-300">typed · calculated {formatCell(calculated, kind)}</span>
    : unknown && waiting ? <span className="text-amber-300">{waiting}</span>
    : note;
  return (
    <div className="min-w-0">
      {label && <p className="text-2xs font-semibold uppercase tracking-wider text-ink-300">{label}</p>}
      {editing ? (
        <div className="mt-1 inline-block">
          <CostCell editing value={value} calculated={calculated} kind={kind} onChange={onChange} onRevert={onRevert} />
        </div>
      ) : (
        <p
          className={clsx(
            'tnum truncate font-semibold leading-none',
            big ? 'mt-1 text-4xl tracking-tight' : 'mt-1 text-lg',
            overridden ? 'text-violet-300' : unknown ? 'text-ink-500' : (valueClass ?? 'text-white'),
          )}
          title={unknown ? NOT_CALCULATED : shown}
        >
          {unknown ? '—' : shown}
        </p>
      )}
      {under && <p className="mt-1.5 text-2xs leading-snug text-ink-400">{under}</p>}
    </div>
  );
}

/**
 * The caption row of one section of the costing table: its name, how many
 * rows it holds, and its subtotal — so the section still says what it cost
 * when it is folded away.
 */
function SectionRow({
  cols, swatch, title, note, count, open, onToggle, subtotal, share,
}: {
  cols: number; swatch?: string; title: string; note?: string; count?: number;
  open?: boolean; onToggle?: () => void; subtotal?: ReactNode; share?: ReactNode;
}) {
  const foldable = onToggle != null;
  const label = (
    <>
      {swatch && <span className={clsx('mr-2 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]', swatch)} />}
      <span className="text-xs font-semibold uppercase tracking-wider text-ink-800">{title}</span>
      {(note || count != null) && (
        <span className="ml-2 text-2xs text-ink-400">
          {note}{note && count != null && ' · '}{count != null && `${count} row${count === 1 ? '' : 's'}`}
        </span>
      )}
    </>
  );
  return (
    <tr className="bg-ink-50">
      <td className="px-3 py-2 pl-4" colSpan={subtotal ? 5 : cols}>
        {foldable ? (
          <button
            type="button"
            className="flex items-center gap-1.5 text-left"
            title={open ? 'Fold this section to its subtotal' : 'Show the rows of this section'}
            aria-expanded={open}
            onClick={onToggle}
          >
            <ChevronDown className={clsx('no-print h-3.5 w-3.5 shrink-0 text-ink-400 transition-transform', !open && '-rotate-90')} />
            <span>{label}</span>
          </button>
        ) : (
          <span className="flex items-center gap-1.5"><span className="no-print h-3.5 w-3.5 shrink-0" /><span>{label}</span></span>
        )}
      </td>
      {subtotal && (
        <>
          <td className={clsx(TD, 'text-right')}>{subtotal}</td>
          <td className={clsx(TD, 'tnum pr-4 text-right font-semibold text-ink-900')}>{share}</td>
          {cols > 7 && <td className={TDX} />}
        </>
      )}
    </tr>
  );
}

/** The "add a row" line at the foot of a section, only while editing. */
function AddRow({ cols, label, onAdd }: { cols: number; label: string; onAdd: () => void }) {
  return (
    <tr className="no-print">
      <td className="px-3 py-1" colSpan={cols}>
        <button className="btn-ghost btn-sm text-2xs" onClick={onAdd}>
          <Plus className="h-3 w-3" /> {label}
        </button>
      </td>
    </tr>
  );
}

/** A folded row stays in the document — it still prints — but not on screen. */
const foldClass = (hidden?: boolean) => (hidden ? 'hidden print:table-row' : undefined);

function RowBlock({
  rows, total, editing, cols, hidden, onEdit, onEditNumber, onDelete, onAdd, addLabel, rowCost, emptyText,
}: {
  rows: RowDraft[];
  total: number | null;
  editing: boolean;
  cols: number;
  hidden?: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onEditNumber: (key: string, field: RowField, text: string) => void;
  onDelete: (row: RowDraft) => void;
  onAdd: () => void;
  addLabel: string;
  rowCost: (r: RowDraft) => number | null;
  emptyText: string;
}) {
  return (
    <>
      {rows.length === 0 ? (
        <tr className={foldClass(hidden)}>
          <td className={clsx(TD, 'pl-4 text-xs italic text-ink-400')} colSpan={cols}>{emptyText}</td>
        </tr>
      ) : (
        rows.map((r) => (
          <EditableRow
            key={r.key}
            row={r} total={total} editing={editing} hidden={hidden}
            onEdit={onEdit} onEditNumber={onEditNumber} onDelete={onDelete} cost={rowCost(r)}
          />
        ))
      )}
      {editing && <AddRow cols={cols} label={addLabel} onAdd={onAdd} />}
    </>
  );
}

/**
 * A row's share of the total, or a dash when there is none to work out. Every
 * empty row reading "Not calculated" in this narrow column made the table too
 * wide for the card and pushed Cost and % off its edge.
 */
function pctCell(pct: number | null | undefined) {
  return pct == null || !Number.isFinite(pct)
    ? <span className="text-ink-300" title={NOT_CALCULATED}>—</span>
    : fmtPct(pct, 2);
}

function EditableRow({
  row, total, editing, hidden, onEdit, onEditNumber, onDelete, cost, countedIn,
}: {
  /** The dedicated row this one's cost is totalled on, when it is not its own. */
  countedIn?: string;
  row: RowDraft;
  total: number | null;
  editing: boolean;
  hidden?: boolean;
  onEdit: (key: string, patch: Partial<RowDraft>) => void;
  onEditNumber: (key: string, field: RowField, text: string) => void;
  onDelete: (row: RowDraft) => void;
  cost: number | null;
}) {
  const edited = !row.derived && row.sourceRef != null;
  const origin = row.sourceRef
    ? row.derived ? `From ${explain(row.sourceRef)}` : `Edited — was from ${explain(row.sourceRef)}`
    : 'Added by hand';

  return (
    <tr className={clsx(edited && 'bg-violet-50/40', !editing && cost == null && !countedIn && 'text-ink-400 [&_*]:!text-ink-400', foldClass(hidden))}>
      <td className={clsx(TD, 'pl-4')} title={origin}>
        <TextCell
          editing={editing} value={row.label} placeholder="Item"
          onChange={(v) => onEdit(row.key, { label: v })}
        />
        {!editing && edited && <span className="ml-2 text-2xs text-violet-600">edited</span>}
        {isUnsent(row) && <span className="block text-2xs text-red-600">Name this row to save it</span>}
      </td>
      <td className={clsx(TD, 'tnum text-right text-2xs text-ink-400')}>
        {row.estimatedQty == null ? '—' : fmtNumber(row.estimatedQty, { places: 2 })}
      </td>
      <td className={clsx(TD, 'text-right')}>
        <NumberCell
          editing={editing} value={row.quantity}
          derived={row.derivedField === 'quantity'} nonNegative
          display={row.quantity === '' ? '—' : fmtNumber(asNumber(row.quantity), { places: 2 })}
          onChange={(v) => onEditNumber(row.key, 'quantity', v)}
        />
      </td>
      <td className={clsx(TD, 'text-center')}>
        <TextCell
          editing={editing} value={row.unit} align="center"
          onChange={(v) => onEdit(row.key, { unit: v })}
        />
      </td>
      <td className={clsx(TD, 'text-right')}>
        <NumberCell
          editing={editing} value={row.unitPrice}
          derived={row.derivedField === 'unitPrice'} nonNegative fine
          display={asNumber(row.unitPrice) == null ? '—' : perPiece(asNumber(row.unitPrice)!)}
          onChange={(v) => onEditNumber(row.key, 'unitPrice', v)}
        />
      </td>
      <td className={clsx(TD, 'text-right')}>
        <NumberCell
          editing={editing} value={row.cost}
          derived={row.derivedField === 'cost'} nonNegative
          display={cost == null ? '—' : fmtMoney(cost)}
          onChange={(v) => onEditNumber(row.key, 'cost', v)}
        />
      </td>
      <td className={clsx(TD, 'tnum pr-4 text-right')}>
        {countedIn
          ? <span className="text-2xs text-ink-400" title={`Counted in the ${countedIn} row`}>in {countedIn}</span>
          : pctCell(pctOf(cost, total))}
      </td>
      {editing && (
        <td className={clsx(TDX, 'text-right')}>
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

/**
 * "bom:FABRIC:<row id>" → "the bill of materials · fabric". Only the first two
 * segments are read: the row id is for matching, not for people.
 */
function explain(ref: string): string {
  const [section, detail] = ref.split(':');
  const name = section === 'bom' ? 'the bill of materials'
    : section === 'external' ? 'outside work'
    : section === 'production' ? 'the production follow-up'
    : section;
  const tail = (detail ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  return tail ? `${name} · ${tail}` : name;
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
  label, cost, total, editing, hidden, value, onChange,
}: {
  label: string; cost: number | null; total: number | null;
  editing: boolean; hidden?: boolean; value: string; onChange: (v: string) => void;
}) {
  return (
    <tr className={foldClass(hidden)}>
      <td className={clsx(TD, 'pl-4 text-ink-800')}>
        {label}
        {value.trim() === '' && cost != null && (
          <span className="ml-2 text-2xs text-ink-400">from outside work</span>
        )}
      </td>
      <td className={TD} colSpan={4} />
      <td className={clsx(TD, 'text-right')}>
        <NumberCell
          editing={editing} value={value} nonNegative
          display={cost == null ? '—' : fmtMoney(cost)}
          placeholder={cost == null ? '' : editableText(cost, 'money')}
          onChange={onChange}
        />
      </td>
      <td className={clsx(TD, 'tnum pr-4 text-right')}>{pctCell(pctOf(cost, total))}</td>
      {editing && <td className={TDX} />}
    </tr>
  );
}

/**
 * What is missing, and where it is entered — the foot of the result panel.
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
  const missing = ['sellPriceUsd', 'shippedQty', 'machineCostPerDay', 'workDays', 'totalCostUsd']
    .map((k) => live.waiting[k])
    .filter((m): m is string => !!m && !seen.has(m) && (seen.add(m), true));

  // A profit figure with parts of the cost unknown: the engine gives no
  // verdict on it, and this says why.
  const incomplete = live.isProfitable == null && live.profitPerUnitUsd != null ? live.incomplete : [];

  if (missing.length === 0 && incomplete.length === 0) return null;
  return (
    <div className="no-print space-y-1.5 border-t border-white/10 bg-white/[0.03] px-5 py-3 text-xs text-ink-300">
      {missing.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium text-amber-300">Not calculated yet.</span>
          <span>Record what is missing, or type the figure straight into its field:</span>
          {missing.map((m) => (
            <span key={m} className="rounded bg-white/10 px-1.5 py-0.5 text-2xs text-amber-100">{m}</span>
          ))}
        </div>
      )}
      {incomplete.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium text-amber-300">Not complete yet:</span>
          {incomplete.map((m) => (
            <span key={m} className="rounded bg-white/10 px-1.5 py-0.5 text-2xs text-amber-100">{m}</span>
          ))}
          <span>— no verdict on the profit until these are in.</span>
        </div>
      )}
    </div>
  );
}
