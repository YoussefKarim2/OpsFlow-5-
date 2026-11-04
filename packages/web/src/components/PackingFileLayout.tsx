/**
 * A packing file, read back.
 *
 * Opens when a spreadsheet or PDF is attached to the Packing tab (and from the
 * Layout button on any packing file already there): the details at the top of
 * the document, the carton table as it was read, the totals, how the colours
 * and sizes line up with the order — and the document itself as it looks, with
 * the rows that were read marked.
 *
 * Read-only on purpose: it shows only what the file says.
 */

import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, Pencil, RotateCcw } from 'lucide-react';
import { api, ApiError, type PackingFileLayoutDto } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PackingCartonEditor } from './PackingCartonEditor';
import { Modal, Card, CardHeader, EmptyState, ErrorNote, Spinner, clsx, useToast } from './ui';

const SHAPE_LABEL: Record<NonNullable<PackingFileLayoutDto['layout']['table']>['shape'], string> = {
  ROW_PER_SIZE: 'one row per size, a mixed carton continuing on the rows below it',
  SIZES_ACROSS: 'sizes across, one row per run of identical cartons',
  ROW_PER_CARTON: 'one row per carton',
};

const fmt = (n: number | null | undefined, places = 0): string =>
  n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: places, minimumFractionDigits: 0 });

function columnLetters(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function PackingFileLayoutModal({
  orderId, attachmentId, fileName, onClose,
}: {
  orderId: string;
  attachmentId: string | null;
  fileName?: string;
  onClose: () => void;
}) {
  const open = attachmentId != null;
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['packing-file-layout', orderId, attachmentId],
    queryFn: () => api.packing.fileLayout(orderId, attachmentId!),
    enabled: open,
    retry: false,
    // Read afresh each time it opens: the reading is cheap, and a cached one
    // kept showing yesterday's numbers after the reader was improved.
    staleTime: 0,
  });
  const { data: matrix } = useQuery({
    queryKey: ['matrix', orderId],
    queryFn: () => api.orders.matrix(orderId),
    enabled: open,
  });
  // Each carton and what is in it, first: that is what an imported packing
  // list is for. The table, the details and the file as it is follow.
  const [view, setView] = useState<'cartons' | 'layout' | 'document'>('cartons');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={`Packing file: ${data?.fileName ?? fileName ?? ''}`}
      subtitle="What the document says, as it was read. Nothing has been changed on the order."
    >
      {isLoading ? <Spinner label="Reading the file…" />
        : error ? <ErrorNote error={error} onRetry={() => void refetch()} />
        : data ? (
          <div className="space-y-4">
            <Summary data={data} />
            <div className="flex gap-1 rounded-md bg-ink-100 p-0.5 text-sm" role="tablist">
              {([['cartons', 'Cartons'], ['layout', 'Table and details'], ['document', 'As in the file']] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={view === k}
                  onClick={() => setView(k)}
                  className={clsx('flex-1 rounded px-3 py-1.5 font-medium', view === k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900')}
                >
                  {label}
                </button>
              ))}
            </div>
            <Issues data={data} />
            {view === 'cartons' ? (
              <>
                <CartonCards data={data} orderId={orderId} attachmentId={attachmentId!} />
                <AgainstOrder data={data} matrix={matrix} />
              </>
            ) : view === 'layout' ? (
              <>
                <Details data={data} />
                <Cartons data={data} />
              </>
            ) : <DocumentPreview data={data} />}
          </div>
        ) : null}
    </Modal>
  );
}

/** Which attached files the reader can lay out. */
export const readablePackingFile = (fileName: string): boolean => /\.(xlsx|xlsm|csv|txt|pdf)$/i.test(fileName);

/**
 * The cartons of the latest packing file, right on the Packing tab — no click
 * needed. Several readable files: a picker chooses which one is shown. The
 * Layout button still opens the full reading (table, details, the file itself).
 */
