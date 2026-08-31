/**
 * Every document on the order, of every type.
 *
 * Uploading happens on the step the document belongs to — the customer's own
 * paperwork on step 1, a quality report on the audit step. This screen is the
 * filing cabinet: one list, filterable, for when you know the file exists but
 * not which step it arrived on.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { fmtDate } from '@opsflow/shared';
import { api } from '../../lib/api';
import { Card, Spinner, EmptyState } from '../../components/ui';

const TYPES = [
  'ALL', 'CUSTOMER_PO', 'CUSTOMER_REFERENCE', 'ARTWORK', 'TECH_PACK', 'FABRIC_PHOTO',
  'SAMPLE_PHOTO', 'MARKER_FILE', 'BOM', 'EXTERNAL_OP_DOC', 'PACKING_LIST',
  'QUALITY_REPORT', 'INVOICE', 'SHIPPING_DOC', 'PROFORMA_INVOICE', 'OTHER',
];

export function DocumentsTab({ orderId }: { orderId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['attachments', orderId],
    queryFn: () => api.orders.attachments(orderId),
  });

  const [type, setType] = useState<string>('ALL');
  const docs = data?.data ?? [];
  const filtered = type === 'ALL' ? docs : docs.filter((d) => d.documentType === type);

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4 p-5">
      <Card>
        <div className="card-header">
          <h3 className="card-title">Documents</h3>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input w-56">
            {TYPES.map((t) => (
              <option key={t} value={t}>{t === 'ALL' ? 'All document types' : t.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title={type === 'ALL' ? 'No documents yet' : 'Nothing of that type'}
            detail={
              'Customer POs, artwork, tech packs, marker files, packing lists, quality reports and ' +
              'shipping documents attach on the step they belong to, and all appear here.'
            }
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">File</th>
                <th className="th">Type</th>
                <th className="th">Step</th>
                <th className="th">Version</th>
                <th className="th">Uploaded by</th>
                <th className="th">Date</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {filtered.map((d) => (
                <tr key={d.id}>
                  <td className="td font-medium text-ink-800">{d.fileName}</td>
                  <td className="td text-xs">{d.documentType.replace(/_/g, ' ')}</td>
                  <td className="td text-xs">{d.stageKey ? d.stageKey.replace(/_/g, ' ') : '—'}</td>
                  <td className="td tnum text-xs">v{d.version}</td>
                  <td className="td text-xs">{d.uploadedByName}</td>
                  <td className="td text-xs">{fmtDate(d.createdAt)}</td>
                  <td className="td text-right">
                    <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">
                      Open <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
