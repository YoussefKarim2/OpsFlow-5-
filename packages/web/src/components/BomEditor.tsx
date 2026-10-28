/**
 * Manual entry for the bill of materials.
 *
 * Sits beside the shortage view rather than replacing it: importing a workbook
 * still fills the BOM, and this is how a coordinator corrects what came in or
 * enters a sheet the importer could not read. The whole table is edited and
 * saved once, which is the Proforma Invoice's pattern and is kept deliberately
 * — somebody adds three items and fixes a fourth before pressing Save, and four
 * separate requests would leave the BOM half-updated if the third failed.
 *
 * The type dropdown is reference data from `/lookups`, not a hardcoded list, so
 * the factory can add a trim without a deploy. The item name stays free text
 * beside it, so an item nobody has listed is still enterable — the dropdown
 * classifies, it does not restrict.
 */

import { Fragment, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Rows3, Scissors } from 'lucide-react';
import {
  isTypeableNumber, BOM_DEPARTMENTS, BOM_UNITS, bomItemsFor, bomDepartmentOf, bomCategoryFor, bomItemName, sizeRowsFromCut,
  type BomDepartment, type CutSize,
} from '@opsflow/shared';
import { api, ApiError, type BomRowDto } from '../lib/api';
import { Num, clsx } from './ui';
import { ComboSelect } from './ComboSelect';

/** The value of the item dropdown's "type it yourself" entry. */
const OTHER_ITEM = '__other__';

/** Columns in the table: Dep., Item, Position, Description, Colour, Cons./pc, Quantity, Issued, Unit, Unit price, Total, Supplier, actions. */
const COLUMNS = 13;

/**
 * A row while it is being edited.
 *
 * The numbers are held as the text typed, and parsed only when saved. Storing
 * `Number(text)` on every keystroke turned "0." into 0 and made 0.35 or 12.5
 * impossible to type at all.
 */
interface RowDraft extends Omit<BomRowDto, 'requiredQty' | 'issuedQty' | 'unitPriceUsd' | 'consumptionPerPiece' | 'sizes'> {
  requiredQty: string;
  issuedQty: string;
  unitPriceUsd: string;
  consumptionPerPiece: string;
  sizes: Array<{ id?: string; sizeLabel: string; qty: string }>;
  /** The issued figure as the editor was opened with it. See `issuedChanged`. */
  issuedWas: string;
  /**
   * "Item Sort / Dep." as the template has it: Fabric, Yoko, Press, Production
   * or Packing. Picks the item list; the stored category follows from it.
   */
  department: BomDepartment | null;
  /** The item is typed rather than picked from the department's list. */
  typed: boolean;
  /**
   * A key for the row while it is on screen. Keyed by index, removing a row
   * in the middle handed its open breakdown and its half-typed dropdowns to
   * the row that slid into its place.
   */
  uid: number;
}

let nextUid = 1;
const text = (v: number | null | undefined): string => (v == null ? '' : String(v));