export function PackingFileCartonsInline({ orderId }: { orderId: string }) {
  const { data: attachments } = useQuery({
    queryKey: ['attachments', orderId],
    queryFn: () => api.orders.attachments(orderId),
  });
  const files = useMemo(
    () => (attachments?.data ?? [])
      .filter((a) => a.documentType === 'PACKING_LIST' && a.available && readablePackingFile(a.fileName))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [attachments],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const current = files.find((f) => f.id === chosen) ?? files[0] ?? null;
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['packing-file-layout', orderId, current?.id ?? null],
    queryFn: () => api.packing.fileLayout(orderId, current!.id),
    enabled: current != null,
    retry: false,
    staleTime: 0,
  });
  const { data: matrix } = useQuery({
    queryKey: ['matrix', orderId],
    queryFn: () => api.orders.matrix(orderId),
    enabled: current != null,
  });
  if (!current) return null;

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-ink-900">Cartons in the packing file</h3>
        <p className="text-xs text-ink-500">Read from {current.fileName}. Nothing has been changed on the order.</p>
      </div>
      <div className="space-y-4">
        {files.length > 1 && (
          <div className="flex flex-wrap gap-1 text-sm" role="tablist">
            {files.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === current.id}
                onClick={() => setChosen(f.id)}
                className={clsx('rounded px-3 py-1 font-medium', f.id === current.id ? 'bg-ink-900 text-white' : 'bg-ink-100 text-ink-600 hover:text-ink-900')}
              >
                {f.fileName}
              </button>
            ))}
          </div>
        )}
        {isLoading ? <Spinner label="Reading the file…" />
          : error ? <ErrorNote error={error} onRetry={() => void refetch()} />
          : data ? (
            <>
              <Summary data={data} />
              <Issues data={data} />
              <CartonCards data={data} orderId={orderId} attachmentId={current.id} />
              <AgainstOrder data={data} matrix={matrix} />
            </>
          ) : null}
      </div>
    </section>
  );
}

function Summary({ data }: { data: PackingFileLayoutDto }) {
  const { layout } = data;
  const t = layout.totals;
  const tiles: Array<[string, string]> = [
    ['Cartons', fmt(t.cartons, 2)],
    ['Pieces', fmt(t.pieces)],
    ['Gross weight', t.grossKg == null ? '—' : `${fmt(t.grossKg, 2)} kg`],
    ['Net weight', t.netKg == null ? '—' : `${fmt(t.netKg, 2)} kg`],
  ];
  const source = layout.fileKind === 'pdf' ? 'PDF'
    : layout.sheets.length > 1 ? `sheet "${layout.sheetName}" (of ${layout.sheets.length})` : `sheet "${layout.sheetName}"`;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-md border border-ink-200 px-3 py-2">
            <div className="text-2xs font-medium uppercase tracking-wide text-ink-500">{label}</div>
            <div className="tnum text-lg font-semibold text-ink-900">{value}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-500">
        Read from the {source}
        {layout.table ? <>, carton table on row {layout.table.headerRow}: {
          // A proforma lists cartons by style, with no carton numbers.
          layout.table.shape === 'ROW_PER_CARTON' && layout.cartons.length > 0 && layout.cartons.every((c) => !c.number)
            ? 'one line per style, with its number of cartons'
            : SHAPE_LABEL[layout.table.shape]
        }.</> : '.'}
      </p>
    </div>
  );
}

/**
 * What needs attention, and nothing else in the way. Warnings — figures that
 * do not add up, cells that read as empty — are shown; notes about how the
 * file was read sit behind one quiet link.
 */
