/**
 * Cutting, fabric and the marker plan.
 *
 * The lay table reproduces `Laying fabric instructions_Patr` including its
 * `(+/-)` reconciliation row, which compares what the lay plan produces against
 * what the cut order requires — per size, not just in total.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { Card, CardHeader, StatTile, Num, Spinner, EmptyState, clsx } from '../../components/ui';
import { LayingMarkingImportWizard } from './LayingMarkingImportWizard';

interface Plan {
  lays: Array<{
    id: string; fabric: string; color: string; panel: string; ratio: string;
    layers: number; markerLengthM: number; nestPcs: number | null;
    output: Record<string, number>; totalPieces: number; totalLengthM: number;
    consumptionPerPieceM: number | null;
  }>;
  plannedBySize: Record<string, number>;
  requiredBySize: Record<string, number>;
  varianceBySize: Record<string, number>;
  plannedTotal: number; requiredTotal: number; varianceTotal: number;
  totalLayers: number; totalFabricM: number;
  avgConsumptionPerPieceM: number | null; planEfficiencyPct: number | null;
}

interface FabricPos {
  fabric: string; color: string; requiredM: number; availableM: number | null;
  issuedM: number | null; actualConsumptionM: number | null; remainingM: number | null;
  shortageM: number; consumptionVsPlanPct: number | null;
}

export function MarkerTab({ order }: { order: OrderDetailDto }) {
  const { can } = useAuth();
  const [importing, setImporting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['markers', order.id],
    queryFn: () => api.materials.markers(order.id),
  });
  const { data: history } = useQuery({
    queryKey: ['laying-import-history', order.id],
    queryFn: () => api.layingImport.history(order.id),
  });

  if (isLoading) return <Spinner />;
  if (!data) return null;

  const plan = data.plan as unknown as Plan;
  const fabrics = data.fabrics as unknown as FabricPos[];
  const cutting = data.cutting as unknown as Array<{
    id: string; cutDate: string | null; cuttingTeam: string | null; cutByName: string | null;
    inspectedByName: string | null; actualCutQty: number | null; fabricUsedM: number | null; notes: string | null;
  }>;

  // Size order comes from the cut requirement, so the columns match the matrix.
  const sizes = Object.keys(plan.requiredBySize).length > 0
    ? Object.keys(plan.requiredBySize)
    : Object.keys(plan.plannedBySize);

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Lays" value={plan.lays.length} />
        <StatTile label="Total layers" value={<Num value={plan.totalLayers} />} />
        <StatTile label="Fabric required" value={<Num value={plan.totalFabricM} places={0} suffix=" m" />} />
        <StatTile
          label="Consumption / pc"
          value={<Num value={plan.avgConsumptionPerPieceM} places={3} suffix=" m" />}
        />
        <StatTile
          label="Plan vs requirement"
          value={<Num value={plan.varianceTotal} kind="variance" />}
          tone={Math.abs(plan.varianceTotal) > plan.requiredTotal * 0.02 ? 'amber' : 'emerald'}
          sub={`${plan.plannedTotal.toLocaleString()} planned / ${plan.requiredTotal.toLocaleString()} needed`}
        />
      </div>

      <Card>
        <CardHeader
          title="Lay plan"
          subtitle="Each row is one marker: a size ratio, a layer count and a marker length"
          action={
            can('cutting:write') && (
              <button className="btn-secondary btn-sm" onClick={() => setImporting(true)}>
                <FileUp className="h-3.5 w-3.5" /> Import Laying & Marking Excel
              </button>
            )
          }
        />
        {plan.lays.length === 0 ? (
          <EmptyState title="No lays recorded" detail="The cutting and marker department adds the lay plan here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">#</th>
                  <th className="th">Fabric</th>
                  <th className="th">Panel</th>
                  <th className="th">Size ratio</th>
                  {sizes.map((s) => <th key={s} className="th text-center">{s}</th>)}
                  <th className="th text-right">Layers</th>
                  <th className="th text-right">Marker (m)</th>
                  <th className="th text-right">Total (m)</th>
                  <th className="th text-right">Pieces</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {plan.lays.map((l, i) => (
                  <tr key={l.id} className="hover:bg-accent-50/30">
                    <td className="td tnum text-ink-400">{i + 1}</td>
                    <td className="td text-xs">
                      {l.fabric}{l.color && <span className="text-ink-400"> · {l.color}</span>}
                    </td>
                    <td className="td text-xs">{l.panel}</td>
                    <td className="td font-mono text-2xs text-ink-600">{l.ratio}</td>
                    {sizes.map((s) => (
                      <td key={s} className="td text-center">
                        <span className={clsx('tnum text-sm', !l.output[s] && 'text-ink-300')}>
                          {l.output[s] || '·'}
                        </span>
                      </td>
                    ))}
                    <td className="td text-right"><Num value={l.layers} /></td>
                    <td className="td text-right"><Num value={l.markerLengthM} places={2} /></td>
                    <td className="td text-right"><Num value={l.totalLengthM} places={0} /></td>
                    <td className="td text-right font-semibold"><Num value={l.totalPieces} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-300 bg-ink-100">
                  <td colSpan={4} className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-600">
                    Lay plan produces
                  </td>
                  {sizes.map((s) => (
                    <td key={s} className="tnum px-2 py-2 text-center text-sm font-semibold">
                      {plan.plannedBySize[s] ?? 0}
                    </td>
                  ))}
                  <td className="tnum px-3 py-2 text-right text-sm font-semibold">{plan.totalLayers}</td>
                  <td />
                  <td className="tnum px-3 py-2 text-right text-sm font-semibold">{Math.round(plan.totalFabricM)}</td>
                  <td className="tnum px-3 py-2 text-right text-sm font-bold">{plan.plannedTotal.toLocaleString()}</td>
                </tr>
                <tr className="bg-ink-50">
                  <td colSpan={4} className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-600">
                    Cut order requires
                  </td>
                  {sizes.map((s) => (
                    <td key={s} className="tnum px-2 py-2 text-center text-sm text-ink-700">
                      {plan.requiredBySize[s] ?? 0}
                    </td>
                  ))}
                  <td colSpan={3} />
                  <td className="tnum px-3 py-2 text-right text-sm font-semibold">{plan.requiredTotal.toLocaleString()}</td>
                </tr>
                {/* The workbook's (+/-) row. */}
                <tr className="bg-white">
                  <td colSpan={4} className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-600">
                    Variance (+/−)
                  </td>
                  {sizes.map((s) => {
                    const v = plan.varianceBySize[s] ?? 0;
                    return (
                      <td key={s} className="px-2 py-2 text-center">
                        <span className={clsx(
                          'tnum text-sm font-semibold',
                          v === 0 ? 'text-ink-300' : v > 0 ? 'text-emerald-600' : 'text-red-600',
                        )}>
                          {v === 0 ? '·' : v > 0 ? `+${v}` : v}
                        </span>
                      </td>
                    );
                  })}
                  <td colSpan={3} />
                  <td className="px-3 py-2 text-right">
                    <Num value={plan.varianceTotal} kind="variance" className="text-sm font-bold" />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Fabric position" />
          {fabrics.length === 0 ? (
            <EmptyState title="No fabric records" />
          ) : (
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Fabric</th>
                  <th className="th text-right">Required</th>
                  <th className="th text-right">Issued</th>
                  <th className="th text-right">Consumed</th>
                  <th className="th text-right">Short</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {fabrics.map((f, i) => (
                  <tr key={i}>
                    <td className="td font-medium">{f.fabric}{f.color && <span className="text-ink-400"> · {f.color}</span>}</td>
                    <td className="td text-right"><Num value={f.requiredM} places={0} suffix=" m" /></td>
                    <td className="td text-right"><Num value={f.issuedM} places={0} suffix=" m" fallback="—" /></td>
                    <td className="td text-right"><Num value={f.actualConsumptionM} places={0} suffix=" m" fallback="—" /></td>
                    <td className="td text-right">
                      <span className={clsx('tnum text-sm font-semibold', f.shortageM > 0 ? 'text-red-600' : 'text-emerald-600')}>
                        {f.shortageM > 0 ? `${Math.round(f.shortageM).toLocaleString()} m` : 'Covered'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <CardHeader title="Cutting records" />
          {cutting.length === 0 ? (
            <EmptyState title="Nothing cut yet" />
          ) : (
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Date</th>
                  <th className="th">Team</th>
                  <th className="th">Cut by</th>
                  <th className="th text-right">Qty</th>
                  <th className="th text-right">Fabric</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {cutting.map((c) => (
                  <tr key={c.id}>
                    <td className="td">{fmtDate(c.cutDate)}</td>
                    <td className="td text-xs">{c.cuttingTeam || '—'}</td>
                    <td className="td text-xs">{c.cutByName || '—'}</td>
                    <td className="td text-right font-semibold"><Num value={c.actualCutQty} /></td>
                    <td className="td text-right"><Num value={c.fabricUsedM} places={0} suffix=" m" fallback="—" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {history && history.data.length > 0 && (
        <Card>
          <CardHeader title="Laying & Marking import history" subtitle="Every upload, who made it and what happened" />
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">File</th>
                <th className="th">Uploaded by</th>
                <th className="th">Date</th>
                <th className="th text-right">Rows</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td className="td text-xs">{h.fileName}</td>
                  <td className="td text-xs">{h.uploadedBy.name}</td>
                  <td className="td text-xs">{fmtDate(h.createdAt)}</td>
                  <td className="td text-right tnum">{h.rowCount}</td>
                  <td className="td">
                    <span className={clsx(
                      'chip',
                      h.status === 'COMMITTED' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                        : h.status === 'FAILED' ? 'bg-red-50 text-red-700 ring-red-600/20'
                        : 'bg-ink-50 text-ink-600 ring-ink-300',
                    )}>
                      {h.status}
                    </span>
                    {h.errorMessage && <p className="mt-0.5 text-2xs text-red-600">{h.errorMessage}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {importing && (
        <LayingMarkingImportWizard
          orderId={order.id}
          orderPoNumber={order.poNumber}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
