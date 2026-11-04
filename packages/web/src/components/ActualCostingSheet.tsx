/**
 * Actual Costing — `Actual Costing_Coordinator` from the workbook.
 *
 * Every field, every grouping and every calculation is the sheet's; the look is
 * OpsFlow's. The coordinators reading this have the workbook's order of fields
 * in their heads — identity, then the machine figures, then the money, then the
 * two rows of production quantities, then the costing table with UsedFabric
 * above UsedAcc — and the breakdown keeps that order, one kind of cost per
 * tab, with the C.M's machine figures in the tab of the C.M they make. Beside
 * it, a summary that stays in view: the profit on one piece, what the cost is
 * made of, and the cost against the price. What is not kept is Excel's black
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
import { Check, Cloud, CloudOff, Download, Lock, Pencil, Plus, Printer, RotateCcw, Trash2 } from 'lucide-react';
import {
  computeCosting, rowCost, applyRowEdit, sanitiseOverrides, visibleDerivedLines, outsideWorkKind, editableText, sourceRefCovers,
  bomRefItemId,
  fmtMoney, fmtNumber, fmtPct, formatCell, isTypeableNumber, NOT_CALCULATED,
  type CostLineInput, type CostingResult, type OrderDetailDto,
  type OverrideKey, type RowField,
} from '@opsflow/shared';
import { api, ApiError, type CostLineDto, type CostingDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  CostCell, CostField, NumberCell, StoredField, TextCell,
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

/** Empty means "nobody has said", which is not the same as zero. */
const asNumber = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

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
  const editable = mayWrite && costing.isSuccess;
  const toast = useToast();

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
  useEffect(() => {
    const [, s, o, r, h, version] = JSON.parse(serverState) as
      [string, Stored, Record<string, string>, RowDraft[], string[], string | null];
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
    // The draft is now the server's copy, so its version is the server's too.
    // Not before: a draft kept over a newer copy must still name the old one,
    // so its save is refused instead of overwriting the newer copy.
    versionRef.current = version;
    // A count that is not a whole number was never sent, so the server's copy
    // still holds the old one. Keep what was typed on screen, marked, rather
    // than silently putting the old figure back under the person's cursor.
    setStored((prev) => {
      const next = { ...s };
      for (const k of WHOLE_FIELDS) if (asWhole(prev[k]) === undefined) next[k] = prev[k];
      return next;
    });
    setOver(o); setRows(r); setHidden(h);
  }, [serverState]);

  /** The draft, as one comparable string. Changing it is what "unsaved" means. */
  const current = JSON.stringify([stored, over, rows, hidden]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const dirty = baseline !== '' && current !== baseline;

  const save = useMutation({
    mutationFn: () => api.steps.saveCosting(order.id, {
      costingDate: stored.costingDate || null,
      dailyCostUsd: asNumber(stored.dailyCostUsd),
      // Undefined — a count that is not a whole number — is dropped from the
      // request, so the rest of the draft still saves.
      machineCount: asWhole(stored.machineCount),
      lineMachineQty: asWhole(stored.lineMachineQty),
      daysInLine: asWhole(stored.daysInLine),
      machineDaysUsed: asWhole(stored.machineDaysUsed),
      sublimationCostUsd: asNumber(stored.sublimationCostUsd),
      embroideryCostUsd: asNumber(stored.embroideryCostUsd),
      notes: stored.notes || null,
      overrides: over,
      hiddenCostRefs: hidden,
      expectedUpdatedAt: versionRef.current,
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
    dailyCostUsd: asNumber(stored.dailyCostUsd),
    // Only what would be saved, so the figures on screen are the ones stored.
    machineCount: asWhole(stored.machineCount) ?? null,
    machineDaysUsed: asWhole(stored.machineDaysUsed) ?? null,
    daysInLine: asWhole(stored.daysInLine) ?? null,
    lineMachineQty: asWhole(stored.lineMachineQty) ?? null,
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

  /** Which kind of cost is open in the breakdown. Every one prints; only this one shows. */
  const [tab, setTab] = useState<CostTab>('fabric');
  const breakdownRef = useRef<HTMLDivElement>(null);
  const openTab = (k: CostTab) => {
    setTab(k);
    breakdownRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /** The cost, split the way the engine adds it up. Shares are of the parts' own sum, so they always close to 100%. */
  const parts: { key: string; tab: CostTab; name: string; cost: number | null; swatch: string }[] = [
    { key: 'fabric', tab: 'fabric', name: 'Fabric', cost: live.fabricCostUsd, swatch: 'bg-accent-600' },
    { key: 'accessory', tab: 'accessory', name: 'Accessories', cost: live.accessoryCostUsd, swatch: 'bg-accent-300' },
    { key: 'external', tab: 'external', name: 'Outside work', cost: live.externalCostUsd, swatch: 'bg-ink-400' },
    { key: 'cm', tab: 'cm', name: 'Cut & make', cost: live.cmCostUsd, swatch: 'bg-ink-700' },
    ...(live.otherCostUsd != null ? [{ key: 'other', tab: 'external' as CostTab, name: 'Other', cost: live.otherCostUsd, swatch: 'bg-ink-200' }] : []),
  ];
  const partsSum = parts.reduce((a, p) => a + (p.cost ?? 0), 0);

  const tabs: { key: CostTab; name: string; cost: number | null; count: number }[] = [
    { key: 'fabric', name: 'Fabric', cost: live.fabricCostUsd, count: fabricRows.length },
    { key: 'accessory', name: 'Accessories', cost: live.accessoryCostUsd, count: accessoryRows.length },
    { key: 'external', name: 'Outside work', cost: live.externalCostUsd, count: 2 + otherRows.length },
    { key: 'cm', name: 'Cut & make', cost: live.cmCostUsd, count: 1 },
  ];

  // Cost per unit against the sell price, as a bar: "did we make money"
  // without a number being read.
  const costRatio = live.unitActualCostUsd != null && live.sellPriceUsd ? live.unitActualCostUsd / live.sellPriceUsd : null;
  const profitTone = live.isProfitable === true ? 'text-emerald-700' : live.isProfitable === false ? 'text-red-700' : 'text-ink-900';
  const identity = [live.identity.customer, live.identity.poNumber && `PO ${live.identity.poNumber}`, live.identity.styleNumber && `Style ${live.identity.styleNumber}`]
    .filter(Boolean).join(' · ');

  /** One of the order's facts, label over value. */
  const fact = (
    label: string, key: OverrideKey, calculated: number | string | null,
    kind: 'percent' | 'number' | 'text', note?: string,
  ) => (
    <Fact
      label={label} editing={editing} kind={kind} note={note}
      value={over[key] ?? ''} calculated={calc(key, calculated)} waiting={live.waiting[key]}
      onChange={setOverride(key)} onRevert={revert(key)}
    />
  );

  /** The costing table of one tab: the same seven columns everywhere, its own total at the foot. */
  const costTable = (body: ReactNode, totalLabel: string, subtotal: ReactNode, share: ReactNode) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem]">
        <thead className="border-b border-ink-200 bg-ink-50/60">
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
        <tbody className="[&>tr]:border-t [&>tr]:border-ink-100 [&>tr:first-child]:border-t-0">
          {body}
          <tr className="!border-t !border-ink-200 bg-ink-50/60">
            <td className={clsx(TD, 'pl-4 font-semibold text-ink-900')} colSpan={5}>{totalLabel}</td>
            <td className={clsx(TD, 'text-right font-semibold')}>{subtotal}</td>
            <td className={clsx(TD, 'tnum pr-4 text-right font-semibold text-ink-900')}>{share}</td>
            {editing && <td className={TDX} />}
          </tr>
        </tbody>
      </table>
    </div>
  );

  /** A tab's panel. The open one shows; all of them print, each under its name. */
  const panel = (k: CostTab, name: string, children: ReactNode) => (
    <div className={clsx(tab !== k && 'hidden print:block')}>
      <p className="hidden border-b border-ink-200 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-ink-700 print:block">{name}</p>
      {children}
    </div>
  );

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
          {identity && <span className="truncate text-xs text-ink-500">{identity}</span>}
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

      {/* Two columns: the working on the left, the result on the right. The
          summary stays in view while the rows are scrolled and edited, so the
          effect of every figure typed is seen where it lands. On a narrower
          screen it comes first, above the working. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-4">
          {/* ── The order ─────────────────────────────────────────────── */}
          <Card className="overflow-hidden">
            <CardHeader title="Order" subtitle="Read from the order and its ledgers." />
            <div className="grid grid-cols-2 gap-px bg-ink-100 sm:grid-cols-3 [&>*]:bg-white">
              {fact('Customer', 'customer', live.source.customer, 'text')}
              {fact('Order name', 'orderName', live.source.orderName, 'text')}
              {fact('PO no', 'poNumber', live.source.poNumber, 'text')}
              {fact('Style no', 'styleNumber', live.source.styleNumber, 'text')}
              {fact('Item type', 'itemType', live.source.itemType, 'text')}
              <DateFact editing={editing} value={stored.costingDate} onChange={setField('costingDate')} />
            </div>
            <div className="border-t border-ink-200 bg-ink-50/60 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500">
              Pieces
            </div>
            <div className="grid grid-cols-2 gap-px border-t border-ink-100 bg-ink-100 sm:grid-cols-3 [&>*]:bg-white">
              {fact('Ordered', 'orderQty', live.source.orderQty, 'number', 'from the order ledger')}
              {fact('Cut', 'cutQty', live.source.cutQty, 'number', live.source.cutQtySource === 'recorded' ? 'from the cutting records' : 'from the cut order')}
              {fact('1st degree', 'firstDegreeQty', live.source.firstDegreeQty, 'number', 'from the out-line ledger')}
              {fact('2nd degree', 'secondDegreeQty', live.source.secondDegreeQty, 'number', 'from the 2nd-degree ledger')}
              {fact('Shipped', 'shippedQty', live.source.shippedQty, 'number', 'from the shipped ledger')}
              {fact('Diff.', 'diffPct', live.diffPct, 'percent', 'shipped against ordered')}
            </div>
          </Card>

          {/* ── The breakdown ─────────────────────────────────────────────
              One kind of cost at a time, in the workbook's order. Each tab
              carries its own total, so the four figures can be compared
              without opening any of them. */}
          <div ref={breakdownRef} className="scroll-mt-4">
            <Card className="overflow-hidden">
              <CardHeader
                title="Cost breakdown"
                subtitle="Materials from the bill of materials, outside work from the External Order section."
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
              <div role="tablist" className="no-print grid grid-cols-2 border-b border-ink-200 sm:grid-cols-4">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={clsx(
                      '-mb-px border-b-2 px-4 py-2.5 text-left transition-colors',
                      tab === t.key ? 'border-accent-600 bg-white' : 'border-transparent bg-ink-50/60 hover:bg-ink-50',
                    )}
                  >
                    <span className={clsx('block text-xs font-semibold', tab === t.key ? 'text-accent-700' : 'text-ink-600')}>
                      {t.name}
                      <span className="ml-1.5 font-normal text-ink-400">{t.count}</span>
                    </span>
                    <span className={clsx('tnum block text-sm font-semibold', t.cost == null ? 'text-ink-300' : 'text-ink-900')}>
                      {t.cost == null ? '—' : fmtMoney(t.cost)}
                    </span>
                  </button>
                ))}
              </div>

              {panel('fabric', 'Fabric', costTable(
                <RowBlock
                  rows={fabricRows} total={total} editing={editing} cols={cols}
                  onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow}
                  onAdd={() => addRow('FABRIC')} addLabel="Add a fabric row" rowCost={costOf}
                  emptyText="No fabric on the bill of materials yet"
                />,
                'Fabric total',
                <CostCell
                  editing={editing} value={over.fabricCostUsd ?? ''} calculated={live.groups.fabric.total} kind="money"
                  className="font-semibold" onChange={setOverride('fabricCostUsd')} onRevert={revert('fabricCostUsd')}
                />,
                pctCell(pctOf(liveFabric, total)),
              ))}

              {panel('accessory', 'Accessories', costTable(
                <RowBlock
                  rows={accessoryRows} total={total} editing={editing} cols={cols}
                  onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow}
                  onAdd={() => addRow('ACCESSORY')} addLabel="Add an accessory row" rowCost={costOf}
                  emptyText="No accessories on the bill of materials yet"
                />,
                'Accessories total',
                <CostCell
                  editing={editing} value={over.accessoryCostUsd ?? ''} calculated={live.groups.accessory.total} kind="money"
                  className="font-semibold" onChange={setOverride('accessoryCostUsd')} onRevert={revert('accessoryCostUsd')}
                />,
                pctCell(pctOf(liveAccessory, total)),
              ))}

              {panel('external', 'Outside work', costTable(
                <>
                  <OutsideRow
                    label="Sublimation" cost={live.sublimationCostUsd} total={total} editing={editing}
                    value={stored.sublimationCostUsd} onChange={setField('sublimationCostUsd')}
                  />
                  <OutsideRow
                    label="Embroidery" cost={live.embroideryCostUsd} total={total} editing={editing}
                    value={stored.embroideryCostUsd} onChange={setField('embroideryCostUsd')}
                  />
                  {otherRows.map((r) => {
                    const kind = kindOf(r);
                    return (
                      <EditableRow
                        key={r.key} row={r} total={total} editing={editing}
                        onEdit={editRow} onEditNumber={editRowNumber} onDelete={deleteRow} cost={costOf(r)}
                        countedIn={kind === 'SUBLIMATION' ? 'Sublimation' : kind === 'EMBROIDERY' ? 'Embroidery' : undefined}
                      />
                    );
                  })}
                  {editing && <AddRow cols={cols} label="Add an outside-work or other cost" onAdd={() => addRow('EXTERNAL')} />}
                </>,
                'Outside work total',
                <span className="tnum text-ink-900">{live.externalCostUsd == null ? '—' : fmtMoney(live.externalCostUsd)}</span>,
                pctCell(pctOf(live.externalCostUsd, total)),
              ))}

              {/* C.M — the factory's formula: machine cost × machine-days ÷
                  productivity rate, charged against the pieces that passed
                  end-line inspection. Its inputs sit in this tab, next to
                  the figure they make. */}
              {panel('cm', 'Cut & make', (
                <>
                  <div className="grid md:grid-cols-2 md:divide-x md:divide-ink-100">
                    <div>
                      <Band>
                        Entered here
                        <span className="ml-2 font-normal normal-case tracking-normal text-ink-400">blank takes OpsFlow's own figure</span>
                      </Band>
                      <div className="divide-y divide-ink-100">
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
                    </div>
                    <div className="border-t border-ink-100 md:border-t-0">
                      <Band>Worked out</Band>
                      <div className="divide-y divide-ink-100">
                        {field('Machine cost', 'machineCostPerDay', live.machineCostPerDay, 'money', {
                          places: 2, hint: 'daily cost ÷ all machines',
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
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-px border-t border-ink-200 bg-ink-100 sm:grid-cols-4 [&>*]:bg-ink-50/60">
                    <Figure label="Pieces passed" value={live.firstDegreeQty == null ? null : fmtNumber(live.firstDegreeQty)} note="1st degree" />
                    <Figure label="C.M per piece" value={cmPerPiece == null ? null : perPiece(cmPerPiece)} note="C.M ÷ pieces passed" />
                    <div className="px-4 py-3">
                      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">C.M total</p>
                      <div className="mt-1 text-sm font-semibold">
                        <CostCell
                          editing={editing} value={over.cmCostUsd ?? ''} calculated={live.cmCostUsd}
                          kind="money" onChange={setOverride('cmCostUsd')} onRevert={revert('cmCostUsd')}
                        />
                      </div>
                      <p className="mt-0.5 text-2xs text-ink-400">machine cost × machine-days ÷ rate</p>
                    </div>
                    <Figure label="Share of cost" value={(() => { const p = pctOf(live.cmCostUsd, total); return p == null || !Number.isFinite(p) ? null : fmtPct(p, 2); })()} note="of the total cost" />
                  </div>
                </>
              ))}
            </Card>
          </div>

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
        </div>

        {/* ── The result ────────────────────────────────────────────────
            Read top to bottom like a receipt: the answer, what the cost is
            made of, and the cost against the price. A line of the cost opens
            its tab in the breakdown. */}
        <aside className="order-first space-y-4 xl:sticky xl:top-4 xl:order-last">
          <Card className="overflow-hidden">
            <div className="border-b border-ink-200 px-4 py-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">Profit per piece</p>
                <span className={clsx(
                  'chip',
                  live.isProfitable === true && 'bg-emerald-50 text-emerald-700 ring-emerald-200',
                  live.isProfitable === false && 'bg-red-50 text-red-700 ring-red-200',
                  live.isProfitable == null && 'bg-ink-50 text-ink-500 ring-ink-200',
                )}>
                  {live.isProfitable === true ? 'In profit' : live.isProfitable === false ? 'At a loss' : 'Not calculated yet'}
                </span>
              </div>
              {editing ? (
                <div className="mt-2 inline-block">
                  <CostCell
                    editing value={over.profitPerUnitUsd ?? ''} calculated={calc('profitPerUnitUsd', live.profitPerUnitUsd)}
                    kind="money" onChange={setOverride('profitPerUnitUsd')} onRevert={revert('profitPerUnitUsd')}
                  />
                </div>
              ) : (
                <p className={clsx(
                  'tnum mt-1 text-3xl font-semibold leading-tight tracking-tight',
                  over.profitPerUnitUsd != null ? 'text-violet-800' : live.profitPerUnitUsd == null ? 'text-ink-300' : profitTone,
                )}>
                  {over.profitPerUnitUsd != null
                    ? formatCell(Number(over.profitPerUnitUsd), 'money')
                    : live.profitPerUnitUsd == null ? '—' : formatCell(live.profitPerUnitUsd, 'money')}
                </p>
              )}
              <p className="mt-1 text-2xs text-ink-400">
                {over.profitPerUnitUsd != null
                  ? <span className="text-violet-600">typed · calculated {formatCell(calc('profitPerUnitUsd', live.profitPerUnitUsd), 'money')}</span>
                  : live.totalProfitUsd != null && live.shippedQty != null
                    ? `${fmtMoney(live.totalProfitUsd)} in all, on ${fmtNumber(live.shippedQty)} pieces shipped`
                    : live.waiting.profitPerUnitUsd ?? 'sell price − cost per unit'}
              </p>
            </div>

            <div className="grid sm:grid-cols-2 sm:divide-x sm:divide-ink-100 xl:grid-cols-1 xl:divide-x-0">
              <div>
                <Band>What it cost</Band>
                <div className="px-4 pt-3" aria-hidden>
                  <div className="flex h-2 overflow-hidden rounded-full bg-ink-100">
                    {partsSum > 0 && parts.map((p) => p.cost ? (
                      <div key={p.key} className={p.swatch} style={{ width: `${(p.cost / partsSum) * 100}%` }} />
                    ) : null)}
                  </div>
                </div>
                <ul className="py-1">
                  {parts.map((p) => (
                    <li key={p.key}>
                      <button
                        type="button"
                        onClick={() => openTab(p.tab)}
                        title={`Show the ${p.name.toLowerCase()} rows`}
                        className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm hover:bg-ink-50"
                      >
                        <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-sm', p.swatch)} />
                        <span className="min-w-0 flex-1 truncate text-ink-700">{p.name}</span>
                        <span className="tnum w-12 text-right text-2xs text-ink-400">
                          {p.cost != null && partsSum > 0 ? fmtPct((p.cost / partsSum) * 100, 1) : ''}
                        </span>
                        <span className={clsx('tnum w-24 text-right', p.cost == null ? 'text-ink-300' : 'text-ink-900')}>
                          {p.cost == null ? '—' : fmtMoney(p.cost)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-ink-200">
                  {field('Total cost', 'totalCostUsd', live.totalCostUsd, 'money', { hint: 'every cost row, added up' })}
                </div>
              </div>

              <div className="border-t border-ink-200 sm:border-t-0 xl:border-t">
                <Band>Against the price</Band>
                <div className="divide-y divide-ink-100">
                  {field('Cost per piece', 'unitActualCostUsd', live.unitActualCostUsd, 'money', { hint: 'total cost ÷ shipped' })}
                  {field('Sell price', 'sellPriceUsd', live.source.sellPriceUsd, 'money', { from: 'Order Details' })}
                  {field('Profit %', 'profitPct', live.profitPct, 'percent', { hint: 'profit ÷ sell price' })}
                  {field('Perfect price', 'targetPriceUsd', live.targetPriceUsd, 'money', {
                    hint: live.isProfitable === true && over.targetPriceUsd == null ? 'nothing to fix at this price' : 'cost per piece + 20% mark-up',
                  })}
                </div>
                {costRatio != null && (
                  <div className="border-t border-ink-100 px-4 py-3">
                    <div className="flex h-2 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className={clsx('h-full rounded-full', costRatio > 1 ? 'bg-red-500' : 'bg-emerald-500')}
                        style={{ width: `${Math.min(costRatio, 1) * 100}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-2xs text-ink-500">
                      {costRatio > 1
                        ? <span className="text-red-700">Cost is {fmtPct((costRatio - 1) * 100, 1)} above the sell price</span>
                        : <>Cost is {fmtPct(costRatio * 100, 1)} of the sell price</>}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <MissingNotes live={live} />
          </Card>
        </aside>
      </div>
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

/** A thin caption across a card, splitting one group of rows from the next. */
function Band({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('border-b border-ink-100 bg-ink-50/70 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500', className)}>
      {children}
    </div>
  );
}

/** The four kinds of cost the breakdown shows one at a time. */
type CostTab = 'fabric' | 'accessory' | 'external' | 'cm';

/**
 * One fact of the order, label over value, typeable like every other figure
 * on the sheet: the same violet marking once typed, and the same way back to
 * the figure OpsFlow read.
 */
function Fact({
  label, editing, value, calculated, kind, note, waiting, onChange, onRevert,
}: {
  label: string;
  editing: boolean;
  value: string;
  calculated: number | string | null;
  kind: 'percent' | 'number' | 'text';
  note?: string;
  waiting?: string;
  onChange: (v: string) => void;
  onRevert: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const overridden = value.trim() !== '';
  const unknown = !overridden && calculated == null;
  const shown = overridden ? formatCell(kind === 'text' ? value : Number(value), kind) : formatCell(calculated, kind);
  const calcText = formatCell(calculated, kind);
  const under = overridden ? { text: calculated == null ? 'typed' : `typed · was ${calcText}`, tone: 'text-violet-600' }
    : unknown && waiting ? { text: waiting, tone: 'text-amber-700' }
    : note ? { text: note, tone: 'text-ink-400' }
    : null;
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      {editing ? (
        <div className="relative mt-1">
          <input
            type="text"
            inputMode={kind === 'text' ? 'text' : 'decimal'}
            className={clsx('input px-2 py-1', kind !== 'text' && 'tnum',
              !overridden && 'border-dashed border-ink-200 bg-ink-50/60',
              overridden && 'border-violet-400 bg-violet-50 pr-7 text-violet-900')}
            value={value !== '' ? value : focused ? '' : editableText(calculated, kind)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={unknown ? '—' : ''}
            onChange={(e) => {
              const next = e.target.value;
              if (kind !== 'text' && !isTypeableNumber(next)) return;
              onChange(next);
            }}
          />
          {overridden && (
            <button
              type="button"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-violet-600 hover:bg-violet-100"
              title={`Put back the figure OpsFlow read — ${calcText}`}
              aria-label={`Revert to ${calcText}`}
              onClick={onRevert}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      ) : (
        <p
          className={clsx(
            'mt-0.5 truncate text-sm font-semibold', kind !== 'text' && 'tnum',
            overridden ? 'text-violet-800' : unknown ? 'text-ink-300' : 'text-ink-900',
          )}
          title={unknown ? NOT_CALCULATED : shown}
        >
          {unknown ? '—' : shown}
        </p>
      )}
      {under && <p className={clsx('mt-0.5 truncate text-2xs', under.tone)} title={under.text}>{under.text}</p>}
    </div>
  );
}

/** The costing's own date, in the same shape as the order's facts. */
function DateFact({ editing, value, onChange }: { editing: boolean; value: string; onChange: (v: string) => void }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-2xs font-semibold uppercase tracking-wider text-ink-500">Costing date</p>
      {editing ? (
        <input type="date" className="input mt-1 px-2 py-1" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <p className={clsx('tnum mt-0.5 text-sm font-semibold', value ? 'text-ink-900' : 'text-ink-300')}>{value || '—'}</p>
      )}
      <p className="mt-0.5 truncate text-2xs text-ink-400">the day it was made</p>
    </div>
  );
}

/** A worked-out figure, for reading only. */
function Figure({ label, value, note }: { label: string; value: string | null; note?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={clsx('tnum mt-1 text-sm font-semibold', value == null ? 'text-ink-300' : 'text-ink-900')}>{value ?? '—'}</p>
      {note && <p className="mt-0.5 truncate text-2xs text-ink-400">{note}</p>}
    </div>
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
    <tr className={clsx(edited && 'bg-violet-50/40', foldClass(hidden))}>
      <td className={clsx(TD, 'pl-4')} title={origin}>
        <TextCell
          editing={editing} value={row.label} placeholder="Item"
          onChange={(v) => onEdit(row.key, { label: v })}
        />
        {!editing && edited && <span className="ml-2 text-2xs text-violet-600">edited</span>}
      </td>
      <td className={clsx(TD, 'tnum text-right text-2xs text-ink-400')}>
        {row.estimatedQty == null ? '—' : fmtNumber(row.estimatedQty, { places: 2 })}
      </td>
      <td className={clsx(TD, 'text-right')}>
        <NumberCell
          editing={editing} value={row.quantity}
          derived={row.derivedField === 'quantity'}
          display={row.quantity === '' ? '—' : fmtNumber(Number(row.quantity), { places: 2 })}
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
          derived={row.derivedField === 'unitPrice'}
          display={row.unitPrice === '' ? '—' : fmtMoney(Number(row.unitPrice))}
          onChange={(v) => onEditNumber(row.key, 'unitPrice', v)}
        />
      </td>
      <td className={clsx(TD, 'text-right')}>
        <NumberCell
          editing={editing} value={row.cost}
          derived={row.derivedField === 'cost'}
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
          editing={editing} value={value}
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
 * What is missing, and where it is entered — the foot of the summary.
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

  if (missing.length === 0) return null;
  return (
    <div className="no-print flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
      <span className="font-semibold">Not calculated yet.</span>
      <span>Record what is missing, or type the figure straight into its field:</span>
      {missing.map((m) => (
        <span key={m} className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs text-amber-800">{m}</span>
      ))}
    </div>
  );
}
