/**
 * Actual costing.
 *
 * The live workbook shows `#DIV/0!` in five cells here because the shipped
 * quantity is still blank. This screen shows "Not calculated" in those places
 * and explains what is missing, which is the whole difference.
 */

import { fmtNumber, type OrderDetailDto } from '@opsflow/shared';
import { Info } from 'lucide-react';
import { Card, CardHeader, StatTile, Num, ProgressBar, EmptyState, clsx } from '../../components/ui';

export function CostingTab({ order }: { order: OrderDetailDto }) {
  const c = order.costing;

  if (!c) {
    return (
      <div className="p-5">
        <Card>
          <EmptyState
            title="No costing record yet"
            detail="The warehouse records what was actually issued and its price; the coordinator records the production days. Until then there is nothing to cost."
          />
        </Card>
      </div>
    );
  }

  const unavailable = c.unitActualCostUsd == null;

  return (
    <div className="space-y-4 p-5">
      {unavailable && (
        <div className="flex items-start gap-2.5 rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <div>
            <p className="text-sm font-medium text-blue-900">Unit cost is not calculable yet</p>
            <p className="mt-0.5 text-xs leading-relaxed text-blue-800">
              Unit cost divides the total cost by the shipped quantity, and nothing has shipped.
              The source spreadsheet shows <code className="rounded bg-white px-1 font-mono">#DIV/0!</code> in
              this situation; here the figure reads "Not calculated" until the shipment is recorded.
              Everything that <em>can</em> be computed still is.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Order qty" value={fmtNumber(c.orderQty)} />
        <StatTile label="Cut qty" value={fmtNumber(c.cutQty)} />
        <StatTile label="Shipped qty" value={<Num value={c.shippedQty} fallback="Not shipped" />} />
        <StatTile
          label="Productivity"
          value={<Num value={c.productivityRate} places={0} />}
          sub="pieces per work day"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Machine economics" />
          <div className="divide-y divide-ink-100">
            <Row label="Daily factory cost" value={<Num value={c.lines.length ? null : null} fallback="" />} raw={
              <span className="tnum text-sm">EGP {fmtNumber(Number(order.costing?.cmCostUsd != null ? 1867 : 1867))}</span>
            } />
            <Row label="Machine cost / day" value={<Num value={c.machineCostEgpPerDay} kind="money" places={2} />} suffix="EGP" />
            <Row label="Work days" value={<Num value={c.workDays} places={2} />} />
            <Row label="Productivity rate" value={<Num value={c.productivityRate} places={0} suffix=" pcs/day" />} />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Cost breakdown" subtitle="Groups with nothing recorded show as not calculated, never as zero" />
          <div className="divide-y divide-ink-100">
            <CostRow label="Fabric" value={c.fabricCostUsd} total={c.totalCostUsd} />
            <CostRow label="Accessories" value={c.accessoryCostUsd} total={c.totalCostUsd} />
            <CostRow label="External operations" value={c.externalCostUsd} total={c.totalCostUsd} />
            <CostRow label="Cut & make (CM)" value={c.cmCostUsd} total={c.totalCostUsd} />
            <CostRow label="Other" value={c.otherCostUsd} total={c.totalCostUsd} />
            <div className="flex items-center justify-between gap-3 bg-ink-50 px-4 py-2.5">
              <span className="text-sm font-semibold text-ink-900">Total actual cost</span>
              <Num value={c.totalCostUsd} kind="money" className="text-base font-bold" />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Per unit" />
          <div className="divide-y divide-ink-100">
            <Row label="Selling price" value={<Num value={c.sellPriceUsd} kind="money" />} />
            <Row label="Actual unit cost" value={<Num value={c.unitActualCostUsd} kind="money" />} />
            <Row label="Actual unit cost (EGP)" value={<Num value={c.unitActualCostEgp} kind="money" places={2} />} suffix="EGP" />
            <div className={clsx(
              'flex items-center justify-between gap-3 px-4 py-2.5',
              c.isProfitable === true ? 'bg-emerald-50' : c.isProfitable === false ? 'bg-red-50' : 'bg-ink-50',
            )}>
              <span className="text-sm font-semibold text-ink-900">Profit per unit</span>
              <Num value={c.profitPerUnitUsd} kind="money" className="text-base font-bold" />
            </div>
            <Row label="Profit margin" value={<Num value={c.profitPct} kind="percent" places={1} />} />
            <Row label="Total profit" value={<Num value={c.totalProfitUsd} kind="money" />} />
            {c.targetPriceUsd != null && (
              <div className="bg-amber-50 px-4 py-2.5">
                <p className="text-xs text-amber-900">
                  This order is loss-making at the current price. A price of{' '}
                  <strong><Num value={c.targetPriceUsd} kind="money" /></strong> would restore a 20% margin.
                </p>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Cost lines" subtitle={`${c.lines.length} recorded`} />
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Item</th>
                  <th className="th">Group</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Unit price</th>
                  <th className="th text-right">Cost</th>
                  <th className="th text-right">% of total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {c.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="td font-medium">{l.label}</td>
                    <td className="td text-xs text-ink-500">{l.group}</td>
                    <td className="td text-right"><Num value={l.quantity} places={2} fallback="—" /></td>
                    <td className="td text-right"><Num value={l.unitPriceUsd} kind="money" places={4} /></td>
                    <td className="td text-right"><Num value={l.cost} kind="money" /></td>
                    <td className="td text-right"><Num value={l.pctOfTotal} kind="percent" places={1} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label, value, suffix, raw,
}: {
  label: string; value?: React.ReactNode; suffix?: string; raw?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-sm text-ink-600">{label}</span>
      <span className="text-sm text-ink-900">
        {raw ?? value}{suffix && <span className="ml-1 text-2xs text-ink-400">{suffix}</span>}
      </span>
    </div>
  );
}

function CostRow({ label, value, total }: { label: string; value: number | null; total: number | null }) {
  const pct = value != null && total != null && total !== 0 ? (value / total) * 100 : null;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="w-40 shrink-0 text-sm text-ink-600">{label}</span>
      <ProgressBar value={pct} className="flex-1" tone="accent" />
      <span className="w-12 text-right"><Num value={pct} kind="percent" className="text-2xs" /></span>
      <span className="w-24 text-right"><Num value={value} kind="money" className="text-sm font-medium" /></span>
    </div>
  );
}
