/**
 * Step 17 — Database.
 *
 * The workbook's `Data-Base` sheet (A20 of its own menu) is the factory's
 * reference lists — fabrics, colours, sizes. In OpsFlow those are reference
 * tables every order reads, so a per-order copy of them would be a duplicate.
 *
 * What this section is instead: where this order came from and what it is made
 * of. The identifiers you would quote in a support conversation, the workbook
 * it was imported from with the cell every field was read out of, and the row
 * counts you would check when something looks missing.
 *
 * Deliberately not "the raw database row". No credentials, no storage keys, no
 * foreign keys into other people's records. §23 asked for internal information
 * without exposing sensitive database information, and the line between them is
 * whether a person could use it to find something they should not see.
 */

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Database, FileSpreadsheet, Info } from 'lucide-react';
import { fmtDate } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, CardHeader, Spinner, EmptyState, clsx } from '../../components/ui';

const CONFIDENCE_TONE: Record<string, string> = {
  HIGH: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  MEDIUM: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  LOW: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  NONE: 'bg-ink-100 text-ink-500 ring-ink-300/40',
};

/** The counts worth showing, in the order somebody would check them. */
const COUNT_LABELS: Array<[string, string]> = [
  ['colors', 'Colours'],
  ['sizes', 'Sizes'],
  ['quantities', 'Quantity cells'],
  ['bomItems', 'BOM lines'],
  ['markers', 'Markers / lays'],
  ['productionRecords', 'Production records'],
  ['externalOperations', 'External operations'],
  ['qualityAudits', 'Quality audits'],
  ['packingLists', 'Packing lists'],
  ['shipments', 'Shipments'],
  ['customInstructions', 'Custom instructions'],
  ['approvals', 'Approvals'],
  ['attachments', 'Documents'],
  ['tasks', 'Workflow tasks'],
  ['stages', 'Order steps'],
  ['notes', 'Notes'],
  ['materialReservations', 'Material reservations'],
  ['materialMovements', 'Stock movements'],
  ['changeEvents', 'Recorded changes'],
];