/** Blank is "nobody has said"; anything else must be a real number. */
const parse = (t: string): number | null => {
  const s = t.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Typed, but not something a number can be read from — "." or "-" alone. */
const unreadable = (t: string): boolean => t.trim() !== '' && parse(t) == null;

/** The items a department offers: the template's list, or for Fabric the factory's fabric list. */
type ItemsFor = (department: BomDepartment | null) => readonly string[];

const inList = (itemsFor: ItemsFor, department: BomDepartment | null, item: string) =>
  itemsFor(department).some((x) => x.toLowerCase() === item.trim().toLowerCase());

const toDraft = (r: BomRowDto, itemsFor: ItemsFor = bomItemsFor): RowDraft => {
  const department = bomDepartmentOf(r.item, r.category);
  return {
  ...r,
  uid: nextUid++,
  department,
  typed: itemsFor(department).length === 0 || (r.item.trim() !== '' && !inList(itemsFor, department, r.item)),
  requiredQty: r.requiredQty ? String(r.requiredQty) : '',
  issuedQty: text(r.issuedQty),
  unitPriceUsd: text(r.unitPriceUsd),
  consumptionPerPiece: text(r.consumptionPerPiece),
  sizes: r.sizes.map((z) => ({ id: z.id, sizeLabel: z.sizeLabel, qty: z.qty ? String(z.qty) : '' })),
  issuedWas: text(r.issuedQty),
  };
};

const blankRow = (): RowDraft => toDraft({
  category: 'OTHER', item: '', position: null, description: null, colorText: null, consumptionPerPiece: null,
  unit: 'Pcs', requiredQty: 0, issuedQty: null, unitPriceUsd: null, supplier: null, notes: null, sizes: [],
});

/** A row's quantity is the sum of its sizes once any exist. */
export function rowQty(r: RowDraft): number {
  return r.sizes.length > 0
    ? r.sizes.reduce((a, s) => a + (parse(s.qty) ?? 0), 0)
    : parse(r.requiredQty) ?? 0;
}

/**
 * Whether the person changed the issued figure in this editor.
 *
 * The editor opens on whatever the bill of materials said when it was loaded,
 * and the server treats a different issued figure as a correction and writes
 * the difference to the issue log. Sent for every row, an editor left open
 * while the warehouse issued stock would quietly reverse that issue on save.
 * So it is sent only for a row whose figure was actually edited; the others
 * leave the issued quantity to the warehouse.
 */
const issuedChanged = (r: RowDraft): boolean => parse(r.issuedQty) !== parse(r.issuedWas);

/** The row as the server takes it. */
function fromDraft(d: RowDraft): BomRowDto {
  const { issuedWas: _was, department, typed: _typed, uid: _uid, ...r } = d;
  return {
    ...r,
    // "Collar" typed under Yoko is stored as "Yoko Collar", which is what
    // brings it back under Yoko rather than Fabric.
    item: bomItemName(department, r.item),
    requiredQty: rowQty(d),
    // Null is "unchanged" to the server, which leaves the issued figure alone.
    issuedQty: issuedChanged(d) ? parse(d.issuedQty) : null,
    unitPriceUsd: parse(d.unitPriceUsd),
    consumptionPerPiece: parse(d.consumptionPerPiece),
    position: d.position?.trim() || null,
    description: d.description?.trim() || null,
    sizes: d.sizes.map((z) => ({ id: z.id, sizeLabel: z.sizeLabel.trim(), qty: parse(z.qty) ?? 0 })),
  };
}

export function BomEditor({
  orderId, initial, itemTypes, fabrics = [], colors = [], units = [], sizes = [], sizeLabels = [], canIssue = false, onSaved,
}: {
  orderId: string;
  initial: BomRowDto[];
  /**
   * Whether this person may issue material. Typing an issued figure is an
   * issue — stock leaves the shelf — so without it the column is shown, not
   * edited, and the server refuses the figure anyway.
   */
  canIssue?: boolean;
  /** `RefValue` rows of kind BOM_ITEM_TYPE, from /lookups. */
  itemTypes: string[];
  /** The factory's fabric list (`RefValue` kind FABRIC), offered under Fabric. */
  fabrics?: string[];
  /** The factory's colour list, for the colour column. */
  colors?: string[];
  /** Units of measure — Met., Pcs, Kg. — for the unit column. */
  units?: string[];
  /** The order's sizes with the cut order's pieces in each: what the breakdown is filled from. */
  sizes?: CutSize[];
  /** The factory's size list, offered when the order has no sizes of its own yet. */
  sizeLabels?: string[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const itemsFor: ItemsFor = (d) => (d === 'Fabric' ? fabrics : bomItemsFor(d));
  const [rows, setRows] = useState<RowDraft[]>(() => initial.map((r) => toDraft(r, itemsFor)));
  /** The `uid` of the row whose breakdown is open. */
  const [expanded, setExpanded] = useState<number | null>(null);
  /**
   * Saved lines removed in this editor. The server deletes exactly these and
   * nothing else, so a line someone added after this editor opened survives
   * the save instead of being taken for one this person removed.
   */
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.materials.saveBom(orderId, rows.map(fromDraft), removedIds),
    onSuccess: () => {
      setSaveError(null);
      setRemovedIds([]);
      void qc.invalidateQueries({ queryKey: ['bom', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      // The costing sheet and the workflow both read the bill of materials.
      void qc.invalidateQueries({ queryKey: ['costing', orderId] });
      void qc.invalidateQueries({ queryKey: ['order-steps', orderId] });
      // A corrected issued figure on a linked line moves stock, so the
      // Materials tab and the inventory screens are stale too.
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onSaved?.();
    },
    // Without this the mutation swallowed every failure: the button finished,
    // the screen stayed where it was, and the bill of materials was not saved.
    // A save that fails silently is worse than one that refuses loudly.
    onError: (e) => setSaveError(
      e instanceof ApiError ? e.message : 'Could not save the bill of materials.',
    ),
  });

  const setRow = (i: number, patch: Partial<RowDraft>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  /** Choosing a department narrows the item list, as the template's INDIRECT dropdown does. */
  const setDepartment = (i: number, department: BomDepartment | null) => {
    const r = rows[i]!;
    // An item not on the new department's list is kept as typed text rather
    // than cleared: "Collar" moved to Yoko is still a collar.
    const listed = department == null || itemsFor(department).length === 0 || inList(itemsFor, department, r.item);
    const item = r.item;
    setRow(i, {
      department,
      item,
      typed: department == null || itemsFor(department).length === 0 || (!listed && item.trim() !== ''),
      category: department ? bomCategoryFor(department, item) : r.category,
    });
  };
  const setItem = (i: number, item: string, typed: boolean) => {
    const r = rows[i]!;
    setRow(i, { item, typed, category: r.department ? bomCategoryFor(r.department, item) : r.category });
  };

  const setSize = (i: number, n: number, patch: Partial<RowDraft['sizes'][number]>) =>
    setRow(i, { sizes: rows[i]!.sizes.map((s, k) => (k === n ? { ...s, ...patch } : s)) });

  /**
   * The breakdown from the cut order: one row per size, its cut pieces times
   * the item's consumption per piece. The cut quantities are what the item
   * has to cover, so nobody retypes them from the cutting sheet.
   */
  const fillFromCut = (i: number) =>
    setRow(i, { sizes: sizeRowsFromCut(sizes, parse(rows[i]!.consumptionPerPiece)).map((z) => ({ sizeLabel: z.sizeLabel, qty: String(z.qty) })) });
  const cutGenerated = sizes.some((s) => s.cutQty > 0);
  const anyPieces = sizes.some((s) => s.cutQty > 0 || s.orderQty > 0);
  /** The size names offered on a breakdown row: the order's own, else the factory's list. */
  const sizeOptions = sizes.length > 0 ? sizes.map((s) => s.name) : sizeLabels;

  /** A numeric field's change: kept as typed, as long as it could become a number. */
  const numeric = (apply: (v: string) => void) =>
    (e: { target: { value: string } }) => { if (isTypeableNumber(e.target.value)) apply(e.target.value); };

  // An item with no name cannot be saved: the BOM is read by people picking
  // stock off a shelf, and a nameless line helps nobody. Nor can a figure that
  // is half a number — "." or "-" on its own.
  const unnamed = rows.some((r) => !r.item.trim());
  const halfTyped = rows.some((r) =>
    [r.requiredQty, r.issuedQty, r.unitPriceUsd, r.consumptionPerPiece, ...r.sizes.map((z) => z.qty)].some(unreadable));
  // A size row with no size would be refused by the server; better said here,
  // next to the button, than as a 422 after it was pressed.
  const unsized = rows.some((r) => r.sizes.some((z) => !z.sizeLabel.trim()));
  const invalid = unnamed || halfTyped || unsized;
  const why = unnamed ? 'Every item needs a name'
    : halfTyped ? 'Finish the number being typed'
    : unsized ? 'Every size row needs a size' : undefined;
  const total = rows.reduce((a, r) => a + rowQty(r) * (parse(r.unitPriceUsd) ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="label mb-0">Materials and accessories</span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setRows([...rows, blankRow()])}>
            <Plus className="h-3.5 w-3.5" /> Add an item
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={save.isPending || invalid}
            title={why}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* The save used to fail in silence. Now it says so, next to the button
            that did not do what it appeared to do. */}
        {saveError && (
          <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {saveError}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border border-ink-200">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th min-w-[9rem]" title="Item Sort / Dep. — picks the item list">Dep.</th>
              <th className="th min-w-[13rem]">Item</th>
              <th className="th min-w-[8rem]" title="Where it goes — Inside Top Back, Main fabric…">Position</th>
              <th className="th min-w-[12rem]">Description</th>
              <th className="th min-w-[9rem]">Colour</th>
              <th className="th w-24 text-right" title="Coms./Piece — what one garment uses">Cons./pc</th>
              <th className="th w-28 text-right">Quantity</th>
              <th className="th w-28 text-right">Issued</th>
              <th className="th min-w-[5.5rem]">Unit</th>
              <th className="th w-28 text-right">Unit price</th>
              <th className="th w-28 text-right">Total</th>
              <th className="th w-32">Supplier</th>
              <th className="th w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS} className="td py-6 text-center text-ink-500">
                  Nothing in the bill of materials yet. Import a document, or add an item.
                </td>
              </tr>
            ) : null}

            {rows.map((r, i) => (
              <Fragment key={r.uid}>
                <tr>
                  <td className="p-1">
                    <ComboSelect
                      aria-label="Department"
                      className={clsx('input border-transparent bg-transparent', !r.department && 'text-ink-400')}
                      value={r.department ?? ''}
                      onChange={(e) => setDepartment(i, (e.target.value || null) as BomDepartment | null)}
                    >
                      <option value="">Choose…</option>
                      {BOM_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </ComboSelect>
                  </td>
                  <td className="p-1">
                    {r.typed ? (
                      <div className="flex items-center gap-1">
                        <input
                          aria-label="Item"
                          className={clsx('input border-transparent bg-transparent', !r.item.trim() && 'ring-1 ring-red-400')}
                          value={r.item}
                          list={itemsFor(r.department).length > 0 ? `bom-items-${r.department}` : 'bom-item-types'}
                          placeholder={r.department === 'Yoko' ? 'Yoko collar, Yoko cuffs…' : r.department === 'Fabric' ? 'Main fabric, Rib…' : 'Type the item…'}
                          onChange={(e) => setItem(i, e.target.value, true)}
                        />
                        {itemsFor(r.department).length > 0 && (
                          <button type="button" className="shrink-0 text-2xs text-accent-700 hover:underline" title="Pick from the list"
                            onClick={() => setItem(i, '', false)}>List</button>
                        )}
                      </div>
                    ) : (
                      <ComboSelect
                        allowCustom
                        aria-label="Item"
                        className={clsx('input border-transparent bg-transparent', !r.item.trim() && 'ring-1 ring-red-400')}
                        value={r.item ? itemsFor(r.department).find((x) => x.toLowerCase() === r.item.trim().toLowerCase()) ?? r.item : ''}
                        onChange={(e) => (e.target.value === OTHER_ITEM ? setItem(i, '', true) : setItem(i, e.target.value, false))}
                      >
                        <option value="">Choose…</option>
                        {itemsFor(r.department).map((x) => <option key={x} value={x}>{x}</option>)}
                        <option value={OTHER_ITEM}>Other (type it)…</option>
                      </ComboSelect>
                    )}
                  </td>
                  <td className="p-1">
                    <input
                      aria-label="Position"
                      className="input border-transparent bg-transparent"
                      value={r.position ?? ''}
                      maxLength={200}
                      placeholder="Inside Top Back…"
                      onChange={(e) => setRow(i, { position: e.target.value || null })}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      aria-label="Description"
                      className="input border-transparent bg-transparent"
                      value={r.description ?? ''}
                      maxLength={2000}
                      placeholder="Woven, 2 cm, heat seal…"
                      onChange={(e) => setRow(i, { description: e.target.value || null })}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="input border-transparent bg-transparent"
                      value={r.colorText ?? ''}
                      list="bom-colors"
                      placeholder="Choose or type…"
                      onChange={(e) => setRow(i, { colorText: e.target.value || null })}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      aria-label="Consumption per piece"
                      className="input tnum border-transparent bg-transparent text-right"
                      inputMode="decimal"
                      value={r.consumptionPerPiece}
                      placeholder="—"
                      title="What one garment uses. The breakdown from the cut order multiplies each size's pieces by this."
                      onChange={numeric((v) => setRow(i, { consumptionPerPiece: v }))}
                    />
                  </td>
                  <td className="p-1">
                    {r.sizes.length > 0 ? (
                      // Derived from the size rows, so the two cannot disagree.
                      <div className="px-2 text-right text-sm tnum text-ink-600" title="Sum of the sizes below">
                        <Num value={rowQty(r)} places={rowQty(r) % 1 === 0 ? 0 : 4} />
                      </div>
                    ) : (
                      <input
                        className="input tnum border-transparent bg-transparent text-right"
                        inputMode="decimal"
                        value={r.requiredQty}
                        onChange={numeric((v) => setRow(i, { requiredQty: v }))}
                      />
                    )}
                  </td>
                  {/* Issued — editable here, and at any time. The Materials
                      tab's dialog only ever adds to this figure, so a number
                      typed once could never afterwards be corrected. Changing
                      it writes the difference to the issue log, so the trail
                      still reconciles. */}
                  <td className="p-1">
                    {canIssue ? (
                      <input
                        aria-label="Issued"
                        className="input tnum border-transparent bg-transparent text-right"
                        inputMode="decimal"
                        value={r.issuedQty}
                        placeholder="—"
                        title="What the warehouse has issued. Correcting it is recorded in the issue log."
                        onChange={numeric((v) => setRow(i, { issuedQty: v }))}
                      />
                    ) : (
                      <div className="px-2 text-right text-sm tnum text-ink-600" title="Issuing material is the warehouse's step">
                        {r.issuedQty === '' ? '—' : r.issuedQty}
                      </div>
                    )}
                  </td>
                  <td className="p-1">
                    <input
                      className="input border-transparent bg-transparent"
                      value={r.unit}
                      list="bom-units"
                      onChange={(e) => setRow(i, { unit: e.target.value })}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="input tnum border-transparent bg-transparent text-right"
                      inputMode="decimal"
                      value={r.unitPriceUsd}
                      placeholder="—"
                      onChange={numeric((v) => setRow(i, { unitPriceUsd: v }))}
                    />
                  </td>
                  <td className="td tnum text-right font-semibold">
                    <Num value={parse(r.unitPriceUsd) == null ? null : rowQty(r) * parse(r.unitPriceUsd)!} kind="money" places={2} />
                  </td>
                  <td className="p-1">
                    <input
                      className="input border-transparent bg-transparent"
                      value={r.supplier ?? ''}
                      onChange={(e) => setRow(i, { supplier: e.target.value || null })}
                    />
                  </td>
                  <td className="p-1">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        title="Break this item down by size"
                        onClick={() => setExpanded(expanded === r.uid ? null : r.uid)}
                      >
                        <Rows3 className="h-3.5 w-3.5" />
                        {r.sizes.length > 0 ? <span className="tnum text-xs">{r.sizes.length}</span> : null}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm text-red-600"
                        title="Remove this item"
                        onClick={() => {
                          const gone = rows[i]?.id;
                          if (gone) setRemovedIds((ids) => (ids.includes(gone) ? ids : [...ids, gone]));
                          setRows(rows.filter((_, n) => n !== i));
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>

                {expanded === r.uid ? (
                  <tr className="bg-ink-50/60">
                    <td colSpan={COLUMNS} className="px-4 py-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-ink-600">
                          Sizes for {r.item || 'this item'} — the quantity above becomes their total
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            disabled={!anyPieces}
                            title={!anyPieces
                              ? 'The order has no sizes or quantities yet'
                              : cutGenerated
                                ? `One row per size, its cut pieces${parse(r.consumptionPerPiece) ? ` × ${r.consumptionPerPiece} per piece` : ''}`
                                : 'The cut order is not generated yet, so the order quantities are used'}
                            onClick={() => fillFromCut(i)}
                          >
                            <Scissors className="h-3.5 w-3.5" /> Fill from the cut order
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setRow(i, { sizes: [...r.sizes, { sizeLabel: '', qty: '' }] })}
                          >
                            <Plus className="h-3.5 w-3.5" /> Add a size
                          </button>
                        </div>
                      </div>
                      {r.sizes.length === 0 ? (
                        <p className="text-xs text-ink-500">
                          No breakdown. The item is ordered as a single quantity.
                          {anyPieces ? ' Fill from the cut order for one row per size, or add sizes by hand.' : ''}
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {r.sizes.map((sz, n) => (
                            <div key={n} className="flex items-center gap-2">
                              <ComboSelect
                                allowCustom
                                aria-label="Size"
                                className={clsx('input w-44', !sz.sizeLabel.trim() && 'ring-1 ring-red-400')}
                                placeholder="Small, 40x30x20…"
                                maxLength={60}
                                value={sz.sizeLabel}
                                onChange={(e) => setSize(i, n, { sizeLabel: e.target.value })}
                              >
                                <option value="">Choose or type…</option>
                                {sizeOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                              </ComboSelect>
                              <input
                                aria-label="Quantity for this size"
                                className="input tnum w-28 text-right"
                                inputMode="decimal"
                                value={sz.qty}
                                onChange={numeric((v) => setSize(i, n, { qty: v }))}
                              />
                              {sizes.find((s) => s.name === sz.sizeLabel) && (
                                <span className="text-2xs text-ink-500 tnum" title="Pieces in this size on the cut order">
                                  {cutGenerated ? 'cut' : 'ordered'} {(cutGenerated ? sizes.find((s) => s.name === sz.sizeLabel)!.cutQty : sizes.find((s) => s.name === sz.sizeLabel)!.orderQty).toLocaleString()}
                                </span>
                              )}
                              <button
                                type="button"
                                className="btn-ghost btn-sm text-red-600"
                                onClick={() => setRow(i, { sizes: r.sizes.filter((_, k) => k !== n) })}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
          {rows.length > 0 ? (
            <tfoot className="border-t border-ink-200 bg-ink-50">
              <tr>
                <td colSpan={COLUMNS - 3} className="td text-right font-medium">Estimated material cost</td>
                <td className="td tnum text-right font-semibold">
                  <Num value={total || null} kind="money" places={2} />
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {/*
        Suggestions, not restrictions.
        Every one of these is a <datalist>: the field shows the factory's own
        list to pick from, and still accepts a value nobody has listed yet — a
        new colour, a unit this order happens to use, a carton size. A <select>
        would be tidier and would make the first genuinely new material
        unenterable, which is the wrong trade on a bill of materials.
      */}
      <datalist id="bom-item-types">
        {itemTypes.map((t) => <option key={t} value={t} />)}
      </datalist>
      <datalist id="bom-colors">
        {colors.map((c) => <option key={c} value={c} />)}
      </datalist>
      <datalist id="bom-units">
        {[...new Set([...BOM_UNITS, ...units])].map((v) => <option key={v} value={v} />)}
      </datalist>
      {BOM_DEPARTMENTS.map((d) => (
        <datalist key={d} id={`bom-items-${d}`}>
          {itemsFor(d).map((x) => <option key={x} value={x} />)}
        </datalist>
      ))}
    </div>
  );
}
