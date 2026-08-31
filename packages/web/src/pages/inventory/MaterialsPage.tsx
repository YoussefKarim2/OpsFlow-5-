/**
 * Materials — the factory's own stock.
 *
 * The four numbers a store keeper needs are on every row: what is on the shelf,
 * what is promised to orders, what is actually free, and where that sits
 * against the reorder line. The distinction between physical and available is
 * the whole point of the screen, so it is never collapsed into one figure.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, PackagePlus, SlidersHorizontal, RefreshCw } from 'lucide-react';
import {
  MATERIAL_TYPE_LABEL, fmtNumber,
  type MaterialType, type StockStatus,
} from '@opsflow/shared';
import { api, type MaterialRow } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, StatTile, EmptyState, ErrorNote, Field, Modal, Spinner,
  ConfirmDialog, clsx, useToast, useDebounced,
} from '../../components/ui';
import { StockStatusChip, StockBar } from './parts';

export function MaterialsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const [showCreate, setShowCreate] = useState(false);
  const [receiveFor, setReceiveFor] = useState<MaterialRow | null>(null);
  const [adjustFor, setAdjustFor] = useState<MaterialRow | null>(null);
  const [reconciling, setReconciling] = useState(false);

  const typeFilter = params.get('type') ?? '';
  const statusFilter = params.get('status') ?? '';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['inventory', 'materials', debounced, typeFilter, statusFilter],
    queryFn: () => api.inventory.materials({
      q: debounced || undefined,
      type: typeFilter || undefined,
      // "low" from a dashboard tile means everything that is not healthy.
      lowOnly: statusFilter === 'low' ? true : undefined,
      status: statusFilter && statusFilter !== 'low' ? statusFilter : undefined,
    }),
  });

  const { data: meta } = useQuery({ queryKey: ['inventory', 'meta'], queryFn: api.inventory.meta });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const reconcile = useMutation({
    mutationFn: () => api.inventory.reconcile(false),
    onSuccess: (r) => {
      setReconciling(false);
      if (r.drifted.length === 0) {
        toast.success(`All ${r.checked} balances agree with the movement ledger.`);
      } else {
        toast.error(
          `${r.drifted.length} material${r.drifted.length === 1 ? '' : 's'} disagree with the ledger: ` +
          r.drifted.slice(0, 3).map((d) => `${d.materialName} (${d.difference > 0 ? '+' : ''}${d.difference})`).join(', '),
        );
      }
    },
    onError: (e) => { setReconciling(false); toast.error(e); },
  });

  if (isLoading) return <Spinner label="Loading the store…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;

  const rows = data?.data ?? [];
  const s = data?.summary;

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Materials</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Everything the factory holds, and what is already promised to an order.
          </p>
        </div>
        <div className="flex gap-2">
          {can('material:edit') && (
            <button
              className="btn-ghost btn-sm"
              title="Recompute every balance from the movement ledger and report any difference"
              onClick={() => { setReconciling(true); reconcile.mutate(); }}
              disabled={reconciling}
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', reconciling && 'animate-spin')} /> Reconcile
            </button>
          )}
          {can('material:edit') && (
            <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> New material
            </button>
          )}
        </div>
      </div>

      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Total materials" value={s.totalMaterials} tone="neutral" onClick={() => setFilter('status', '')} />
          <StatTile label="Low stock" value={s.lowCount} tone={s.lowCount > 0 ? 'amber' : 'neutral'} onClick={() => setFilter('status', 'LOW')} />
          <StatTile label="Out of stock" value={s.outOfStockCount} tone={s.outOfStockCount > 0 ? 'red' : 'neutral'} onClick={() => setFilter('status', 'OUT_OF_STOCK')} />
          <StatTile
            label="Over-reserved" value={s.overReservedCount}
            tone={s.overReservedCount > 0 ? 'red' : 'neutral'}
            sub="promised more than exists"
            onClick={() => setFilter('status', 'OVER_RESERVED')}
          />
          <StatTile
            label="Stock value"
            value={s.totalValue == null ? '—' : `$${fmtNumber(s.totalValue, { places: 0 })}`}
            tone="neutral"
            sub={s.reservedValue == null ? undefined : `$${fmtNumber(s.reservedValue, { places: 0 })} reserved`}
          />
        </div>
      )}

      <Card>
        <CardHeader
          title="Stock"
          subtitle={`${rows.length} material${rows.length === 1 ? '' : 's'}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 text-ink-400" />
              <select className="input w-40" value={typeFilter} onChange={(e) => setFilter('type', e.target.value)}>
                <option value="">All types</option>
                {(meta?.types ?? []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <select className="input w-36" value={statusFilter} onChange={(e) => setFilter('status', e.target.value)}>
                <option value="">Any status</option>
                <option value="low">Needs attention</option>
                <option value="OK">Good</option>
                <option value="LOW">Low</option>
                <option value="OUT_OF_STOCK">Out of stock</option>
                <option value="OVER_RESERVED">Over-reserved</option>
              </select>
              <input
                className="input w-52"
                placeholder="Search name, code, supplier…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          }
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No materials match"
            detail={search || typeFilter || statusFilter
              ? 'Try clearing a filter.'
              : 'Add the fabrics, trims and packaging the factory holds.'}
            action={can('material:edit') && !search && !typeFilter && !statusFilter
              ? <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>Add the first material</button>
              : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Material</th>
                  <th className="th">Type</th>
                  <th className="th text-right">Physical</th>
                  <th className="th text-right">Reserved</th>
                  <th className="th text-right">Available</th>
                  <th className="th w-36">Against minimum</th>
                  <th className="th">Status</th>
                  {can('material:issue') && <th className="th text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((m) => (
                  <tr key={m.id} className="hover:bg-ink-50/60">
                    <td className="td">
                      <Link to={`/inventory/materials/${m.id}`} className="block min-w-0">
                        <span className="font-medium text-ink-900 hover:text-accent-700">{m.name}</span>
                        <span className="block text-2xs text-ink-500">
                          {m.code ? <code className="text-ink-500">{m.code}</code> : null}
                          {m.code && m.supplierName ? ' · ' : ''}
                          {m.supplierName}
                        </span>
                      </Link>
                    </td>
                    <td className="td text-xs text-ink-600">
                      {MATERIAL_TYPE_LABEL[m.type as MaterialType] ?? m.type}
                    </td>
                    <td className="td tnum text-right">{fmtNumber(m.position.physicalQty, { places: 0 })} <span className="text-2xs text-ink-400">{m.unit}</span></td>
                    <td className="td tnum text-right text-ink-600">
                      {m.position.reservedQty > 0 ? fmtNumber(m.position.reservedQty, { places: 0 }) : <span className="text-ink-300">—</span>}
                    </td>
                    <td className={clsx(
                      'td tnum text-right font-semibold',
                      m.position.availableQty < 0 ? 'text-red-600' : 'text-ink-900',
                    )}>
                      {fmtNumber(m.position.availableQty, { places: 0 })}
                    </td>
                    <td className="td"><StockBar position={m.position} /></td>
                    <td className="td"><StockStatusChip status={m.position.status as StockStatus} /></td>
                    {can('material:issue') && (
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <button className="btn-ghost btn-sm" onClick={() => setReceiveFor(m)}>Receive</button>
                          <button className="btn-ghost btn-sm" onClick={() => setAdjustFor(m)}>Adjust</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateMaterialModal
        open={showCreate}
        types={meta?.types ?? []}
        units={meta?.units ?? []}
        onClose={() => setShowCreate(false)}
        onCreated={(name) => {
          setShowCreate(false);
          qc.invalidateQueries({ queryKey: ['inventory'] });
          toast.success(`Added ${name} to the catalogue.`);
        }}
      />

      <ReceiveModal
        material={receiveFor}
        onClose={() => setReceiveFor(null)}
        onDone={() => {
          setReceiveFor(null);
          qc.invalidateQueries({ queryKey: ['inventory'] });
          toast.success('Stock received.');
        }}
      />

      <AdjustModal
        material={adjustFor}
        onClose={() => setAdjustFor(null)}
        onDone={() => {
          setAdjustFor(null);
          qc.invalidateQueries({ queryKey: ['inventory'] });
          toast.success('Stock adjusted.');
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

interface TypeMeta { value: string; label: string; fields: readonly string[] }

function CreateMaterialModal({
  open, types, units, onClose, onCreated,
}: {
  open: boolean;
  types: TypeMeta[];
  units: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [form, setForm] = useState({
    code: '', name: '', type: 'FABRIC', unit: 'M',
    colorName: '', composition: '', gsm: '', widthCm: '', sizeLabel: '',
    supplierName: '', minimumQty: '', unitCostUsd: '', notes: '',
  });
  const [error, setError] = useState<unknown>(null);

  // Only the fields this type actually uses — §8's "do not force irrelevant
  // fields on every material type".
  const relevant = new Set(types.find((t) => t.value === form.type)?.fields ?? []);

  const create = useMutation({
    mutationFn: () => api.inventory.createMaterial({
      code: form.code || undefined,
      name: form.name,
      type: form.type,
      unit: form.unit,
      colorName: relevant.has('colorName') && form.colorName ? form.colorName : undefined,
      composition: relevant.has('composition') && form.composition ? form.composition : undefined,
      gsm: relevant.has('gsm') && form.gsm ? Number(form.gsm) : undefined,
      widthCm: relevant.has('widthCm') && form.widthCm ? Number(form.widthCm) : undefined,
      sizeLabel: relevant.has('sizeLabel') && form.sizeLabel ? form.sizeLabel : undefined,
      supplierName: form.supplierName || undefined,
      minimumQty: form.minimumQty ? Number(form.minimumQty) : undefined,
      unitCostUsd: form.unitCostUsd ? Number(form.unitCostUsd) : undefined,
      notes: form.notes || undefined,
    }),
    onSuccess: () => onCreated(form.name),
    onError: setError,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New material"
      subtitle="Stock is added afterwards, as a receipt — so every quantity has a movement behind it."
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={create.isPending}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => create.mutate()}
            disabled={create.isPending || form.name.trim().length < 2}
          >
            {create.isPending ? 'Saving…' : 'Create material'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Code" hint="Your own reference. Optional, but must be unique.">
            <input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </Field>
          <Field label="Type">
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Unit" hint="Cannot be changed once stock has moved.">
            <select className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
              {units.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>

          {relevant.has('colorName') && (
            <Field label="Colour">
              <input className="input" value={form.colorName} onChange={(e) => setForm({ ...form, colorName: e.target.value })} />
            </Field>
          )}
          {relevant.has('composition') && (
            <Field label="Composition">
              <input className="input" placeholder="100% Cotton" value={form.composition} onChange={(e) => setForm({ ...form, composition: e.target.value })} />
            </Field>
          )}
          {relevant.has('gsm') && (
            <Field label="GSM">
              <input className="input" type="number" value={form.gsm} onChange={(e) => setForm({ ...form, gsm: e.target.value })} />
            </Field>
          )}
          {relevant.has('widthCm') && (
            <Field label="Width (cm)">
              <input className="input" type="number" step="0.1" value={form.widthCm} onChange={(e) => setForm({ ...form, widthCm: e.target.value })} />
            </Field>
          )}
          {relevant.has('sizeLabel') && (
            <Field label="Size">
              <input className="input" value={form.sizeLabel} onChange={(e) => setForm({ ...form, sizeLabel: e.target.value })} />
            </Field>
          )}
          {relevant.has('supplierName') && (
            <Field label="Supplier">
              <input className="input" value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} />
            </Field>
          )}

          <Field label="Minimum stock" hint="Below this, the material is flagged as low. Leave blank to skip.">
            <input className="input" type="number" step="0.01" value={form.minimumQty} onChange={(e) => setForm({ ...form, minimumQty: e.target.value })} />
          </Field>
          <Field label="Unit cost (USD)">
            <input className="input" type="number" step="0.0001" value={form.unitCostUsd} onChange={(e) => setForm({ ...form, unitCostUsd: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes">
          <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function ReceiveModal({
  material, onClose, onDone,
}: {
  material: MaterialRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState('');
  const [batchLot, setBatch] = useState('');
  const [reference, setReference] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [error, setError] = useState<unknown>(null);

  const receive = useMutation({
    mutationFn: () => api.inventory.receive({
      materialId: material!.id,
      qty: Number(qty),
      batchLot: batchLot || undefined,
      reference: reference || undefined,
      unitCostUsd: unitCost ? Number(unitCost) : undefined,
    }),
    onSuccess: () => { setQty(''); setBatch(''); setReference(''); setUnitCost(''); setError(null); onDone(); },
    onError: setError,
  });

  const amount = Number(qty);
  const valid = Number.isFinite(amount) && amount > 0;

  return (
    <Modal
      open={material !== null}
      onClose={onClose}
      title="Receive stock"
      subtitle={material ? `${material.name} — currently ${material.position.physicalQty.toLocaleString()} ${material.unit} on hand` : undefined}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={receive.isPending}>Cancel</button>
          <button className="btn-primary" onClick={() => receive.mutate()} disabled={!valid || receive.isPending}>
            <PackagePlus className="h-4 w-4" /> {receive.isPending ? 'Recording…' : 'Record receipt'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error != null && <ErrorNote error={error} />}
        <Field label={`Quantity (${material?.unit ?? ''})`}>
          <input className="input" type="number" step="0.0001" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Batch / lot" hint="Optional, but it is what a recall is traced by.">
            <input className="input" value={batchLot} onChange={(e) => setBatch(e.target.value)} />
          </Field>
          <Field label="Supplier reference">
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <Field label="Unit cost (USD)" hint="Updates the material's cost — a receipt is when the real price is known.">
          <input className="input" type="number" step="0.0001" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        </Field>
        {valid && material && (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
            New balance: <strong className="tnum">{(material.position.physicalQty + amount).toLocaleString()} {material.unit}</strong>
            {' · '}available becomes <strong className="tnum">{(material.position.availableQty + amount).toLocaleString()}</strong>
          </p>
        )}
      </div>
    </Modal>
  );
}

export function AdjustModal({
  material, onClose, onDone,
}: {
  material: MaterialRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);

  const difference = material && counted !== '' ? Number(counted) - material.position.physicalQty : 0;

  const adjust = useMutation({
    mutationFn: () => api.inventory.adjust({
      materialId: material!.id,
      qty: difference,
      reason,
    }),
    onSuccess: () => { setCounted(''); setReason(''); setError(null); onDone(); },
    onError: setError,
  });

  const valid = counted !== '' && Number.isFinite(Number(counted)) && difference !== 0 && reason.trim().length >= 3;

  return (
    <ConfirmDialog
      open={material !== null}
      onCancel={onClose}
      onConfirm={() => adjust.mutate()}
      busy={adjust.isPending}
      tone={difference < 0 ? 'danger' : 'primary'}
      title="Adjust stock to a counted figure"
      confirmLabel="Record adjustment"
      body={
        <div className="space-y-3">
          {error != null && <ErrorNote error={error} />}
          <p className="text-sm text-ink-700">
            The book figure for {material?.name} is{' '}
            <strong className="tnum">{material?.position.physicalQty.toLocaleString()} {material?.unit}</strong>.
            Enter what was actually counted; the difference is recorded as a movement so the
            correction is part of the history rather than a silent overwrite.
          </p>
          <Field label={`Counted quantity (${material?.unit ?? ''})`}>
            <input className="input" type="number" step="0.0001" value={counted} onChange={(e) => setCounted(e.target.value)} />
          </Field>
          {counted !== '' && difference !== 0 && (
            <p className={clsx('text-sm font-medium', difference < 0 ? 'text-red-700' : 'text-emerald-700')}>
              Adjustment of {difference > 0 ? '+' : ''}{difference.toLocaleString()} {material?.unit}
            </p>
          )}
          {counted !== '' && difference === 0 && (
            <p className="text-sm text-ink-500">That matches the book figure — nothing to adjust.</p>
          )}
          <Field label="Reason" hint="Required. An unexplained adjustment is indistinguishable from a mistake.">
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Quarterly stock count, roll re-measured, …"
            />
          </Field>
        </div>
      }
    >
      {!valid && counted !== '' && difference !== 0 && reason.trim().length < 3 && (
        <p className="text-xs text-amber-700">Enter a reason before recording the adjustment.</p>
      )}
    </ConfirmDialog>
  );
}
