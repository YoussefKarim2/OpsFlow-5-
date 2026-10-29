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
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { api, type PackingFileLayoutDto } from '../lib/api';
import { Modal, Card, CardHeader, EmptyState, ErrorNote, Spinner, clsx } from './ui';

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
  });
  const { data: matrix } = useQuery({
    queryKey: ['matrix', orderId],
    queryFn: () => api.orders.matrix(orderId),
    enabled: open,
  });
  const [view, setView] = useState<'layout' | 'document'>('layout');

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
              {([['layout', 'Layout'], ['document', 'As in the file']] as const).map(([k, label]) => (
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
            {view === 'layout' ? (
              <>
                <Issues data={data} />
                <Details data={data} />
                <Cartons data={data} />
                <AgainstOrder data={data} matrix={matrix} />
              </>
            ) : <DocumentPreview data={data} />}
          </div>
        ) : null}
    </Modal>
  );
}

function Summary({ data }: { data: PackingFileLayoutDto }) {
  const { layout } = data;
  const t = layout.totals;
  const tiles: Array<[string, string]> = [
    ['Cartons', fmt(t.cartons)],
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
        {layout.table ? <>, carton table on row {layout.table.headerRow}: {SHAPE_LABEL[layout.table.shape]}.</> : '.'}
      </p>
    </div>
  );
}

function Issues({ data }: { data: PackingFileLayoutDto }) {
  const issues = data.layout.issues;
  if (issues.length === 0) return null;
  return (
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
                <tr key={i} title={`Row ${c.sheetRow}${c.lastRow !== c.sheetRow ? `–${c.lastRow}` : ''} of the document`}>
                  <td className="td whitespace-nowrap text-sm font-medium">{c.number || "—"}</td>
                  <td className="td text-right tnum text-sm">{c.count}</td>
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
                  <td className="td text-right tnum text-sm">{fmt(c.perCarton, 2)}</td>
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
                <td className="td text-right tnum">{fmt(layout.totals.cartons)}</td>
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
                  <td className="td text-right tnum">{fmt(p.cartons)}</td>
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
