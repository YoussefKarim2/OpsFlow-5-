/**
 * Files, filed where they belong.
 *
 * Every attachment already carries the document type it was filed under, and
 * the API has always returned it — but the only place in the app that could
 * upload or show one was the customer-reference step. So a proforma invoice
 * attached to an order lived in a general filing cabinet, three tabs away from
 * the Proforma Invoice screen it belonged to, and the screen that needed it
 * showed nothing.
 *
 * This panel is that screen's own drawer: it uploads with the right type
 * already set, and lists only what was filed under it. Dropped into each tab,
 * the same file appears in the place the work is done — and nowhere does a
 * coordinator have to remember which of fifteen document types they chose.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, FileText, Image as ImageIcon, ExternalLink, Trash2 } from 'lucide-react';
import { fmtDate, type AttachmentDto } from '@opsflow/shared';
import { api, openFile, fetchFileUrl, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, EmptyState, Spinner, clsx, useToast } from './ui';

const isImage = (mime: string): boolean => mime.startsWith('image/');

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AttachmentsPanel({
  orderId, documentType, stageKey, title, detail, accept,
}: {
  orderId: string;
  /** What anything uploaded here is filed as, and what is listed back. */
  documentType: string;
  /** The step it belongs to, so the filing cabinet can say where it arrived. */
  stageKey?: string;
  title?: string;
  detail?: string;
  accept?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // One query per order, shared by every panel on the page — the same key the
  // Documents tab uses, so uploading here refreshes there too.
  const { data, isLoading } = useQuery({
    queryKey: ['attachments', orderId],
    queryFn: () => api.orders.attachments(orderId),
  });

  const docs = (data?.data ?? []).filter((d) => d.documentType === documentType);

  const upload = useMutation({
    mutationFn: (file: File) =>
      api.steps.upload(orderId, file, documentType, stageKey as never),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['attachments', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      toast.success(`"${r.data.fileName}" attached`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not attach that file.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.steps.removeAttachment(orderId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['attachments', orderId] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
    },
    onError: (e) => toast.error(e),
  });

  const open = useMutation({
    mutationFn: (d: AttachmentDto) => openFile(d.downloadUrl),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not open that file.'),
  });

  const onFiles = (files: FileList | null) => {
    if (files?.[0]) upload.mutate(files[0]);
  };

  const editable = can('order:edit');

  if (isLoading) return <Spinner />;

  return (
    <Card>
      <div className="card-header">
        <h3 className="card-title">{title ?? 'Attached files'}</h3>
        <span className="text-xs text-ink-500">
          {docs.length} file{docs.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="space-y-3 p-4">
        {docs.length === 0 ? (
          <EmptyState
            title="Nothing attached here yet"
            detail={detail ?? 'Anything attached here is filed against this step and appears on the Documents tab too.'}
          />
        ) : (
          <ul className="divide-y divide-ink-100 rounded border border-ink-200">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                {isImage(d.mimeType)
                  ? <ImageIcon className="h-4 w-4 shrink-0 text-ink-400" />
                  : <FileText className="h-4 w-4 shrink-0 text-ink-400" />}
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium text-accent-700 hover:underline"
                  onClick={() => open.mutate(d)}
                  title="Open this file"
                >
                  {d.fileName}
                </button>
                <span className="shrink-0 text-2xs text-ink-500">
                  {d.version > 1 && `v${d.version} · `}{sizeOf(d.sizeBytes)} · {d.uploadedByName} · {fmtDate(d.createdAt)}
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-sm shrink-0"
                  onClick={() => open.mutate(d)}
                  title="Open in a new tab"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
                {editable && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm shrink-0"
                    title="Remove this file"
                    onClick={() => { if (confirm(`Remove "${d.fileName}"?`)) remove.mutate(d.id); }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {editable && (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
              className={clsx(
                'flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-4 text-center text-sm transition-colors',
                dragging ? 'border-accent-400 bg-accent-50' : 'border-ink-300 bg-ink-50 hover:border-ink-400',
              )}
            >
              <Upload className="h-4 w-4 text-ink-400" />
              <span className="font-medium text-ink-700">
                {upload.isPending ? 'Uploading…' : 'Drop a file here, or click to choose one'}
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept={accept ?? '.pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.docx,.doc,.txt,.csv'}
              onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
            />
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * An <img> for a file the API protects.
 *
 * A plain `src` cannot carry the bearer token, so every reference image in the
 * app rendered as a broken icon. This fetches the bytes the way the rest of the
 * app fetches anything and points the tag at the result, revoking the object
 * URL on unmount so a gallery of photographs does not leak them.
 */
export function AuthedImage({
  downloadUrl, alt, className,
}: { downloadUrl: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchFileUrl(downloadUrl)
      .then((u) => {
        url = u;
        if (cancelled) { if (u.startsWith('blob:')) URL.revokeObjectURL(u); return; }
        setSrc(u);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [downloadUrl]);

  if (failed) {
    return (
      <div className={clsx(className, 'flex items-center justify-center bg-ink-50 text-2xs text-ink-400')}>
        Preview unavailable
      </div>
    );
  }
  if (!src) return <div className={clsx(className, 'animate-pulse bg-ink-100')} />;
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
