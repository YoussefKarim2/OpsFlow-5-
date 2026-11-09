/**
 * The customer's PO prices, model by model: pieces × price = amount, and the
 * PO's total. Shown on Order Details and under the Main Order grid.
 *
 * A model's price is the one its PO line gave (read when the PO was imported)
 * and can be typed or corrected here. When every model has a price, the
 * order's price per piece follows their average (see the server's
 * syncOrderPriceFromModels), so the costing sells at what the PO says.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QtyLedger, type OrderDetailDto } from '@opsflow/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader, ColourSwatch, ErrorNote, clsx } from './ui';

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A price as typed back into its box: no trailing zeros past the cents. */
const priceText = (n: number | null | undefined) => (n == null ? '' : String(Number(n.toFixed(4))));

export function PoPricesCard({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const editable = can('order:edit') && !order.cancelled;
  const { data } = useQuery({ queryKey: ['matrix', order.id], queryFn: () => api.orders.matrix(order.id) });
  /** Prices being typed, by model; a model not here shows its saved price. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ colorId, price }: { colorId: string; price: number | null }) => api.orders.setModelPrice(order.id, colorId, price),
    onSuccess: (_r, v) => {
      setDrafts((d) => { const n = { ...d }; delete n[v.colorId]; return n; });
      for (const k of ['matrix', 'order', 'order-steps']) void qc.invalidateQueries({ queryKey: [k, order.id] });
    },
  });

  if (!data || data.colors.length === 0) return null;
  const pcsOf = (id: string) => data.matrices[QtyLedger.ORDER]?.rowTotals[id] ?? 0;
  // The order's own price stands in for a model the PO did not price.
  const priceOf = (c: (typeof data.colors)[number]) => c.unitPriceUsd ?? order.pricePerPieceUsd ?? null;
  const rows = data.colors.map((c) => {
    const pcs = pcsOf(c.id);
    const price = priceOf(c);
    return { c, pcs, price, own: c.unitPriceUsd != null, amount: price == null ? null : pcs * price };
  });
  const totalPcs = rows.reduce((a, r) => a + r.pcs, 0);
  const totalValue = rows.every((r) => r.amount != null) ? rows.reduce((a, r) => a + r.amount!, 0) : null;
  const missing = rows.filter((r) => r.price == null).length;

  const commit = (colorId: string, saved: number | null | undefined) => {
    const text = drafts[colorId];
    if (text == null) return;
    const t = text.trim().replace(/[$,\s]/g, '');
    const price = t === '' ? null : Number(t);
    if (price != null && (!Number.isFinite(price) || price < 0)) return;
    if ((price ?? null) === (saved ?? null)) { setDrafts((d) => { const n = { ...d }; delete n[colorId]; return n; }); return; }
    save.mutate({ colorId, price });
  };

  return (
    <Card>
      <CardHeader
        title="PO prices"
        subtitle={missing > 0
          ? `${missing} model${missing === 1 ? ' has' : 's have'} no price yet${editable ? ' — type it below' : ''}.`
          : 'Each model at its price on the customer\'s PO.'}
      />
      {save.error != null && <div className="px-4 pt-3"><ErrorNote error={save.error} /></div>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th">Model / colour</th>
              <th className="th text-right">Pieces</th>
              <th className="th text-right">Price per piece</th>
              <th className="th text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map(({ c, pcs, price, own, amount }) => (
              <tr key={c.id}>
                <td className="td font-medium text-ink-900">
                  <span className="inline-flex items-center gap-2"><ColourSwatch name={c.name} />{c.name}</span>
                </td>
                <td className="td tnum text-right">{pcs.toLocaleString()}</td>
                <td className="td tnum text-right">
                  {editable ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-ink-400">$</span>
                      <input
                        className={clsx('input h-8 w-24 text-right tnum', !own && price != null && drafts[c.id] == null && 'text-ink-400')}
                        inputMode="decimal"
                        aria-label={`Price per piece for ${c.name}`}
                        placeholder={order.pricePerPieceUsd != null ? priceText(order.pricePerPieceUsd) : '0.00'}
                        value={drafts[c.id] ?? priceText(c.unitPriceUsd)}
                        disabled={save.isPending && save.variables?.colorId === c.id}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                        onBlur={() => commit(c.id, c.unitPriceUsd)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                    </span>
                  ) : price == null ? <span className="text-ink-300">—</span> : (
                    <span className={own ? undefined : 'text-ink-500'}>{money(price)}</span>
                  )}
                </td>
                <td className="td tnum text-right font-medium">{amount == null ? <span className="text-ink-300">—</span> : money(amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-ink-300 bg-ink-50">
            <tr>
              <td className="td font-semibold">PO total</td>
              <td className="td tnum text-right font-semibold">{totalPcs.toLocaleString()}</td>
              <td className="td tnum text-right text-ink-600">
                {totalValue != null && totalPcs > 0 ? `avg ${money(totalValue / totalPcs)}` : ''}
              </td>
              <td className="td tnum text-right font-bold">{totalValue == null ? <span className="text-ink-300">—</span> : money(totalValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
