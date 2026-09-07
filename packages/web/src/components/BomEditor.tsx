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

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Rows3 } from 'lucide-react';
import { api, type BomRowDto, type BomSizeDto } from '../lib/api';
import { Num, ErrorNote, clsx } from './ui';

/** The BOM categories the schema stores. The dropdown labels them properly. */
const CATEGORIES = [
  'FABRIC', 'THREAD', 'LABEL', 'TRANSFER', 'BADGE', 'LOGO', 'SPONSOR', 'SIZE',
  'POLY_BAG', 'BUTTER_PAPER', 'STICKY_TAPE', 'BARCODE_PAPER', 'HALF_BOX',
  'CARTON', 'TAPE', 'ACCESSORY', 'OTHER',
] as const;

const label = (t: string) => {
  const s = t.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const blankRow = (): BomRowDto => ({
  category: 'ACCESSORY', item: '', description: null, colorText: null,
  unit: 'PCS', requiredQty: 0, unitPriceUsd: null, supplier: null, notes: null, sizes: [],
});

/** A row's quantity is the sum of its sizes once any exist. */
export function rowQty(r: BomRowDto): number {
  return r.sizes.length > 0 ? r.sizes.reduce((a, s) => a + (s.qty || 0), 0) : r.requiredQty || 0;
}

export function BomEditor({
  orderId, initial, itemTypes, onSaved,
}: {
  orderId: string;
  initial: BomRowDto[];
  /** `RefValue` rows of kind BOM_ITEM_TYPE, from /lookups. */
  itemTypes: string[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<BomRowDto[]>(initial);
  const [expanded, setExpanded] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: () => api.materials.saveBom(orderId, rows.map((r) => ({ ...r, requiredQty: rowQty(r) }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bom', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      onSaved?.();
    },
  });

  const setRow = (i: number, patch: Partial<BomRowDto>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const setSize = (i: number, n: number, patch: Partial<BomSizeDto>) =>
    setRow(i, { sizes: rows[i]!.sizes.map((s, k) => (k === n ? { ...s, ...patch } : s)) });

  // An item with no name cannot be saved: the BOM is read by people picking
  // stock off a shelf, and a nameless line helps nobody.
  const invalid = rows.some((r) => !r.item.trim());
  const total = rows.reduce((a, r) => a + rowQty(r) * (r.unitPriceUsd ?? 0), 0);

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
            title={invalid ? 'Every item needs a name' : undefined}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {save.error ? <ErrorNote error={save.error} /> : null}

      <div className="overflow-x-auto">
        <table className="w-full border border-ink-200">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th w-40">Type</th>
              <th className="th">Item</th>
              <th className="th w-36">Colour</th>
              <th className="th w-28 text-right">Quantity</th>
              <th className="th w-20">Unit</th>
              <th className="th w-28 text-right">Unit price</th>
              <th className="th w-28 text-right">Total</th>
              <th className="th w-32">Supplier</th>
              <th className="th w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="td py-6 text-center text-ink-500">
                  Nothing in the bill of materials yet. Import a document, or add an item.
                </td>
              </tr>
            ) : null}

            {rows.map((r, i) => (
              <>
                <tr key={`r${i}`}>
                  <td className="p-1">
                    <select
                      className="input border-transparent bg-transparent"
                      value={r.category}
                      onChange={(e) => setRow(i, { category: e.target.value })}
                    >
                      {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                    </select>
                  </td>
                  <td className="p-1">
                    <input
                      className={clsx('input border-transparent bg-transparent', !r.item.trim() && 'ring-1 ring-red-400')}
                      value={r.item}
                      list="bom-item-types"
                      placeholder="Main Fabric, Logo Badge, Zipper…"
                      onChange={(e) => setRow(i, { item: e.target.value })}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="input border-transparent bg-transparent"
                      value={r.colorText ?? ''}
                      onChange={(e) => setRow(i, { colorText: e.target.value || null })}
                    />
                  </td>
                  <td className="p-1">
                    {r.sizes.length > 0 ? (
                      // Derived from the size rows, so the two cannot disagree.
                      <div className="px-2 text-right text-sm tnum text-ink-600" title="Sum of the sizes below">
                        <Num value={rowQty(r)} places={0} />
                      </div>
                    ) : (
                      <input
                        className="input tnum border-transparent bg-transparent text-right"
                        value={r.requiredQty || ''}
                        onChange={(e) => setRow(i, { requiredQty: Number(e.target.value) || 0 })}
                      />
                    )}
                  </td>
                  <td className="p-1">
                    <input
                      className="input border-transparent bg-transparent"
                      value={r.unit}
                      onChange={(e) => setRow(i, { unit: e.target.value })}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      className="input tnum border-transparent bg-transparent text-right"
                      value={r.unitPriceUsd ?? ''}
                      placeholder="—"
                      onChange={(e) => setRow(i, { unitPriceUsd: e.target.value === '' ? null : Number(e.target.value) })}
                    />
                  </td>
                  <td className="td tnum text-right font-semibold">
                    <Num value={r.unitPriceUsd == null ? null : rowQty(r) * r.unitPriceUsd} kind="money" places={2} />
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
                        onClick={() => setExpanded(expanded === i ? null : i)}
                      >
                        <Rows3 className="h-3.5 w-3.5" />
                        {r.sizes.length > 0 ? <span className="tnum text-xs">{r.sizes.length}</span> : null}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm text-red-600"
                        title="Remove this item"
                        onClick={() => setRows(rows.filter((_, n) => n !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>

                {expanded === i ? (
                  <tr key={`s${i}`} className="bg-ink-50/60">
                    <td colSpan={9} className="px-4 py-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-ink-600">
                          Sizes for {r.item || 'this item'} — the quantity above becomes their total
                        </span>
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => setRow(i, { sizes: [...r.sizes, { sizeLabel: '', qty: 0 }] })}
                        >
                          <Plus className="h-3.5 w-3.5" /> Add a size
                        </button>
                      </div>
                      {r.sizes.length === 0 ? (
                        <p className="text-xs text-ink-500">
                          No breakdown. The item is ordered as a single quantity.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {r.sizes.map((sz, n) => (
                            <div key={n} className="flex items-center gap-2">
                              <input
                                className="input w-40"
                                placeholder="Small, 40x30x20…"
                                value={sz.sizeLabel}
                                onChange={(e) => setSize(i, n, { sizeLabel: e.target.value })}
                              />
                              <input
                                className="input tnum w-28 text-right"
                                value={sz.qty || ''}
                                onChange={(e) => setSize(i, n, { qty: Number(e.target.value) || 0 })}
                              />
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
              </>
            ))}
          </tbody>
          {rows.length > 0 ? (
            <tfoot className="border-t border-ink-200 bg-ink-50">
              <tr>
                <td colSpan={6} className="td text-right font-medium">Estimated material cost</td>
                <td className="td tnum text-right font-semibold">
                  <Num value={total || null} kind="money" places={2} />
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {/* Suggestions, not a restriction: the field stays free text. */}
      <datalist id="bom-item-types">
        {itemTypes.map((t) => <option key={t} value={t} />)}
      </datalist>
    </div>
  );
}