export function DatabaseTab({ orderId }: { orderId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['order-provenance', orderId],
    queryFn: () => api.orders.provenance(orderId),
  });

  if (isLoading) return <Spinner label="Reading the order's record…" />;
  if (error || !data) return <EmptyState title="Could not read this order's record" />;

  const { order, counts, source } = data;
  const mappings = (source?.mappings ?? []) as Array<{
    field: string; label: string; sheet: string | null; cell: string | null;
    sampleValue: string | null; resolved: boolean;
    confidence?: string; interpretation?: string | null;
  }>;
  const sheets = (source?.sheets ?? []) as Array<{ name: string; rowCount?: number; columnCount?: number }>;

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start gap-2 rounded-md border border-ink-200 bg-white px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
        <p className="text-xs text-ink-600">
          Reference information about the order itself. Nothing here is entered or edited, and this
          step never counts towards the order's progress — reading it does not move an order along.
        </p>
      </div>

      {/* ── Identifiers ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Identifiers" subtitle="What to quote when something has to be traced" />
        <dl className="grid grid-cols-1 gap-px bg-ink-200 sm:grid-cols-2">
          <Row label="PO number" value={order.poNumber} mono />
          <Row label="Order name" value={order.orderName} />
          <Row label="Order ID" value={order.id} mono />
          <Row label="Client" value={order.clientName} />
          <Row label="Client ID" value={order.clientId} mono />
          <Row label="Season" value={order.season} />
          <Row label="Coordinator" value={order.coordinator?.name ?? 'Not assigned'} />
          <Row label="Created" value={fmtDate(order.createdAt)} />
          <Row label="Last modified" value={fmtDate(order.updatedAt)} />
        </dl>
      </Card>

      {/* ── Where it came from ───────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Source"
          subtitle={source ? 'The spreadsheet this order was imported from' : undefined}
        />
        {!source ? (
          <EmptyState
            title="Entered by hand"
            detail="This order was created in OpsFlow rather than imported from a workbook, so there is no source file to trace it to."
          />
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-px bg-ink-200 sm:grid-cols-2">
              <Row
                label="Source workbook"
                value={
                  <span className="flex items-center gap-1.5">
                    <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    {source.fileName}
                  </span>
                }
              />
              <Row label="Imported" value={fmtDate(source.importedAt)} />
              <Row label="Imported by" value={source.importedBy?.name ?? 'Unknown'} />
              <Row label="Import ID" value={source.importId} mono />
              <Row label="Layout recognised as" value={source.profile ?? 'Generic table'} />
              <Row
                label="Match confidence"
                value={source.confidence == null ? 'Not recorded' : `${Math.round(source.confidence * 100)}%`}
              />
            </dl>

            {sheets.length > 0 && (
              <div className="border-t border-ink-100 px-4 py-3">
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Sheets in the file
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {sheets.map((sh) => (
                    <span key={sh.name} className="rounded bg-ink-100 px-2 py-0.5 font-mono text-2xs text-ink-700">
                      {sh.name}
                      {sh.rowCount != null && (
                        <span className="ml-1 text-ink-400">{sh.rowCount}×{sh.columnCount ?? '?'}</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Field provenance ─────────────────────────────────────────────── */}
      {mappings.length > 0 && (
        <Card>
          <CardHeader
            title="Where each field came from"
            subtitle="The sheet and cell every imported value was read out of"
          />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Field</th>
                  <th className="th">Sheet</th>
                  <th className="th">Cell</th>
                  <th className="th">Value read</th>
                  <th className="th">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {mappings.map((m) => (
                  <tr key={m.field} className={clsx(!m.resolved && 'bg-ink-50/60')}>
                    <td className="td text-sm font-medium text-ink-800">{m.label}</td>
                    <td className="td text-xs text-ink-600">{m.sheet ?? '—'}</td>
                    <td className="td font-mono text-2xs text-ink-600">{m.cell ?? '—'}</td>
                    <td className={clsx('td text-sm', m.sampleValue ? 'text-ink-900' : 'italic text-ink-400')}>
                      {m.sampleValue ?? 'not found'}
                    </td>
                    <td className="td">
                      <span className={clsx('chip', CONFIDENCE_TONE[m.confidence ?? 'NONE'])}>
                        {m.confidence ?? 'NONE'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-ink-100 bg-ink-50 px-4 py-2 text-2xs text-ink-500">
            A field marked <strong>not found</strong> was genuinely absent from the workbook. It was
            left empty rather than guessed at — see the Order Details step to fill it in.
          </p>
        </Card>
      )}

      {/* ── What it is made of ───────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Records" subtitle="What this order holds, by table" />
        <div className="grid grid-cols-2 gap-px bg-ink-200 sm:grid-cols-3 lg:grid-cols-4">
          {COUNT_LABELS.map(([key, label]) => (
            <div key={key} className="bg-white px-3 py-2.5">
              <p className="text-2xs text-ink-500">{label}</p>
              <p className="tnum mt-0.5 text-lg font-semibold text-ink-900">
                {(counts as Record<string, number>)[key] ?? 0}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* ── The advisory cache ───────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Cached roll-up"
          subtitle="Advisory only — every screen recomputes the real figures"
        />
        <dl className="grid grid-cols-1 gap-px bg-ink-200 sm:grid-cols-3">
          <Row label="Cached status" value={order.cachedStatus ?? 'Not set'} />
          <Row label="Cached progress" value={order.cachedProgressPct == null ? 'Not set' : `${order.cachedProgressPct}%`} />
          <Row label="Cached stage" value={order.cachedStageKey ?? 'Not set'} />
        </dl>
        <p className="flex items-start gap-2 border-t border-ink-100 bg-ink-50 px-4 py-2 text-2xs text-ink-500">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
          <span>
            These three exist so the orders list can sort quickly. If one disagrees with what the
            order actually shows, the order is right and the cache is stale — nothing in OpsFlow
            reads these to make a decision.
          </span>
        </p>
      </Card>

      <p className="flex items-center gap-1.5 px-1 text-2xs text-ink-400">
        <Database className="h-3 w-3" />
        Reference information only. Nothing on this page can be edited.
      </p>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="bg-white px-4 py-2.5">
      <dt className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className={clsx('mt-0.5 text-sm text-ink-900', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}