function Issues({ data }: { data: PackingFileLayoutDto }) {
  const [showNotes, setShowNotes] = useState(false);
  const warnings = data.layout.issues.filter((i) => i.level === 'WARNING');
  const notes = data.layout.issues.filter((i) => i.level !== 'WARNING');
  if (warnings.length === 0 && notes.length === 0) return null;
  const issues = [...warnings, ...(showNotes ? notes : [])];
  return (
    <div className="space-y-1">
    {notes.length > 0 && (
      <button type="button" className="text-xs text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline" onClick={() => setShowNotes(!showNotes)}>
        {showNotes ? 'Hide reading notes' : `Reading notes (${notes.length})`}
      </button>
    )}
    <ul className="space-y-1">
      {issues.map((i, n) => (
        <li
          key={n}
          className={clsx('flex items-start gap-2 rounded-md px-3 py-2 text-sm',
            i.level === 'WARNING' ? 'bg-amber-50 text-amber-900' : 'bg-ink-50 text-ink-700')}
        >
          {i.level === 'WARNING' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
    </div>
  );
}

/**
 * One card per carton: its number, and every colour in it with its sizes and
 * pieces. A mixed carton — several colours on the rows under one number — is
 * one card, as it is one box.
 */
function CartonCards({ data, orderId, attachmentId }: { data: PackingFileLayoutDto; orderId: string; attachmentId: string }) {
  const { layout, match } = data;
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const reset = useMutation({
    mutationFn: () => api.packing.resetFileCartons(orderId, attachmentId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['packing-file-layout', orderId, attachmentId] }); toast.success('Back to what the file says'); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not go back to the file'),
  });
  const sizes = layout.table?.sizes ?? [];
  type Part = (typeof layout.cartons)[number] & { index: number };
  const boxes: Array<{ head: Part; parts: Part[] }> = [];
  layout.cartons.forEach((c, index) => {
    const part = { ...c, index };
    if (c.continues && boxes.length > 0) boxes[boxes.length - 1]!.parts.push(part);
    else boxes.push({ head: part, parts: [part] });
  });
  const sizeName = (s: string) => (match.sizes[s] && match.sizes[s] !== s ? match.sizes[s]! : s);
  const canEdit = can('packing:write');
  const actions = canEdit && !editing && (
    <div className="flex shrink-0 gap-1.5">
      {data.edited && (
        <button
          type="button"
          className="btn-ghost btn-sm"
          title="Drop the changes and show what the file says"
          disabled={reset.isPending}
          onClick={() => { if (window.confirm('Drop the changes made to these cartons and show what the file says?')) reset.mutate(); }}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Back to the file
        </button>
      )}
      <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
        <Pencil className="mr-1 h-3.5 w-3.5" /> Edit cartons
      </button>
    </div>
  );
  if (editing) {
    return (
      <Card>
        <CardHeader title="Editing the cartons" subtitle="The file itself is not changed; these corrections are kept beside it." />
        <PackingCartonEditor orderId={orderId} attachmentId={attachmentId} data={data} sizeName={sizeName} onDone={() => setEditing(false)} />
      </Card>
    );
  }
  if (boxes.length === 0) {
    return (
      <Card>
        <CardHeader title="Cartons" action={actions} />
        <EmptyState title="No cartons were found in this file" detail={canEdit ? 'Press “Edit cartons” to type them in, or open “As in the file” to see what it holds.' : 'Open “As in the file” to see what it holds.'} />
      </Card>
    );
  }
  const order = (bySize: Record<string, number>) => [
    ...sizes.filter((s) => bySize[s]),
    ...Object.keys(bySize).filter((s) => !sizes.includes(s) && bySize[s]),
  ];
  return (
    <Card>
      <CardHeader
        title="Cartons"
        subtitle={`${fmt(layout.totals.cartons, 2)} carton${layout.totals.cartons === 1 ? '' : 's'} · ${fmt(layout.totals.pieces)} pcs`
          + (boxes.some((b) => b.parts.length > 1) ? ' · mixed cartons hold several colours' : '')
          + (data.edited ? ` · edited by ${data.edited.by}` : '')}
        action={actions}
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {boxes.map(({ head, parts }) => {
          const pieces = parts.reduce((a, p) => a + p.totalPieces, 0);
          const perBox = parts.reduce((a, p) => a + p.perCarton, 0);
          return (
            <div key={head.index} className="rounded-md border border-ink-200 bg-white">
              <div className="flex items-baseline justify-between gap-2 border-b border-ink-100 bg-ink-50 px-3 py-2">
                <span className="text-sm font-semibold text-ink-900">
                  {head.number ? `Carton ${head.number}` : (head.style ?? 'Cartons')}
                  {head.count > 1 && <span className="ml-1.5 text-xs font-normal text-ink-500">× {fmt(head.count, 2)} cartons</span>}
                </span>
                <span className="tnum text-sm font-semibold text-ink-900">
                  {fmt(head.count > 1 ? perBox : pieces, 2)} pcs{head.count > 1 && <span className="font-normal text-ink-500"> each</span>}
                </span>
              </div>
              <ul className="divide-y divide-ink-100">
                {parts.map((p) => (
                  <li key={p.index} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={clsx('text-sm font-medium', p.colour ? 'text-ink-800' : 'text-amber-700')}>
                        {p.colour ?? 'Colour not stated'}
                      </span>
                      <span className="tnum text-xs text-ink-500">{fmt(p.perCarton, 2)} pcs</span>
                    </div>
                    {p.colour && match.cartonColours[p.index] && match.cartonColours[p.index] !== p.colour && (
                      <div className="text-2xs text-ink-500">{match.cartonColours[p.index]}</div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {order(p.bySize).map((s) => (
                        <span key={s} className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-700">
                          {sizeName(s)} <strong className="tnum text-ink-900">{fmt(p.bySize[s], 2)}</strong>
                        </span>
                      ))}
                      {Object.keys(p.bySize).length === 0 && <span className="text-xs text-ink-400">No sizes given</span>}
                    </div>
                  </li>
                ))}
              </ul>
              {(head.grossKg != null || head.netKg != null || head.measurement) && (
                <div className="flex flex-wrap gap-x-3 border-t border-ink-100 px-3 py-1.5 text-2xs text-ink-500">
                  {head.grossKg != null && <span>G.W. {fmt(head.grossKg, 2)} kg</span>}
                  {head.netKg != null && <span>N.W. {fmt(head.netKg, 2)} kg</span>}
                  {head.measurement && <span>{head.measurement}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Details({ data }: { data: PackingFileLayoutDto }) {
  const { details, titles } = data.layout;
  if (details.length === 0 && titles.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Document details" subtitle={titles.length > 0 ? titles.join(' · ') : 'The labelled fields above the carton table'} />
      {details.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 sm:grid-cols-2">
          {details.map((d, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-2xs font-medium uppercase tracking-wide text-ink-500">{d.label}</dt>
              <dd className={clsx('whitespace-pre-line break-words text-sm', d.value ? 'text-ink-900' : 'text-ink-400')}>{d.value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function Cartons({ data }: { data: PackingFileLayoutDto }) {
  const { layout, match } = data;
  const sizes = layout.table?.sizes ?? [];
  const anyStyle = layout.cartons.some((c) => c.style);
  const anyColour = layout.cartons.some((c) => c.colour);
  const anyMeas = layout.cartons.some((c) => c.measurement);
  const p = layout.printedTotals;
  if (!layout.table) return null;
  return (
    <Card>
      <CardHeader title="Cartons" subtitle={`${layout.cartons.length} row${layout.cartons.length === 1 ? '' : 's'} read · weights are per carton`} />
      {layout.cartons.length === 0 ? (
        <EmptyState title="No cartons under the table" detail="The carton table was found, but nothing is listed under it yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Carton</th>
                <th className="th text-right">Ctns</th>
                {anyStyle && <th className="th">Style</th>}
                {anyColour && <th className="th">Colour</th>}
                {sizes.map((s) => (
                  <th key={s} className="th text-center">
                    <div>{s}</div>
                    {match.sizes[s] && match.sizes[s] !== s && <div className="text-2xs font-normal normal-case text-ink-500">{match.sizes[s]}</div>}
                    {match.sizes[s] === null && <div className="text-2xs font-normal normal-case text-amber-700">not on order</div>}
                  </th>
                ))}
                <th className="th text-right">Pcs / ctn</th>
                <th className="th text-right">Total pcs</th>
                <th className="th text-right">N.W.</th>
                <th className="th text-right">G.W.</th>
                {anyMeas && <th className="th">Meas.</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {layout.cartons.map((c, i) => (
                <tr key={i} className={clsx(c.continues && 'bg-ink-50/40')} title={`Row ${c.sheetRow}${c.lastRow !== c.sheetRow ? `–${c.lastRow}` : ''} of the document`}>
                  <td className="td whitespace-nowrap text-sm font-medium">
                    {c.continues
                      ? <span className="pl-3 text-xs font-normal text-ink-500" title="The same carton, another colour">↳ carton {c.number}</span>
                      : (c.number || '—')}
                  </td>
                  <td className="td text-right tnum text-sm">{c.continues ? <span className="text-ink-300">·</span> : fmt(c.count, 2)}</td>
                  {anyStyle && <td className="td text-sm">{c.style ?? '—'}</td>}
                  {anyColour && (
                    <td className="td text-sm">
                      <span>{c.colour ?? '—'}</span>
                      {c.colour && match.cartonColours[i] && match.cartonColours[i] !== c.colour && (
                        <span className="block text-2xs text-ink-500">{match.cartonColours[i]}</span>
                      )}
                      {c.colour && !match.cartonColours[i] && (
                        <span className="block text-2xs text-amber-700">
                          {match.cartonColourCandidates[i]! > 1
                            ? `in ${match.cartonColourCandidates[i]} styles of this order; the file does not say which`
                            : 'not on this order'}
                        </span>
                      )}
                    </td>
                  )}
                  {sizes.map((s) => (
                    <td key={s} className="td text-center tnum text-sm">
                      <span className={clsx(!c.bySize[s] && 'text-ink-300')}>{c.bySize[s] ? fmt(c.bySize[s], 2) : '·'}</span>
                    </td>
                  ))}
                  <td className="td text-right tnum text-sm" title={c.number ? undefined : 'A line by style: pieces ÷ cartons, an average'}>
                    {c.number ? fmt(c.perCarton, 2) : <span className="text-ink-500">≈ {fmt(c.perCarton, 1)}</span>}
                  </td>
                  <td className="td text-right tnum text-sm font-semibold">{fmt(c.totalPieces, 2)}</td>
                  <td className="td text-right tnum text-sm">{fmt(c.netKg, 2)}</td>
                  <td className="td text-right tnum text-sm">{fmt(c.grossKg, 2)}</td>
                  {anyMeas && <td className="td whitespace-nowrap text-sm">{c.measurement ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-ink-200 bg-ink-50 text-sm font-semibold">
              <tr>
                <td className="td">Read</td>
                <td className="td text-right tnum">{fmt(layout.totals.cartons, 2)}</td>
                {anyStyle && <td className="td" />}
                {anyColour && <td className="td" />}
                {sizes.map((s) => <td key={s} className="td text-center tnum">{fmt(layout.totals.bySize[s], 2)}</td>)}
                <td className="td" />
                <td className="td text-right tnum">{fmt(layout.totals.pieces)}</td>
                <td className="td text-right tnum">{fmt(layout.totals.netKg, 2)}</td>
                <td className="td text-right tnum">{fmt(layout.totals.grossKg, 2)}</td>
                {anyMeas && <td className="td" />}
              </tr>
              {p && (
                <tr className="font-normal text-ink-600">
                  <td className="td">Document's total (row {p.sheetRow})</td>
                  <td className="td text-right tnum">{fmt(p.cartons, 2)}</td>
                  {anyStyle && <td className="td" />}
                  {anyColour && <td className="td" />}
                  {sizes.map((s) => <td key={s} className="td" />)}
                  <td className="td" />
                  <td className={clsx('td text-right tnum', p.pieces != null && Math.abs(p.pieces - layout.totals.pieces) > 0.5 && 'text-red-700')}>{fmt(p.pieces)}</td>
                  <td className="td text-right tnum">{fmt(p.netKg, 2)}</td>
                  <td className="td text-right tnum">{fmt(p.grossKg, 2)}</td>
                  {anyMeas && <td className="td" />}
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

function AgainstOrder({ data, matrix }: { data: PackingFileLayoutDto; matrix: Awaited<ReturnType<typeof api.orders.matrix>> | undefined }) {
  const { layout, match } = data;
  const rows = useMemo(() => {
    // Pieces in the file per order colour × order size (names), and what could not be placed.
    const placed = new Map<string, Map<string, number>>();
    let unplaced = 0;
    for (const [i, c] of layout.cartons.entries()) {
      const colour = c.colour ? match.cartonColours[i] : (data.order.colours.length === 1 ? data.order.colours[0]! : null);
      for (const [s, n] of Object.entries(c.bySize)) {
        const size = match.sizes[s];
        if (!colour || !size) { unplaced += n * c.count; continue; }
        const row = placed.get(colour) ?? new Map<string, number>();
        row.set(size, (row.get(size) ?? 0) + n * c.count);
        placed.set(colour, row);
      }
    }
    return { placed, unplaced };
  }, [layout, match, data.order.colours]);

  if (!layout.table || layout.cartons.length === 0 || !matrix) return null;
  const sizes = matrix.sizes.filter((s) => [...rows.placed.values()].some((r) => r.has(s.name)));
  const colours = matrix.colors.filter((c) => rows.placed.has(c.name));
  const ordered = (colourId: string, sizeId: string) => matrix.matrices.ORDER?.cells?.[colourId]?.[sizeId] ?? 0;
  if (colours.length === 0) {
    return (
      <Card>
        <CardHeader title="Against the order" />
        <p className="p-4 text-sm text-ink-600">None of the colours and sizes in the file could be matched to this order's, so it cannot be compared.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Against the order" subtitle="Pieces in this file / ordered, for the colours and sizes the file packs" />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              <th className="th">Colour</th>
              {sizes.map((s) => <th key={s.id} className="th text-center">{s.name}</th>)}
              <th className="th text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {colours.map((c) => {
              const row = rows.placed.get(c.name)!;
              let inFile = 0; let inOrder = 0;
              return (
                <tr key={c.id}>
                  <td className="td text-sm font-medium">{c.name}</td>
                  {sizes.map((s) => {
                    const f = row.get(s.name) ?? 0; const o = ordered(c.id, s.id);
                    inFile += f; inOrder += o;
                    return (
                      <td key={s.id} className="td text-center tnum text-sm">
                        <span className={clsx(f > o && 'font-semibold text-red-700', f === 0 && 'text-ink-300')}>{fmt(f)}</span>
                        <span className="text-ink-400"> / {fmt(o)}</span>
                      </td>
                    );
                  })}
                  <td className="td text-right tnum text-sm">
                    <span className={clsx(inFile > inOrder && 'font-semibold text-red-700')}>{fmt(inFile)}</span>
                    <span className="text-ink-400"> / {fmt(inOrder)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.unplaced > 0 && (
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-amber-800">
          {fmt(rows.unplaced)} pcs in the file are under a colour or size that could not be matched to one of this order's, so they are not in the comparison.
        </p>
      )}
    </Card>
  );
}

function DocumentPreview({ data }: { data: PackingFileLayoutDto }) {
  const { preview } = data.layout;
  if (preview.rows.length === 0) return <EmptyState title="The document is empty" />;
  const width = Math.max(...preview.rows.map((r) => r.cells.length));
  const legend: Array<[string, string]> = [
    ['bg-sky-100', 'Table heading'], ['bg-emerald-50', 'Carton rows read'], ['bg-ink-100', 'Total row'], ['bg-amber-50', 'Details read'],
  ];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 text-2xs text-ink-600">
        {legend.map(([cls, label]) => (
          <span key={label} className="inline-flex items-center gap-1.5"><span className={clsx('h-3 w-3 rounded-sm border border-ink-200', cls)} />{label}</span>
        ))}
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-md border border-ink-200">
        <table className="border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-ink-50">
            <tr>
              <th className="sticky left-0 z-20 border border-ink-200 bg-ink-50 px-1.5 py-1 text-ink-400" />
              {Array.from({ length: width }, (_, i) => (
                <th key={i} className="min-w-[3.5rem] border border-ink-200 px-1.5 py-1 font-medium text-ink-400">{columnLetters(preview.firstColumn + i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r) => {
              const tint = r.kind === 'HEADER' ? 'bg-sky-100 font-semibold text-ink-900'
                : r.kind === 'CARTON' ? 'bg-emerald-50'
                : r.kind === 'TOTAL' ? 'bg-ink-100 font-semibold'
                : r.kind === 'DETAIL' ? 'bg-amber-50' : '';
              const cells: Array<{ text: string; span: number }> = [];
              for (let i = 0; i < r.cells.length; i++) {
                const c = r.cells[i]!;
                const span = c.span ?? 1;
                cells.push({ text: c.text, span });
                i += span - 1;
              }
              return (
                <tr key={r.row} className={tint}>
                  <th className="sticky left-0 border border-ink-200 bg-ink-50 px-1.5 py-1 text-right font-medium text-ink-400">{r.row}</th>
                  {cells.map((c, i) => (
                    <Fragment key={i}>
                      <td colSpan={c.span} className="max-w-[16rem] whitespace-pre-line break-words border border-ink-200 px-1.5 py-1 align-top text-ink-800">{c.text}</td>
                    </Fragment>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {preview.truncated && <p className="text-xs text-ink-500">Only the first rows are shown here; open the file for the rest.</p>}
    </div>
  );
}
