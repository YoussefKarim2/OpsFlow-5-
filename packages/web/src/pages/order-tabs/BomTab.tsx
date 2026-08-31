/**
 * Bill of materials. The shortage column is the point: `issued − required`,
 * derived on read, shown prominently as the brief's section 13 asks.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PackagePlus, AlertTriangle } from 'lucide-react';
import { fmtDate, type OrderDetailDto } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, StatTile, Num, ProgressBar, Modal, Field, Spinner, ErrorNote, clsx,
} from '../../components/ui';

interface BomRow {
  id: string; category: string; position: string | null; item: string;
  description: string | null; color: string | null; unit: string;
  consumptionPerPiece: number | null; requiredQty: number; issuedQty: number;
  shortage: number; shortQty: number; coveragePct: number | null;
  status: 'NOT_ISSUED' | 'PARTIAL' | 'COMPLETE' | 'OVER_ISSUED';
  issuedByName: string | null; issuedToName: string | null; issuedAt: string | null;
  issues: Array<{ id: string; qty: number; unit: string; issuedAt: string; issuedByName: string | null; issuedToName: string | null }>;
}

const STATUS_TONE: Record<BomRow['status'], string> = {
  NOT_ISSUED: 'bg-red-50 text-red-700 ring-red-600/20',
  PARTIAL: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  COMPLETE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  OVER_ISSUED: 'bg-blue-50 text-blue-700 ring-blue-600/20',
};

export function BomTab({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [issuing, setIssuing] = useState<BomRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['bom', order.id],
    queryFn: () => api.materials.bom(order.id),
  });

  if (isLoading) return <Spinner />;
  if (error) return <div className="p-5"><ErrorNote error={error} /></div>;
  if (!data) return null;

  const rows = data.items as unknown as BomRow[];
  const s = data.summary;
  const byCategory = new Map<string, BomRow[]>();
  for (const r of rows) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="BOM lines" value={s.totalItems} />
        <StatTile label="Short" value={s.shortItems} tone={s.shortItems > 0 ? 'red' : 'emerald'} />
        <StatTile label="Fully issued" value={s.completeItems} tone="emerald" />
        <StatTile
          label="Overall coverage"
          value={<Num value={s.overallCoveragePct} kind="percent" />}
          tone={s.fullyIssued ? 'emerald' : 'amber'}
        />
      </div>

      {s.shortItems > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-medium text-amber-900">
                {s.shortItems} of {s.totalItems} material lines are outstanding.
              </p>
              <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800">
                {s.topShortages.map((t) => (
                  <li key={t.id}>
                    <strong>{t.item}</strong>{t.color ? ` (${t.color})` : ''} — short by{' '}
                    <Num value={t.shortQty} places={t.shortQty % 1 === 0 ? 0 : 2} /> {t.unit}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-amber-700">
                Production cannot be marked ready until every line is issued or a purchase order is recorded.
              </p>
            </div>
          </div>
        </div>
      )}

      {[...byCategory.entries()].map(([category, items]) => {
        const shortInCategory = items.filter((i) => i.shortQty > 0).length;
        return (
          <Card key={category}>
            <CardHeader
              title={category.replace(/_/g, ' ')}
              subtitle={`${items.length} line${items.length === 1 ? '' : 's'}${shortInCategory > 0 ? ` · ${shortInCategory} short` : ''}`}
            />
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">Item</th>
                    <th className="th">Position</th>
                    <th className="th">Description</th>
                    <th className="th">Colour</th>
                    <th className="th text-right">Cons./pc</th>
                    <th className="th text-right">Required</th>
                    <th className="th text-right">Issued</th>
                    <th className="th text-right">Shortage</th>
                    <th className="th w-24">Coverage</th>
                    <th className="th">Status</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {items.map((r) => (
                    <tr key={r.id} className={clsx(r.shortQty > 0 && 'bg-amber-50/30')}>
                      <td className="td font-medium text-ink-800">{r.item}</td>
                      <td className="td text-xs text-ink-500">{r.position || '—'}</td>
                      <td className="td text-xs">{r.description || '—'}</td>
                      <td className="td text-xs">{r.color || '—'}</td>
                      <td className="td text-right text-xs">
                        <Num value={r.consumptionPerPiece} places={4} fallback="—" />
                      </td>
                      <td className="td text-right"><Num value={r.requiredQty} places={r.requiredQty % 1 === 0 ? 0 : 3} /></td>
                      <td className="td text-right"><Num value={r.issuedQty} places={r.issuedQty % 1 === 0 ? 0 : 3} /></td>
                      <td className="td text-right">
                        <span className={clsx('tnum text-sm font-semibold', r.shortage < 0 ? 'text-red-600' : 'text-emerald-600')}>
                          <Num value={r.shortage} kind="variance" />
                        </span>
                      </td>
                      <td className="td"><ProgressBar value={r.coveragePct} /></td>
                      <td className="td">
                        <span className={clsx('chip', STATUS_TONE[r.status])}>
                          {r.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="td text-right">
                        {can('material:issue') && r.shortQty > 0 && (
                          <button onClick={() => setIssuing(r)} className="btn-secondary btn-sm">
                            <PackagePlus className="h-3 w-3" /> Issue
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      <IssueModal
        item={issuing}
        onClose={() => setIssuing(null)}
        onDone={() => {
          setIssuing(null);
          void qc.invalidateQueries({ queryKey: ['bom', order.id] });
          void qc.invalidateQueries({ queryKey: ['order', order.id] });
        }}
      />
    </div>
  );
}

function IssueModal({
  item, onClose, onDone,
}: {
  item: BomRow | null; onClose: () => void; onDone: () => void;
}) {
  const [qty, setQty] = useState('');
  const [issuedTo, setIssuedTo] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const issue = useMutation({
    mutationFn: () =>
      api.materials.issue(item!.id, { qty: Number(qty), issuedToName: issuedTo || undefined, notes: notes || undefined }),
    onSuccess: () => { setQty(''); setIssuedTo(''); setNotes(''); setError(null); onDone(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not record the issue.'),
  });

  if (!item) return null;

  return (
    <Modal
      open onClose={onClose}
      title={`Issue ${item.item}`}
      subtitle={`${item.shortQty.toLocaleString()} ${item.unit} outstanding of ${item.requiredQty.toLocaleString()} required`}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => issue.mutate()}
            disabled={!qty || Number(qty) <= 0 || issue.isPending}
            className="btn-primary"
          >
            {issue.isPending ? 'Recording…' : 'Record issue'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote error={new Error(error)} />}

        <Field label={`Quantity (${item.unit})`} hint={`Issuing all ${item.shortQty.toLocaleString()} clears this line.`}>
          <div className="flex gap-2">
            <input
              type="number" min={0} step="any" value={qty}
              onChange={(e) => setQty(e.target.value)} className="input" autoFocus
            />
            <button onClick={() => setQty(String(item.shortQty))} className="btn-secondary btn-sm shrink-0">
              Issue all
            </button>
          </div>
        </Field>

        <Field label="Issued to" hint="The line supervisor or department receiving the material.">
          <input value={issuedTo} onChange={(e) => setIssuedTo(e.target.value)} className="input" />
        </Field>

        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="input" />
        </Field>

        {item.issues.length > 0 && (
          <div>
            <p className="label">Previous issues</p>
            <ul className="space-y-1 text-xs">
              {item.issues.map((i) => (
                <li key={i.id} className="flex justify-between rounded border border-ink-200 bg-ink-50 px-2 py-1">
                  <span className="tnum font-medium">{i.qty.toLocaleString()} {i.unit}</span>
                  <span className="text-ink-500">
                    {i.issuedByName ?? '—'} → {i.issuedToName ?? '—'} · {fmtDate(i.issuedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
