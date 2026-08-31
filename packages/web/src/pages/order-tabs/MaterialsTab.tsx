/**
 * The order's material position — §8 to §13, from the order's point of view.
 *
 * The BOM tab next door answers "what has the warehouse handed over?". This one
 * answers the question that actually blocks a cutting floor: **is the material
 * there at all?** They are different questions and they have different answers,
 * which is why this is a separate tab rather than another column.
 *
 * Each line is in one of four states, and each has a different remedy:
 *
 *   Covered      nothing to do
 *   Reservable   the stock exists — one click commits it
 *   Short        the stock does not exist — purchase request, phone call
 *   Unlinked     the line names no catalogue material, so nothing can be checked
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Lock, PackageMinus, Undo2, Link2, ShoppingCart } from 'lucide-react';
import { fmtNumber, type OrderDetailDto, type RequirementResult } from '@opsflow/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, EmptyState, ErrorNote, Field, Modal, ProgressBar, Spinner,
  clsx, useToast,
} from '../../components/ui';

const STATUS_STYLE: Record<RequirementResult['status'], { label: string; chip: string; hint: string }> = {
  COVERED:    { label: 'Covered',    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', hint: 'Reserved or already issued' },
  RESERVABLE: { label: 'Reservable', chip: 'bg-blue-50 text-blue-700 ring-blue-200',          hint: 'In stock but not yet committed to this order' },
  SHORT:      { label: 'Short',      chip: 'bg-red-50 text-red-700 ring-red-200',             hint: 'Not enough stock exists' },
  UNLINKED:   { label: 'Not linked', chip: 'bg-ink-100 text-ink-600 ring-ink-200',            hint: 'No catalogue material, so stock cannot be checked' },
};

export function MaterialsTab({ order }: { order: OrderDetailDto }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [issueFor, setIssueFor] = useState<RequirementResult | null>(null);
  const [returnFor, setReturnFor] = useState<RequirementResult | null>(null);
  const [linkFor, setLinkFor] = useState<RequirementResult | null>(null);

  const { data: position, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory', 'orderPosition', order.id],
    queryFn: () => api.inventory.orderPosition(order.id),
  });

  const refresh = () => qc.invalidateQueries();

  const reserveAll = useMutation({
    mutationFn: () => api.inventory.reserveOrder(order.id),
    onSuccess: (r) => {
      refresh();
      toast.success(
        `Reserved ${r.reserved.length} line${r.reserved.length === 1 ? '' : 's'}` +
        (r.short.length > 0 ? `. ${r.short.length} still short: ${r.short.map((s) => s.materialName).join(', ')}` : '.'),
      );
    },
    onError: (e) => toast.error(e),
  });

  const reserveOne = useMutation({
    mutationFn: (r: RequirementResult) => api.inventory.reserve({
      materialId: r.materialId!,
      orderId: order.id,
      qty: r.reservableQty,
      bomItemId: r.id,
      allowPartial: true,
    }),
    onSuccess: () => { refresh(); toast.success('Reserved.'); },
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <Spinner label="Checking stock…" />;
  if (error) return <div className="p-5"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!position) return null;

  const short = position.requirements.filter((r) => r.status === 'SHORT');
  const reservable = position.requirements.filter((r) => r.status === 'RESERVABLE');

  return (
    <div className="space-y-4 p-5">
      {/* The headline: can this order be made? */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile
          label="Requirements" value={String(position.totalRequirements)}
          detail={`${position.coveredCount} fully covered`}
        />
        <Tile
          label="Reservable now" value={String(position.reservableCount)}
          detail="In stock, not yet committed"
          tone={position.reservableCount > 0 ? 'blue' : undefined}
        />
        <Tile
          label="Short" value={String(position.shortCount)}
          detail="Stock does not exist"
          tone={position.shortCount > 0 ? 'red' : undefined}
        />
        <Tile
          label="Coverage"
          value={position.overallCoveragePct == null ? '—' : `${Math.round(position.overallCoveragePct)}%`}
          detail="Of required quantity secured"
        />
      </div>

      {short.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900">
            Cutting is blocked — {short.length} material{short.length === 1 ? '' : 's'} short
          </p>
          <ul className="mt-2 space-y-1">
            {short.map((r) => (
              <li key={r.id} className="text-sm text-red-800">
                <strong>{r.materialName}</strong> needs {fmtNumber(r.outstandingQty, { places: 0 })} {r.unit},
                {' '}{fmtNumber(r.reservableQty, { places: 0 })} available —{' '}
                <strong>short by {fmtNumber(r.shortQty, { places: 0 })} {r.unit}</strong>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/inventory/materials?status=low" className="btn-secondary btn-sm">
              <ShoppingCart className="h-3.5 w-3.5" /> Review stock
            </Link>
            <Link to="/inventory/reservations" className="btn-ghost btn-sm">
              See who holds the stock
            </Link>
          </div>
        </div>
      )}

      <Card>
        <CardHeader
          title="Material requirements"
          subtitle="Required against what the store actually holds"
          action={
            can('material:edit') && reservable.length > 0 && (
              <button
                className="btn-primary btn-sm"
                onClick={() => reserveAll.mutate()}
                disabled={reserveAll.isPending}
              >
                <Lock className="h-3.5 w-3.5" />
                {reserveAll.isPending ? 'Reserving…' : `Reserve ${reservable.length} available`}
              </button>
            )
          }
        />

        {position.requirements.length === 0 ? (
          <EmptyState
            title="No bill of materials"
            detail="Add BOM lines first, then link them to materials so stock can be checked."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Material</th>
                  <th className="th text-right">Required</th>
                  <th className="th text-right">Reserved</th>
                  <th className="th text-right">Issued</th>
                  <th className="th text-right">Available</th>
                  <th className="th text-right">Short</th>
                  <th className="th w-28">Coverage</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {position.requirements.map((r) => {
                  const style = STATUS_STYLE[r.status];
                  return (
                    <tr key={r.id} className={clsx(r.status === 'SHORT' && 'bg-red-50/40')}>
                      <td className="td">
                        {r.materialId ? (
                          <Link to={`/inventory/materials/${r.materialId}`} className="font-medium text-ink-900 hover:text-accent-700">
                            {r.materialName}
                          </Link>
                        ) : (
                          <span className="text-ink-700">{r.materialName}</span>
                        )}
                      </td>
                      <td className="td tnum text-right">{fmtNumber(r.requiredQty, { places: 0 })} <span className="text-2xs text-ink-400">{r.unit}</span></td>
                      <td className="td tnum text-right text-ink-600">{r.reservedQty > 0 ? fmtNumber(r.reservedQty, { places: 0 }) : <span className="text-ink-300">—</span>}</td>
                      <td className="td tnum text-right text-ink-600">{r.issuedQty > 0 ? fmtNumber(r.issuedQty, { places: 0 }) : <span className="text-ink-300">—</span>}</td>
                      <td className="td tnum text-right text-ink-600">
                        {r.availableQty == null ? <span className="text-ink-300">unknown</span> : fmtNumber(r.availableQty, { places: 0 })}
                      </td>
                      <td className={clsx('td tnum text-right', r.shortQty > 0 ? 'font-semibold text-red-600' : 'text-ink-300')}>
                        {r.shortQty > 0 ? fmtNumber(r.shortQty, { places: 0 }) : '—'}
                      </td>
                      <td className="td">
                        <ProgressBar
                          value={r.coveragePct ?? 0}
                          tone={r.status === 'SHORT' ? 'red' : r.status === 'COVERED' ? 'emerald' : 'accent'}
                        />
                      </td>
                      <td className="td">
                        <span className={clsx('chip', style.chip)} title={style.hint}>{style.label}</span>
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          {can('material:edit') && r.status === 'RESERVABLE' && (
                            <button className="btn-ghost btn-sm" onClick={() => reserveOne.mutate(r)} disabled={reserveOne.isPending}>
                              Reserve
                            </button>
                          )}
                          {can('material:edit') && r.status === 'UNLINKED' && (
                            <button className="btn-ghost btn-sm" onClick={() => setLinkFor(r)}>
                              <Link2 className="h-3.5 w-3.5" /> Link
                            </button>
                          )}
                          {can('material:issue') && r.materialId && (
                            <button className="btn-ghost btn-sm" onClick={() => setIssueFor(r)}>Issue</button>
                          )}
                          {can('material:issue') && r.materialId && r.issuedQty > 0 && (
                            <button className="btn-ghost btn-sm" onClick={() => setReturnFor(r)} title="Return unused material">
                              <Undo2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Expected vs actual consumption — §18. */}
      {order.consumption.length > 0 && (
        <Card>
          <CardHeader
            title="Consumption against plan"
            subtitle={`Based on ${fmtNumber(order.production.producedQty, { places: 0 })} pieces produced`}
          />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Material</th>
                  <th className="th text-right">Per piece</th>
                  <th className="th text-right">Expected</th>
                  <th className="th text-right">Actual</th>
                  <th className="th text-right">Variance</th>
                  <th className="th">Reading</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {order.consumption.map((v, i) => (
                  <tr key={i}>
                    <td className="td">{v.materialName}</td>
                    <td className="td tnum text-right text-ink-600">{v.consumptionPerPiece?.toFixed(4) ?? '—'}</td>
                    <td className="td tnum text-right">{fmtNumber(v.expectedQty, { places: 0 })} <span className="text-2xs text-ink-400">{v.unit}</span></td>
                    <td className="td tnum text-right">{fmtNumber(v.actualQty, { places: 0 })}</td>
                    <td className={clsx(
                      'td tnum text-right font-medium',
                      !v.isSignificant ? 'text-ink-500' : v.direction === 'OVER' ? 'text-red-600' : 'text-amber-700',
                    )}>
                      {v.varianceQty == null ? '—' : `${v.varianceQty > 0 ? '+' : ''}${fmtNumber(v.varianceQty, { places: 0 })}`}
                      {v.variancePct != null && (
                        <span className="ml-1 text-2xs font-normal">({v.variancePct > 0 ? '+' : ''}{Math.round(v.variancePct)}%)</span>
                      )}
                    </td>
                    <td className="td text-xs text-ink-600">
                      {v.direction === 'ON_PLAN' ? 'On plan'
                        : v.direction === 'OVER' ? 'Using more than the BOM allows'
                        : v.direction === 'UNDER' ? 'Using less — the BOM rate may be too high'
                        : 'No consumption rate set'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <IssueModal
        requirement={issueFor}
        orderId={order.id}
        onClose={() => setIssueFor(null)}
        onDone={() => { setIssueFor(null); refresh(); toast.success('Material issued to production.'); }}
      />
      <ReturnModal
        requirement={returnFor}
        orderId={order.id}
        onClose={() => setReturnFor(null)}
        onDone={() => { setReturnFor(null); refresh(); toast.success('Material returned to stock.'); }}
      />
      <LinkModal
        requirement={linkFor}
        onClose={() => setLinkFor(null)}
        onDone={() => { setLinkFor(null); refresh(); toast.success('BOM line linked — stock can now be checked.'); }}
      />
    </div>
  );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'red' | 'blue' }) {
  return (
    <div className={clsx(
      'rounded-lg border p-3',
      tone === 'red' ? 'border-red-200 bg-red-50' : tone === 'blue' ? 'border-blue-200 bg-blue-50' : 'border-ink-200 bg-white',
    )}>
      <p className="label">{label}</p>
      <p className={clsx('tnum text-2xl font-semibold', tone === 'red' ? 'text-red-700' : 'text-ink-900')}>{value}</p>
      <p className="mt-0.5 text-2xs text-ink-500">{detail}</p>
    </div>
  );
}

function IssueModal({
  requirement, orderId, onClose, onDone,
}: {
  requirement: RequirementResult | null; orderId: string; onClose: () => void; onDone: () => void;
}) {
  const [qty, setQty] = useState('');
  const [issuedToName, setIssuedTo] = useState('');
  const [error, setError] = useState<unknown>(null);

  const issue = useMutation({
    mutationFn: () => api.inventory.issue({
      materialId: requirement!.materialId!,
      orderId,
      qty: Number(qty),
      bomItemId: requirement!.id,
      stage: 'FOLLOW_UP',
      issuedToName: issuedToName || undefined,
    }),
    onSuccess: () => { setQty(''); setIssuedTo(''); setError(null); onDone(); },
    onError: setError,
  });

  const amount = Number(qty);
  const valid = Number.isFinite(amount) && amount > 0;

  return (
    <Modal
      open={requirement !== null}
      onClose={onClose}
      title="Issue to production"
      subtitle={requirement ? `${requirement.materialName} — ${fmtNumber(requirement.outstandingQty, { places: 0 })} ${requirement.unit} outstanding` : undefined}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={issue.isPending}>Cancel</button>
          <button className="btn-primary" onClick={() => issue.mutate()} disabled={!valid || issue.isPending}>
            <PackageMinus className="h-4 w-4" /> {issue.isPending ? 'Issuing…' : 'Issue'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}
        <Field
          label={`Quantity (${requirement?.unit ?? ''})`}
          hint="Drawn against this order's reservation first; anything beyond it comes out of free stock."
        >
          <input className="input" type="number" step="0.0001" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
        </Field>
        <Field label="Issued to" hint="The line supervisor or team taking the material.">
          <input className="input" value={issuedToName} onChange={(e) => setIssuedTo(e.target.value)} />
        </Field>
        {requirement && (
          <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
            Reserved for this order: <strong className="tnum">{fmtNumber(requirement.reservedQty, { places: 0 })}</strong> ·
            {' '}free stock: <strong className="tnum">{fmtNumber(requirement.availableQty, { places: 0 })}</strong>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReturnModal({
  requirement, orderId, onClose, onDone,
}: {
  requirement: RequirementResult | null; orderId: string; onClose: () => void; onDone: () => void;
}) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);

  const back = useMutation({
    mutationFn: () => api.inventory.return({
      materialId: requirement!.materialId!,
      orderId,
      qty: Number(qty),
      bomItemId: requirement!.id,
      reason: reason || undefined,
    }),
    onSuccess: () => { setQty(''); setReason(''); setError(null); onDone(); },
    onError: setError,
  });

  const valid = Number(qty) > 0;

  return (
    <Modal
      open={requirement !== null}
      onClose={onClose}
      title="Return unused material"
      subtitle={requirement ? `${requirement.materialName} — ${fmtNumber(requirement.issuedQty, { places: 0 })} ${requirement.unit} issued so far` : undefined}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={back.isPending}>Cancel</button>
          <button className="btn-primary" onClick={() => back.mutate()} disabled={!valid || back.isPending}>
            <Undo2 className="h-4 w-4" /> {back.isPending ? 'Returning…' : 'Return to stock'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}
        <Field label={`Quantity (${requirement?.unit ?? ''})`} hint="Goes back on the shelf, and back onto this order's reservation.">
          <input className="input" type="number" step="0.0001" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
        </Field>
        <Field label="Reason">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Left over after cutting" />
        </Field>
      </div>
    </Modal>
  );
}

function LinkModal({
  requirement, onClose, onDone,
}: {
  requirement: RequirementResult | null; onClose: () => void; onDone: () => void;
}) {
  const [materialId, setMaterialId] = useState('');
  const [error, setError] = useState<unknown>(null);

  const { data } = useQuery({
    queryKey: ['inventory', 'materials', 'all'],
    queryFn: () => api.inventory.materials({}),
    enabled: requirement !== null,
  });

  const link = useMutation({
    mutationFn: () => api.inventory.linkBom(requirement!.id, materialId || null),
    onSuccess: () => { setMaterialId(''); setError(null); onDone(); },
    onError: setError,
  });

  return (
    <Modal
      open={requirement !== null}
      onClose={onClose}
      title="Link to a catalogue material"
      subtitle={requirement ? `“${requirement.materialName}” — measured in ${requirement.unit}` : undefined}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={link.isPending}>Cancel</button>
          <button className="btn-primary" onClick={() => link.mutate()} disabled={!materialId || link.isPending}>
            {link.isPending ? 'Linking…' : 'Link'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}
        <p className="text-sm text-ink-600">
          Once linked, this requirement is checked against real stock, can be reserved, and issuing
          it moves the balance. Only materials held in a compatible unit can be linked.
        </p>
        <Field label="Material">
          <select className="input" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
            <option value="">Choose…</option>
            {(data?.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.unit}) — {fmtNumber(m.position.availableQty, { places: 0 })} available
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
