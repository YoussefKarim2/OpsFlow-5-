/**
 * Quality audit — the R02 Final Inspection report.
 *
 * The AQL sampling table from the sheet drives the verdict rather than sitting
 * beside it as a printed reference, and a FAIL creates the corrective-action
 * task automatically.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, Plus } from 'lucide-react';
import { fmtDate, DEFECT_LABEL, DEFECT_CATEGORIES, type OrderDetailDto, type DefectCategory } from '@opsflow/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, StatTile, Num, Modal, Field, Spinner, ErrorNote, EmptyState, clsx,
} from '../../components/ui';

interface Audit {
  id: string; inspectionDate: string; factoryName: string | null; auditType: string;
  availableQty: number; sampleSize: number | null; acceptedQty: number | null; rejectedQty: number | null;
  result: 'PASS' | 'FAIL' | 'PENDING'; overridden: boolean; computedResult: string;
  aqlBand: { sampleSize: number; acceptCount: number; rejectCount: number } | null;
  defectRatePct: number | null; remarks: string | null; correctiveAction: string | null;
  correctiveActionClosed: boolean; auditorName: string | null; factoryRepName: string | null;
  defects: Array<{ id: string; category: DefectCategory; qty: number; comment: string | null }>;
}

export function QualityTab({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['quality', order.id],
    queryFn: () => api.quality.list(order.id),
  });

  const close = useMutation({
    mutationFn: (auditId: string) => api.quality.closeCorrectiveAction(auditId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['quality', order.id] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
    },
  });

  if (isLoading) return <Spinner />;
  const audits = (data?.data ?? []) as unknown as Audit[];
  const openFailure = audits.find((a) => a.result === 'FAIL' && !a.correctiveActionClosed);

  return (
    <div className="space-y-4 p-5">
      {openFailure && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-red-900">
                This order is quality-blocked
              </p>
              <p className="mt-0.5 text-xs text-red-800">
                The audit of {fmtDate(openFailure.inspectionDate)} failed and the corrective action is
                still open. Packing and shipping stay blocked until it is closed.
              </p>
              {openFailure.correctiveAction && (
                <pre className="mt-2 whitespace-pre-wrap rounded bg-white/70 px-2 py-1.5 text-2xs leading-relaxed text-red-900">
                  {openFailure.correctiveAction}
                </pre>
              )}
              {can('quality:audit') && (
                <button onClick={() => close.mutate(openFailure.id)} className="btn-primary btn-sm mt-2">
                  Close corrective action
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Audits" value={audits.length} />
        <StatTile label="Passed" value={audits.filter((a) => a.result === 'PASS').length} tone="emerald" />
        <StatTile label="Failed" value={audits.filter((a) => a.result === 'FAIL').length} tone={audits.some((a) => a.result === 'FAIL') ? 'red' : 'neutral'} />
        <StatTile label="Pass rate (pieces)" value={<Num value={order.qualityPassPct} kind="percent" />} />
      </div>

      <Card>
        <CardHeader
          title="Inspections"
          subtitle="R02 Final Inspection and Audit — verdict from the AQL table on the sheet"
          action={
            can('quality:audit') && (
              <button onClick={() => setAdding(true)} className="btn-primary btn-sm">
                <Plus className="h-3.5 w-3.5" /> Record inspection
              </button>
            )
          }
        />
        {audits.length === 0 ? (
          <EmptyState
            title="No inspection recorded"
            detail="The quality manager records the final inspection here. The sample size and accept/reject thresholds come from the AQL table, so the verdict is calculated rather than judged."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {audits.map((a) => (
              <li key={a.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={clsx(
                        'chip',
                        a.result === 'PASS' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                        : a.result === 'FAIL' ? 'bg-red-50 text-red-700 ring-red-600/20'
                        : 'bg-ink-100 text-ink-600 ring-ink-500/20',
                      )}>
                        {a.result === 'PASS' ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                        {a.result}
                      </span>
                      <span className="text-sm font-medium text-ink-900">
                        {a.auditType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
                      </span>
                      {a.overridden && (
                        <span className="chip bg-amber-50 text-amber-800 ring-amber-600/20">
                          Overridden — AQL said {a.computedResult}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {fmtDate(a.inspectionDate)}
                      {a.auditorName && ` · ${a.auditorName}`}
                      {a.factoryRepName && ` · factory rep ${a.factoryRepName}`}
                    </p>
                  </div>

                  <div className="flex gap-5 text-xs">
                    <Stat label="Available" value={<Num value={a.availableQty} />} />
                    <Stat label="Sample" value={<Num value={a.sampleSize} />} />
                    <Stat label="Defects" value={<Num value={a.rejectedQty} />} />
                    <Stat
                      label="AQL accept / reject"
                      value={a.aqlBand ? `${a.aqlBand.acceptCount} / ${a.aqlBand.rejectCount}` : '—'}
                    />
                    <Stat label="Defect rate" value={<Num value={a.defectRatePct} kind="percent" places={1} />} />
                  </div>
                </div>

                {a.defects.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {a.defects.map((d) => (
                      <span key={d.id} className="chip bg-ink-100 text-ink-700 ring-ink-500/20" title={d.comment ?? undefined}>
                        {DEFECT_LABEL[d.category]}: {d.qty}
                      </span>
                    ))}
                  </div>
                )}

                {a.remarks && (
                  <p className="mt-2 rounded border border-ink-200 bg-ink-50 px-2.5 py-1.5 text-xs text-ink-700">
                    {a.remarks}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AuditModal
        open={adding} order={order}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          void qc.invalidateQueries({ queryKey: ['quality', order.id] });
          void qc.invalidateQueries({ queryKey: ['order', order.id] });
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-right">
      <p className="text-2xs uppercase tracking-wider text-ink-400">{label}</p>
      <p className="tnum mt-0.5 font-semibold text-ink-800">{value}</p>
    </div>
  );
}

function AuditModal({
  open, order, onClose, onDone,
}: {
  open: boolean; order: OrderDetailDto; onClose: () => void; onDone: () => void;
}) {
  const producedQty = order.production.producedQty || order.funnel.find((f) => f.ledger === 'CUT')?.qty || 0;
  const [availableQty, setAvailableQty] = useState(String(producedQty));
  const [defects, setDefects] = useState<Record<string, number>>({});
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: aql } = useQuery({
    queryKey: ['aql', availableQty],
    queryFn: () => api.quality.aql(Number(availableQty)),
    enabled: open && Number(availableQty) > 0,
  });

  const band = aql?.match as { sampleSize: number; acceptCount: number; rejectCount: number } | null | undefined;
  const totalDefects = Object.values(defects).reduce((a, b) => a + b, 0);
  const predicted = band ? (totalDefects >= band.rejectCount ? 'FAIL' : 'PASS') : null;

  const save = useMutation({
    mutationFn: () =>
      api.quality.record(order.id, {
        availableQty: Number(availableQty),
        defects: Object.entries(defects).filter(([, q]) => q > 0).map(([category, qty]) => ({ category, qty })),
        remarks: remarks || undefined,
      }),
    onSuccess: () => { setDefects({}); setRemarks(''); setError(null); onDone(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not record the inspection.'),
  });

  return (
    <Modal
      open={open} onClose={onClose} wide
      title="Record final inspection"
      subtitle="R02 — sample size and thresholds come from the AQL table"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!availableQty || save.isPending} className="btn-primary">
            {save.isPending ? 'Recording…' : `Record as ${predicted ?? 'pending'}`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote error={new Error(error)} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Available quantity to inspect">
            <input
              type="number" min={1} value={availableQty}
              onChange={(e) => setAvailableQty(e.target.value)} className="input"
            />
          </Field>
          <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">AQL band</p>
            {band ? (
              <p className="mt-1 text-sm text-ink-800">
                Sample <strong>{band.sampleSize}</strong> · accept up to <strong>{band.acceptCount}</strong> ·
                reject at <strong>{band.rejectCount}</strong>
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-500">Enter a quantity of 16 or more.</p>
            )}
          </div>
        </div>

        <div>
          <p className="label">Defects found in the sample</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {DEFECT_CATEGORIES.map((c) => (
              <div key={c} className="flex items-center gap-2">
                <label className="flex-1 truncate text-sm text-ink-700">{DEFECT_LABEL[c]}</label>
                <input
                  type="number" min={0} value={defects[c] ?? ''}
                  onChange={(e) => setDefects({ ...defects, [c]: Number(e.target.value) || 0 })}
                  className="input tnum w-20 text-center"
                />
              </div>
            ))}
          </div>
        </div>

        <div className={clsx(
          'rounded-md border px-3 py-2.5',
          predicted === 'FAIL' ? 'border-red-200 bg-red-50'
          : predicted === 'PASS' ? 'border-emerald-200 bg-emerald-50'
          : 'border-ink-200 bg-ink-50',
        )}>
          <p className="text-sm font-medium">
            {totalDefects} defect{totalDefects === 1 ? '' : 's'} recorded ·{' '}
            <span className={predicted === 'FAIL' ? 'text-red-700' : predicted === 'PASS' ? 'text-emerald-700' : ''}>
              verdict: {predicted ?? 'pending'}
            </span>
          </p>
          {predicted === 'FAIL' && (
            <p className="mt-1 text-xs text-red-800">
              Recording this creates an urgent corrective-action task for the production manager and
              blocks the order until it is closed.
            </p>
          )}
        </div>

        <Field label="Remarks">
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="input" />
        </Field>
      </div>
    </Modal>
  );
}
