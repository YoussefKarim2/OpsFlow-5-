/**
 * Step 1 — Customer Reference.
 *
 * The workbook's first sheet is a picture of what the customer actually sent:
 * their PO, the artwork, the tech pack. Until now OpsFlow could list documents
 * but not accept one, which made step 1 the only step nobody could ever finish.
 */

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, ExternalLink, Trash2, FileText, Image as ImageIcon } from 'lucide-react';
import { fmtDate } from '@opsflow/shared';
import { api, type AttachmentDto } from '../../lib/api';
import { Card, Spinner, EmptyState, ConfirmDialog, Field, clsx, useToast } from '../../components/ui';

/**
 * The document types that belong to step 1. The full list lives on the
 * Documents tab; a coordinator standing on the customer reference step should
 * not have to scroll past "Shipping doc" to find "Artwork".
 */
const REFERENCE_TYPES = [
  { value: 'CUSTOMER_PO', label: "The customer's purchase order" },
  { value: 'CUSTOMER_REFERENCE', label: 'Reference image or sketch' },
  { value: 'ARTWORK', label: 'Artwork / print file' },
  { value: 'TECH_PACK', label: 'Tech pack' },
  { value: 'FABRIC_PHOTO', label: 'Fabric photo or swatch' },
  { value: 'SAMPLE_PHOTO', label: 'Sample photo' },
  { value: 'OTHER', label: 'Something else' },
] as const;

const isImage = (mime: string) => mime.startsWith('image/');

export function CustomerReferenceTab({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>('CUSTOMER_PO');
  const [dragging, setDragging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AttachmentDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['attachments', orderId],
    queryFn: () => api.orders.attachments(orderId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['attachments', orderId] });
    // The step completes on the first attachment, so the rail moves too.
    qc.invalidateQueries({ queryKey: ['order-steps', orderId] });
  };

  const upload = useMutation({
    mutationFn: (file: File) => api.steps.upload(orderId, file, docType, 'CUSTOMER_ORDER_REF'),
    onSuccess: (res) => {
      refresh();
      toast.success(
        res.data.version > 1
          ? `"${res.data.fileName}" saved as version ${res.data.version}`
          : `"${res.data.fileName}" attached`,
      );
    },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.steps.removeAttachment(orderId, id),
    onSuccess: () => { refresh(); setConfirmDelete(null); toast.success('Document removed'); },
    onError: (e) => toast.error(e),
  });

  const docs = data?.data ?? [];
  const images = docs.filter((d) => isImage(d.mimeType));

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // One at a time, deliberately: each upload carries a document type, and a
    // batch would have to guess the type for all of them.
    upload.mutate(files[0]);
    if (inputRef.current) inputRef.current.value = '';
  };

  if (isLoading) return <Spinner label="Loading documents…" />;

  return (
    <div className="space-y-4 p-5">
      <Card>
        <div className="card-header">
          <h3 className="card-title">Attach what the customer sent</h3>
        </div>
        <div className="space-y-3 px-4 py-4">
          <Field
            label="What is this document?"
            hint="Chosen before the file, so nothing is ever filed as “Other” by accident."
          >
            <select className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {REFERENCE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
            className={clsx(
              'flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors',
              dragging ? 'border-accent-400 bg-accent-50' : 'border-ink-300 bg-ink-50 hover:border-ink-400',
            )}
          >
            <Upload className="h-6 w-6 text-ink-400" />
            <p className="mt-2 text-sm font-medium text-ink-800">
              {upload.isPending ? 'Uploading…' : 'Drop a file here, or click to choose one'}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              PDF, images, Word, Excel or text. Up to 20 MB.
            </p>
          </div>

          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.docx,.doc,.txt,.csv"
            onChange={(e) => onFiles(e.target.files)}
          />

          <p className="text-2xs text-ink-500">
            Re-uploading a file with the same name and type saves a new version rather than a
            duplicate. An identical file is refused, so nothing is silently replaced by itself.
          </p>
        </div>
      </Card>

      {images.length > 0 && (
        <Card>
          <div className="card-header"><h3 className="card-title">Reference images</h3></div>
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((d) => (
              <a
                key={d.id}
                href={d.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="group overflow-hidden rounded border border-ink-200 bg-white"
              >
                <img
                  src={d.downloadUrl}
                  alt={d.fileName}
                  className="h-32 w-full bg-ink-50 object-contain"
                  loading="lazy"
                />
                <span className="block truncate border-t border-ink-100 px-2 py-1 text-2xs text-ink-600 group-hover:text-ink-900">
                  {d.fileName}
                </span>
              </a>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="card-header">
          <h3 className="card-title">Everything attached to this order</h3>
          <span className="text-xs text-ink-500">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
        </div>
        {docs.length === 0 ? (
          <EmptyState
            title="Nothing attached yet"
            detail="Step 1 is finished as soon as the customer's own paperwork is here."
          />
        ) : (
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">File</th>
                <th className="th">Type</th>
                <th className="th">Version</th>
                <th className="th">Uploaded by</th>
                <th className="th">Date</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="td">
                    <span className="flex items-center gap-1.5 font-medium text-ink-800">
                      {isImage(d.mimeType)
                        ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                        : <FileText className="h-3.5 w-3.5 shrink-0 text-ink-400" />}
                      {d.fileName}
                    </span>
                  </td>
                  <td className="td text-xs">{d.documentType.replace(/_/g, ' ')}</td>
                  <td className="td tnum text-xs">v{d.version}</td>
                  <td className="td text-xs">{d.uploadedByName}</td>
                  <td className="td text-xs">{fmtDate(d.createdAt)}</td>
                  <td className="td">
                    <div className="flex justify-end gap-1">
                      <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                      <button
                        className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                        onClick={() => setConfirmDelete(d)}
                        aria-label={`Remove ${d.fileName}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmDialog
        open={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        busy={remove.isPending}
        title="Remove this document?"
        confirmLabel="Remove"
        body={
          <>
            <strong>{confirmDelete?.fileName}</strong> will be deleted from the order and from
            storage. Earlier versions of the same file are not affected.
          </>
        }
      />
    </div>
  );
}
