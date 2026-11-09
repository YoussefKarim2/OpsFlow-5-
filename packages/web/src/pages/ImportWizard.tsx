/**
 * The import wizard — §4 to §7.
 *
 * Four steps, and the coordinator can always go back:
 *
 *   Upload   drag a file in, or browse
 *   Analyse  what the system found, and what it is unsure about
 *   Map      fix anything it got wrong, before it matters
 *   Review   the order as it will be created, then confirm
 *
 * The order in which those happen is the point. Nothing is written until the
 * last step, so a file read wrongly costs a coordinator thirty seconds rather
 * than a wrong order that someone finds three weeks later on the cutting floor.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Info,
  ArrowRight, ArrowLeft, Save, Loader2, Plus, Trash2, RotateCcw, Image as ImageIcon, Split, X,
} from 'lucide-react';
import {
  CONCEPT_META, ImportConcept, fmtNumber, fieldLabel,
  type ColumnAnalysis,
} from '@opsflow/shared';
import { api, type ImportAnalysisDto } from '../lib/api';
import {
  Card, CardHeader, EmptyState, ErrorNote, Field, Spinner, clsx, useToast,
} from '../components/ui';
import { ComboSelect } from '../components/ComboSelect';
import { isPicture, MAX_PICTURES, readPictures, type PictureProgress } from '../lib/ocr';

type Step = 'upload' | 'analyse' | 'map' | 'review';

/**
 * A model (row) of the Main Order grid on the review screen. Rows read from the
 * file can be removed; rows added by hand carry a typed name and quantities.
 * Quantities are kept as the text typed, so a half-typed figure is not lost.
 */
interface GridRow {
  key: string;
  color: string;
  cells: Record<string, string>;
  added: boolean;
  /** The price per piece: as read from the PO, or typed for an added model. */
  price: string;
}

function rowsFromPreview(p: ImportAnalysisDto['preview']): GridRow[] {
  return p.matrixRows.map((r, i) => ({
    key: `read-${i}`,
    color: r.color,
    cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, String(v)])),
    added: false,
    price: r.unitPrice == null ? '' : String(r.unitPrice),
  }));
}

/** A price as typed: dollars, or null when blank or not a number. */
const priceOfText = (v: string): number | null => {
  const t = v.trim().replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pieces = (v: string | undefined): number => {
  const n = Number((v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** Why the edited grid cannot be imported yet, or null when it can. */
function gridProblem(rows: GridRow[]): string | null {
  const names = rows.map((r) => r.color.trim().toLowerCase());
  if (names.some((n) => n === '')) return 'Give every added model a name.';
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return `"${rows[names.indexOf(dup)].color.trim()}" is listed twice. Each model needs its own name.`;
  const empty = rows.find((r) => r.added && Object.values(r.cells).every((v) => pieces(v) === 0));
  if (empty) return `Enter the quantities for ${empty.color.trim()}.`;
  return null;
}

/**
 * An order split off the document's own on the review screen: the models
 * moved into it (by row key) and the PO number it is created under.
 */
interface SplitPart { id: number; poNumber: string }

const samePo = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** Why the split cannot be created yet, or null when it can. */
function splitProblem(rows: GridRow[], parts: SplitPart[], assign: Record<string, number>, mainPo: string, sizes: string[]): string | null {
  if (parts.length === 0) return null;
  const piecesIn = (rs: GridRow[]) => rs.reduce((a, r) => a + sizes.reduce((b, sz) => b + pieces(r.cells[sz]), 0), 0);
  if (piecesIn(rows.filter((r) => assign[r.key] == null)) === 0) {
    return `Keep at least one model with quantities in PO ${mainPo || 'the document\'s order'}, or remove the models you do not want.`;
  }
  for (const [i, part] of parts.entries()) {
    const name = `Order ${i + 2}`;
    if (!part.poNumber.trim()) return `Give ${name} a PO number.`;
    if (part.poNumber.trim().length > 64) return `${name}'s PO number is too long (64 characters at most).`;
    if (samePo(part.poNumber, mainPo) || parts.some((o, j) => j < i && samePo(o.poNumber, part.poNumber))) {
      return `PO ${part.poNumber.trim()} is used twice. Each order needs its own PO number.`;
    }
    const mine = rows.filter((r) => assign[r.key] === part.id);
    if (mine.length === 0) return `${name} has no models. Select models in the grid and add them, or remove ${name}.`;
    if (piecesIn(mine) === 0) return `${name} has no quantities.`;
  }
  return null;
}

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'analyse', label: 'Analysis' },
  { key: 'map', label: 'Column mapping' },
  { key: 'review', label: 'Review & confirm' },
];

export function ImportWizardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportAnalysisDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});
  const [reserveMaterials, setReserveMaterials] = useState(true);
  // The review grid as edited: null while it is exactly as read from the file.
  // A re-read of the file (another sheet, a remapped column) starts it over.
  const [grid, setGrid] = useState<GridRow[] | null>(null);
  // Models split into orders of their own: the orders, and which order each
  // row (by key) is in. A row in none stays in the document's own order.
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [assign, setAssign] = useState<Record<string, number>>({});
  // The screenshot being imported, shown beside the grid to check against.
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const [reading, setReading] = useState<PictureProgress | null>(null);
  useEffect(() => () => { if (pictureUrl) URL.revokeObjectURL(pictureUrl); }, [pictureUrl]);
  const startOver = () => { setGrid(null); setParts([]); setAssign({}); };

  const { data: lookups } = useQuery({ queryKey: ['lookups'], queryFn: api.reference.lookups });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      if (files.length > 1 || isPicture(files[0]!)) {
        if (!files.every(isPicture)) {
          throw new Error('Import one spreadsheet or PDF at a time. Several files can be read together only when they are all screenshots.');
        }
        const read = await readPictures(files, setReading);
        setFile(read.file);
        setPictureUrl(URL.createObjectURL(read.file));
        return api.import.upload(read.file, read.passes);
      }
      setPictureUrl(null);
      return api.import.upload(files[0]!);
    },
    onSuccess: (r) => { setResult(r); startOver(); setError(null); setReading(null); setStep('analyse'); },
    onError: (e) => { setError(e); setFile(null); setReading(null); setPictureUrl(null); },
  });

  const remap = useMutation({
    mutationFn: (body: { sheetName?: string; columnMapping?: Record<string, string>; fieldOverrides?: Record<string, string | number | null> }) =>
      api.import.remap(result!.jobId, body),
    onSuccess: (r) => { setResult(r); startOver(); setError(null); },
    onError: setError,
  });

  const commit = useMutation({
    mutationFn: () => api.import.commit(result!.jobId, {
      columnMapping: Object.keys(columnMapping).length > 0 ? columnMapping : undefined,
      overrides: Object.keys(fieldOverrides).length > 0 ? fieldOverrides : undefined,
      sheetName: result?.analysis?.sheetName,
      reserveMaterials,
      // Only when models were added or removed; otherwise the file's own grid
      // (with its prices) is used as read.
      matrix: grid ? {
        sizes: result!.preview.sizes,
        rows: grid.map((r) => ({
          color: r.color.trim(),
          cells: Object.fromEntries(result!.preview.sizes.map((sz) => [sz, pieces(r.cells[sz])]).filter(([, q]) => (q as number) > 0)),
          ...(r.added && priceOfText(r.price) != null ? { unitPrice: priceOfText(r.price) } : {}),
        })),
      } : undefined,
      splits: parts.length > 0 ? parts.map((part) => ({
        poNumber: part.poNumber.trim(),
        colors: (grid ?? rowsFromPreview(result!.preview)).filter((r) => assign[r.key] === part.id).map((r) => r.color.trim()),
      })) : undefined,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      const short = r.reservation?.short.length ?? 0;
      const made = r.orders ?? [{ orderId: r.orderId, poNumber: r.poNumber }];
      toast.success(
        (made.length > 1 ? `Created ${made.length} orders: ${made.map((o) => o.poNumber).join(', ')}.` : `Created ${r.poNumber}.`) +
        (r.reservation ? ` ${r.reservation.reserved.length} material line${r.reservation.reserved.length === 1 ? '' : 's'} reserved` : '') +
        (short > 0 ? `, ${short} short.` : r.reservation ? '.' : ''),
      );
      // Several orders are seen together in the list; one opens at once.
      navigate(made.length > 1 ? '/orders' : `/orders/${r.orderId}`);
    },
    onError: setError,
  });

  const saveMapping = useMutation({
    mutationFn: (clientId: string | null) => api.import.saveMapping(result!.jobId, { clientId }),
    onSuccess: (r) => toast.success(`Saved “${r.label}” — ${r.columns} columns remembered for next time.`),
    onError: (e) => toast.error(e),
  });

  const reset = () => {
    setStep('upload'); setFile(null); setResult(null); setError(null);
    setColumnMapping({}); setFieldOverrides({}); startOver(); setPictureUrl(null); setReading(null);
  };

  const analysis = result?.analysis ?? null;
  // No `errors` gate any more: extraction issues inform the user, they do not
  // decide what the user is allowed to do. The stepper follows suit — every
  // stage a file has reached stays reachable.

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Import an order</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Any customer's spreadsheet. The system works out what the columns mean; you check it
            before anything is created.
          </p>
        </div>
        {result && <button className="btn-ghost btn-sm" onClick={reset}>Start over</button>}
      </div>

      <Stepper current={step} reached={result ? 'review' : 'upload'} onStep={setStep} available={!!result} />

      {error != null && <ErrorNote error={error} />}

      {step === 'upload' && (
        <UploadStep
          file={file}
          busy={upload.isPending}
          reading={reading}
          onFiles={(fs) => { setError(null); setFile(fs.length === 1 ? fs[0]! : null); upload.mutate(fs); }}
        />
      )}

      {step === 'analyse' && result && (
        <AnalyseStep
          result={result}
          // Column corrections are indexes into one sheet's columns. Carried to
          // another sheet they point at different columns, and the commit —
          // which sends them — wrote an order unlike the preview just approved.
          onSheetChange={(sheetName) => { setColumnMapping({}); remap.mutate({ sheetName }); }}
          busy={remap.isPending}
          // A PDF and a recognised profile both arrive without a column
          // analysis, and there is nothing to map without columns — sending
          // them to the mapping screen put an empty detour between the user and
          // the order. Only a file whose columns are genuinely unresolved goes
          // there, and even then only to offer help, never to demand it.
          onNext={() => setStep(analysis && !analysis.readiness.ready ? 'map' : 'review')}
        />
      )}

      {step === 'map' && result && analysis && (
        <MapStep
          columns={analysis.columns}
          mapping={columnMapping}
          busy={remap.isPending}
          onChange={(index, concept) => {
            const next = { ...columnMapping, [String(index)]: concept };
            setColumnMapping(next);
            remap.mutate({ columnMapping: next, sheetName: analysis.sheetName });
          }}
          onBack={() => setStep('analyse')}
          onNext={() => setStep('review')}
          onSaveMapping={(clientId) => saveMapping.mutate(clientId)}
          savingMapping={saveMapping.isPending}
          clients={lookups?.clients ?? []}
        />
      )}

      {step === 'map' && result && !analysis && (
        <Card>
          <EmptyState
            title="There are no columns to map"
            detail="This file was read without a column table — a PDF, or a recognised layout. Everything that was read is on the review screen."
            action={<button className="btn-primary btn-sm" onClick={() => setStep('review')}>Review the order</button>}
          />
        </Card>
      )}

      {step === 'review' && result && (
        <ReviewStep
          result={result}
          fieldOverrides={fieldOverrides}
          // The one choice left on this screen: which of two readings of an
          // ambiguous date the file meant. Applied at once, by re-reading the
          // file with that reading, so what is shown is what will be saved.
          onField={(field, value) => {
            const next = { ...fieldOverrides, [field]: value };
            setFieldOverrides(next);
            remap.mutate({ fieldOverrides: next, columnMapping, sheetName: analysis?.sheetName });
          }}
          applying={remap.isPending}
          rows={grid ?? rowsFromPreview(result.preview)}
          edited={grid != null}
          onRows={setGrid}
          onResetRows={() => setGrid(null)}
          parts={parts}
          assign={assign}
          onSplit={(next, nextAssign) => { setParts(next); setAssign(nextAssign); }}
          pictureUrl={pictureUrl}
          reserveMaterials={reserveMaterials}
          onReserveChange={setReserveMaterials}
          onBack={() => setStep(analysis ? 'map' : 'analyse')}
          onConfirm={() => commit.mutate()}
          committing={commit.isPending}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

function Stepper({
  current, reached, onStep, available,
}: {
  current: Step; reached: Step; onStep: (s: Step) => void; available: boolean;
}) {
  const order = STEPS.map((s) => s.key);
  const reachedIndex = order.indexOf(reached);

  return (
    <ol className="flex flex-wrap items-center gap-1 text-sm">
      {STEPS.map((s, i) => {
        const isCurrent = s.key === current;
        const isDone = order.indexOf(s.key) < order.indexOf(current);
        const clickable = available && i <= Math.max(reachedIndex, order.indexOf(current));
        return (
          <li key={s.key} className="flex items-center">
            <button
              disabled={!clickable}
              onClick={() => clickable && onStep(s.key)}
              className={clsx(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors',
                isCurrent ? 'bg-accent-600 text-white'
                : isDone ? 'text-ink-700 hover:bg-ink-100'
                : 'text-ink-400',
                !clickable && 'cursor-default',
              )}
            >
              <span className={clsx(
                'flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold',
                isCurrent ? 'bg-white/25' : isDone ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-100',
              )}>
                {isDone ? '✓' : i + 1}
              </span>
              {s.label}
            </button>
            {i < STEPS.length - 1 && <span className="mx-0.5 text-ink-300">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

function UploadStep({
  file, busy, reading, onFiles,
}: {
  file: File | null; busy: boolean; reading: PictureProgress | null; onFiles: (f: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback((list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length === 0 || busy) return;
    onFiles(files.slice(0, MAX_PICTURES));
  }, [onFiles, busy]);

  // A screenshot is usually on the clipboard already: Ctrl+V reads it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const pictures = Array.from(e.clipboardData?.files ?? []).filter(isPicture);
      if (pictures.length === 0) return;
      e.preventDefault();
      handle(pictures.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted screenshot${i ? ` ${i + 1}` : ''}.png`, { type: f.type }))));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handle]);

  return (
    <Card>
      <div className="p-5">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handle(e.dataTransfer.files);
          }}
          className={clsx(
            'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors',
            dragging ? 'border-accent-500 bg-accent-50' : 'border-ink-300 bg-ink-50/50',
          )}
        >
          {busy ? (
            reading ? (
              <>
                <ImageIcon className="mb-3 h-8 w-8 text-accent-600" />
                <p className="text-sm font-medium text-ink-800">{reading.label}</p>
                <div className="mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-ink-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(reading.fraction * 100)}>
                  <div className="h-full rounded-full bg-accent-600 transition-[width] duration-300" style={{ width: `${Math.round(reading.fraction * 100)}%` }} />
                </div>
                <p className="mt-2 text-xs text-ink-500">
                  The text is read on this computer — usually 10–30 seconds per screenshot. Keep this page open.
                </p>
              </>
            ) : (
              <>
                <Loader2 className="mb-3 h-8 w-8 animate-spin text-accent-600" />
                <p className="text-sm font-medium text-ink-800">Reading {file?.name ?? 'the file'}…</p>
                <p className="mt-1 text-xs text-ink-500">Finding the table and working out the columns.</p>
              </>
            )
          ) : (
            <>
              <Upload className="mb-3 h-8 w-8 text-ink-400" />
              <p className="text-sm font-medium text-ink-800">Drop a spreadsheet, a PDF or screenshots here</p>
              <p className="mt-1 text-xs text-ink-500">or paste a screenshot (Ctrl+V), or</p>
              <button className="btn-secondary btn-sm mt-2" onClick={() => inputRef.current?.click()}>
                Browse files
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".xlsx,.xlsm,.xls,.csv,.ods,.pdf,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={(e) => { handle(e.target.files); e.target.value = ''; }}
              />
              <p className="mt-4 max-w-md text-2xs text-ink-400">
                .xlsx, .xlsm, .csv or a .pdf, up to 25 MB. Any layout — the importer reads the AGE
                workbook by its sheet names, and anything else by working out what its columns mean.
                An older .xls or an .ods needs saving as .xlsx first.
              </p>
              <p className="mt-2 max-w-md text-2xs text-ink-400">
                <span className="font-medium text-ink-500">Screenshots</span> (.png, .jpg): up to {MAX_PICTURES} at once,
                joined top to bottom as one order. Zoom in before taking them, so the smallest numbers
                are easy to read — small print is where text recognition goes wrong. The original PDF or
                spreadsheet is always more reliable when you have it.
              </p>
            </>
          )}
        </div>

        {file && !busy && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-ink-200 bg-white px-3 py-2">
            {isPicture(file) ? <ImageIcon className="h-4 w-4 text-accent-600" /> : <FileSpreadsheet className="h-4 w-4 text-emerald-600" />}
            <span className="flex-1 truncate text-sm text-ink-800">{file.name}</span>
            <span className="tnum text-2xs text-ink-500">{(file.size / 1024).toFixed(0)} KB</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function AnalyseStep({
  result, onSheetChange, busy, onNext,
}: {
  result: ImportAnalysisDto;
  onSheetChange: (sheet: string) => void;
  busy: boolean;
  onNext: () => void;
}) {
  const a = result.analysis;
  const errors = result.issues.filter((i) => i.level === 'ERROR');
  const warnings = result.issues.filter((i) => i.level === 'WARNING');
  const infos = result.issues.filter((i) => i.level === 'INFO');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Excel analysis"
          subtitle={
            a
              ? `Read “${a.sheetName}” as a ${a.layout === 'WIDE' ? 'size grid' : 'row-per-size table'} — ` +
                `${a.rowsDetected} data row${a.rowsDetected === 1 ? '' : 's'} from row ${a.headerRowIndex + 1}`
              : result.profile === 'pdf'
                ? `Read from the ${/\.(png|jpe?g|webp)$/i.test(result.fileName ?? '') ? 'screenshot' : 'PDF'} at ${Math.round(result.profileConfidence * 100)}% confidence`
                : `Matched the ${result.profile} layout at ${Math.round(result.profileConfidence * 100)}% confidence`
          }
          action={
            a && a.candidateSheets.length > 1 && (
              <ComboSelect
                className="input w-52"
                value={a.sheetName}
                disabled={busy}
                onChange={(e) => onSheetChange(e.target.value)}
              >
                {a.candidateSheets.map((s) => (
                  <option key={s.name} value={s.name}>{s.name} ({s.rows} rows)</option>
                ))}
              </ComboSelect>
            )
          }
        />

        {a && (
          <ul className="grid gap-x-6 gap-y-1.5 p-4 sm:grid-cols-2">
            {a.checklist.map((c) => (
              <li key={c.concept} className="flex items-center gap-2 text-sm">
                {c.detected
                  ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  : <XCircle className="h-4 w-4 shrink-0 text-ink-300" />}
                <span className={c.detected ? 'text-ink-800' : 'text-ink-400'}>{c.label}</span>
                {c.columnHeader && (
                  <code className="rounded bg-ink-100 px-1 py-0.5 text-2xs text-ink-600">{c.columnHeader}</code>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(errors.length > 0 || warnings.length > 0 || infos.length > 0) && (
        <Card>
          <CardHeader title="What the importer noticed" />
          <ul className="divide-y divide-ink-100">
            {[...errors, ...warnings, ...infos].map((i, k) => (
              <li key={k} className="flex items-start gap-2.5 px-4 py-2.5">
                {i.level === 'ERROR' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  : i.level === 'WARNING' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  : <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />}
                <div className="min-w-0">
                  <p className="text-sm text-ink-800">{i.message}</p>
                  {i.sheet && <p className="text-2xs text-ink-400">{i.sheet}{i.cell ? ` · ${i.cell}` : ''}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex justify-end">
        <button className="btn-primary" onClick={onNext} disabled={busy}>
          {errors.length > 0 || (a && !a.readiness.ready) ? 'Fix the mapping' : 'Continue'}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const CONCEPT_OPTIONS = (Object.keys(CONCEPT_META) as ImportConcept[])
  .map((c) => ({ value: c, label: CONCEPT_META[c].label }))
  .sort((a, b) => (a.value === ImportConcept.IGNORE ? 1 : b.value === ImportConcept.IGNORE ? -1 : a.label.localeCompare(b.label)));

function MapStep({
  columns, mapping, busy, onChange, onBack, onNext, onSaveMapping, savingMapping, clients,
}: {
  columns: ColumnAnalysis[];
  mapping: Record<string, string>;
  busy: boolean;
  onChange: (index: number, concept: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSaveMapping: (clientId: string | null) => void;
  savingMapping: boolean;
  clients: Array<{ id: string; name: string }>;
}) {
  const [saveFor, setSaveFor] = useState<string>('');
  const unconfirmed = columns.filter((c) => c.needsConfirmation);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Column mapping"
          subtitle={
            unconfirmed.length === 0
              ? 'Every column was recognised. Change any of them if the guess is wrong.'
              : `${unconfirmed.length} column${unconfirmed.length === 1 ? '' : 's'} need${unconfirmed.length === 1 ? 's' : ''} confirming`
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Column in the file</th>
                <th className="th">Sample values</th>
                <th className="th w-56">What it represents</th>
                <th className="th">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {columns.map((c) => {
                const value = mapping[String(c.index)] ?? c.concept;
                const flagged = c.needsConfirmation && !mapping[String(c.index)];
                return (
                  <tr key={c.index} className={clsx(flagged && 'bg-amber-50/40')}>
                    <td className="td">
                      <span className="font-medium text-ink-900">{c.header || <em className="text-ink-400">(blank)</em>}</span>
                      {flagged && <AlertTriangle className="ml-1.5 inline h-3.5 w-3.5 text-amber-500" />}
                    </td>
                    <td className="td max-w-xs truncate text-xs text-ink-500">
                      {c.samples.length > 0 ? c.samples.join(', ') : <span className="text-ink-300">no values</span>}
                    </td>
                    <td className="td">
                      <ComboSelect
                        className="input"
                        value={value}
                        disabled={busy}
                        onChange={(e) => onChange(c.index, e.target.value)}
                      >
                        {CONCEPT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </ComboSelect>
                    </td>
                    <td className="td max-w-xs text-2xs text-ink-500">
                      {c.source === 'MANUAL' ? 'You chose this'
                        : c.source === 'SAVED' ? 'From a saved mapping for this file shape'
                        : c.guesses[0]?.reason ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Remember this mapping"
          subtitle="The same customer usually sends the same shape every month."
        />
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Save against">
            <ComboSelect className="input w-64" value={saveFor} onChange={(e) => setSaveFor(e.target.value)}>
              <option value="">Any customer with this file shape</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ComboSelect>
          </Field>
          <button
            className="btn-secondary"
            onClick={() => onSaveMapping(saveFor || null)}
            disabled={savingMapping || busy}
          >
            <Save className="h-4 w-4" /> {savingMapping ? 'Saving…' : 'Save mapping'}
          </button>
        </div>
      </Card>

      <div className="flex justify-between">
        <button className="btn-secondary" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</button>
        <button className="btn-primary" onClick={onNext} disabled={busy}>
          {busy ? 'Re-reading…' : 'Review the order'} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** Fields a coordinator can type in if the file does not carry them. */
/**
 * What the review screen offers to check.
 *
 * Only the PO number is marked, and even that is filled in for you — the
 * extractor derives one from the document when it is not labelled, so the
 * asterisk means "this is the order's identity, look at it" rather than "you
 * must type something". Everything else the committer defaults, so nothing on
 * this screen has to be filled in for an import to go through.
 */
/**
 * The fields always offered, in the order a coordinator looks for them.
 *
 * These appear whether or not the document carried them, because a blank PO
 * number is something you need to see and fill in. Everything *else* the reader
 * found is added after them — see `reviewFields` — so a value taken off the
 * page can never be applied without being shown.
 */
const REVIEW_FIELDS: Array<{ field: string; label: string; required?: boolean }> = [
  { field: 'poNumber', label: 'PO number', required: true },
  { field: 'clientName', label: 'Customer' },
  { field: 'orderName', label: 'Order name' },
  { field: 'styleNumber', label: 'Style' },
  { field: 'season', label: 'Season' },
  { field: 'poDate', label: 'PO date' },
  { field: 'requiredDeliveryDate', label: 'Delivery date' },
  { field: 'promisedShippingDate', label: 'Promised shipping date' },
];

/**
 * Every field on the review screen: the standard ones, plus anything the
 * document turned out to state.
 *
 * A reader that fills in a price, a fabric or a delivery address and then does
 * not show it has made a decision on the coordinator's behalf that they cannot
 * see, let alone correct. Whatever was read is editable here before anything is
 * created — which is the whole promise of a review screen.
 */
function reviewFields(order: Record<string, unknown>): Array<{ field: string; label: string; required?: boolean }> {
  const standard = new Set(REVIEW_FIELDS.map((f) => f.field));
  const found = Object.keys(order)
    .filter((k) => !standard.has(k) && order[k] != null && String(order[k]).trim() !== '')
    .sort()
    .map((field) => ({ field, label: fieldLabel(field) }));
  return [...REVIEW_FIELDS, ...found];
}

function ReviewStep({
  result, fieldOverrides, onField, applying, rows, edited, onRows, onResetRows,
  parts, assign, onSplit, pictureUrl,
  reserveMaterials, onReserveChange, onBack, onConfirm, committing,
}: {
  parts: SplitPart[];
  assign: Record<string, number>;
  onSplit: (parts: SplitPart[], assign: Record<string, number>) => void;
  pictureUrl: string | null;
  result: ImportAnalysisDto;
  fieldOverrides: Record<string, string>;
  onField: (field: string, value: string) => void;
  applying: boolean;
  rows: GridRow[];
  edited: boolean;
  onRows: (rows: GridRow[]) => void;
  onResetRows: () => void;
  reserveMaterials: boolean;
  onReserveChange: (v: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
  committing: boolean;
}) {
  const p = result.preview;
  const rowTotal = (r: GridRow) => p.sizes.reduce((a, sz) => a + pieces(r.cells[sz]), 0);
  const total = rows.reduce((a, r) => a + rowTotal(r), 0);
  const problem = gridProblem(rows);
  const mainPo = String(p.order.poNumber ?? '');
  // Only rows still in the grid count: a removed model leaves its order.
  const liveAssign = Object.fromEntries(Object.entries(assign).filter(([k]) => rows.some((r) => r.key === k)));
  const splitIssue = problem ? null : splitProblem(rows, parts, liveAssign, mainPo, p.sizes);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A re-read numbers the rows afresh: a tick would land on another model.
  useEffect(() => { setSelected(new Set()); }, [result]);
  const toggle = (key: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const chosen = rows.filter((r) => selected.has(r.key));
  const orderNo = (key: string) => {
    const at = parts.findIndex((x) => x.id === liveAssign[key]);
    return at < 0 ? 1 : at + 2;
  };
  /** Move the selected models into an order: a new one, or one already split off (null = back to the document's own). */
  const moveSelected = (to: number | 'new' | null) => {
    let nextParts = parts;
    let id = to;
    if (to === 'new') {
      id = Math.max(0, ...parts.map((x) => x.id)) + 1;
      // The document's PO with a running number: 600772-2, 600772-3, …
      let n = parts.length + 2;
      while ([mainPo, ...parts.map((x) => x.poNumber)].some((po) => samePo(po, `${mainPo}-${n}`))) n += 1;
      nextParts = [...parts, { id, poNumber: mainPo ? `${mainPo}-${n}` : '' }];
    }
    const next = { ...liveAssign };
    for (const r of chosen) {
      if (id == null) delete next[r.key]; else next[r.key] = id as number;
    }
    // An order left with no models goes away.
    onSplit(nextParts.filter((x) => Object.values(next).includes(x.id)), next);
    setSelected(new Set());
  };
  const removePart = (id: number) => {
    const next = Object.fromEntries(Object.entries(liveAssign).filter(([, v]) => v !== id));
    onSplit(parts.filter((x) => x.id !== id), next);
  };
  const piecesOf = (rs: GridRow[]) => rs.reduce((a, r) => a + rowTotal(r), 0);
  const removeRow = (key: string) => onRows(rows.filter((r) => r.key !== key));
  const addRow = () => onRows([...rows, { key: `added-${Date.now()}`, color: '', cells: {}, added: true, price: '' }]);
  // The order's price stands in for a model the PO did not price.
  const orderPrice = typeof p.order.pricePerPieceUsd === 'number' ? p.order.pricePerPieceUsd : null;
  const priceOf = (r: GridRow) => priceOfText(r.price) ?? orderPrice;
  const amountOf = (r: GridRow) => { const pr = priceOf(r); return pr == null ? null : rowTotal(r) * pr; };
  const totalValue = rows.every((r) => amountOf(r) != null) ? rows.reduce((a, r) => a + amountOf(r)!, 0) : null;
  const editRow = (key: string, patch: Partial<GridRow>) =>
    onRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const errors = result.issues.filter((i) => i.level === 'ERROR');
  // What the readers want checked before anything is created: a file that
  // holds twenty orders, rows that are measurements rather than colours, a
  // laying sheet in the order importer. They were shown on the analysis step
  // only, and the confirm button is on this one.
  const warnings = result.issues.filter((i) => i.level === 'WARNING');
  // Only what the file stated. Nothing on this screen is typed: a field the
  // document did not carry is not shown here, and can be filled on the order.
  const value = (field: string) => fieldOverrides[field] ?? String(p.order[field] ?? '');
  const found = reviewFields(p.order as Record<string, unknown>).filter((f) => value(f.field).trim() !== '');
  // A date the file wrote ambiguously (03/09: March or September?), not yet answered.
  const dateChoices = (result.mappings ?? [])
    .filter((m, i, all) => all.findIndex((x) => x.field === m.field) === i)
    .filter((m) => m.resolved && m.alternative && m.sampleValue && fieldOverrides[m.field] == null);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Import preview" subtitle="Nothing has been created yet." />
        <div className="grid gap-4 p-4 sm:grid-cols-4 lg:grid-cols-7">
          <Summary label={parts.length > 0 ? `Orders (${parts.length + 1})` : 'Order'} value={parts.length > 0 ? [mainPo || '—', ...parts.map((x) => x.poNumber.trim() || '?')].join(', ') : String(p.order.poNumber ?? '—')} mono />
          <Summary label="Customer" value={String(p.order.clientName ?? '—')} />
          <Summary label="Models" value={String(rows.length)} />
          <Summary label="Sizes" value={String(p.sizes.length)} />
          <Summary label="Total quantity" value={fmtNumber(total, { places: 0 })} strong />
          <Summary label="PO value" value={totalValue == null ? '—' : money(totalValue)} strong />
          <Summary label="Rows read" value={String(result.analysis?.rowsDetected ?? p.matrixRows.length)} />
        </div>
      </Card>

      {warnings.length > 0 && (
        <Card className="border-amber-300">
          <CardHeader title="Check before confirming" />
          <ul className="space-y-1.5 px-4 py-3 text-sm text-amber-900">
            {warnings.map((w, i) => <li key={i} className="flex gap-2"><span aria-hidden>•</span><span>{w.message}</span></li>)}
          </ul>
        </Card>
      )}

      {/* The one place the order's details are checked: what will be saved, plus
          the only real question a file can raise — which reading of a date it meant. */}
      <Card>
        <CardHeader title="Order details" subtitle={applying ? 'Re-reading the file…' : undefined} />
        <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {found.map((f) => (
            <div key={f.field}>
              <dt className="label">{f.label}</dt>
              <dd className="text-ink-900">{value(f.field)}</dd>
            </div>
          ))}
        </dl>
        {dateChoices.map((m) => (
          <div key={m.field} className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-4 py-3 text-sm">
            <span className="font-medium text-ink-900">Which {m.label.toLowerCase()} is right?</span>
            <button className="btn-secondary btn-sm" disabled={applying} onClick={() => onField(m.field, m.sampleValue ?? '')}>
              {m.sampleValue}
            </button>
            <span className="text-xs text-ink-400">or</span>
            <button className="btn-secondary btn-sm" disabled={applying} onClick={() => onField(m.field, m.alternative!.value)}>
              {m.alternative!.value}
            </button>
          </div>
        ))}
      </Card>

      {pictureUrl && (
        <Card>
          <details open>
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold text-ink-900">
              <ImageIcon className="h-4 w-4 text-accent-600" /> The screenshot
              <span className="font-normal text-ink-500">— check the grid below against it</span>
            </summary>
            <div className="max-h-[520px] overflow-auto border-t border-ink-100 bg-ink-50 p-2">
              <img src={pictureUrl} alt="The screenshot being imported" className="max-w-none" style={{ width: 'max(100%, 900px)' }} />
            </div>
          </details>
        </Card>
      )}

      {p.matrixRows.length > 0 ? (
        <Card>
          <CardHeader
            title="Main Order quantities"
            subtitle={edited
              ? 'Changed from the file.'
              : 'Tick models to make them a separate order.'}
            action={edited ? (
              <button type="button" className="btn-ghost btn-sm" onClick={onResetRows}>
                <RotateCcw className="h-3.5 w-3.5" /> Back to the file
              </button>
            ) : undefined}
          />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th w-8">
                    <input
                      type="checkbox"
                      aria-label="Select every model"
                      checked={rows.length > 0 && chosen.length === rows.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())}
                    />
                  </th>
                  <th className="th">Model / colour</th>
                  {p.sizes.map((s) => <th key={s} className="th text-right">{s}</th>)}
                  <th className="th text-right">Total</th>
                  <th className="th text-right">Price</th>
                  <th className="th text-right">Amount</th>
                  <th className="th w-10"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.key} className={clsx(r.added && 'bg-blue-50/40', selected.has(r.key) && 'bg-accent-50')}>
                    <td className="td">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.color.trim() || 'this model'}`}
                        checked={selected.has(r.key)}
                        onChange={() => toggle(r.key)}
                      />
                    </td>
                    <td className="td font-medium">
                      {parts.length > 0 && (
                        <span className={clsx(
                          'mr-2 inline-block rounded px-1.5 py-0.5 align-middle text-2xs font-semibold',
                          orderNo(r.key) === 1 ? 'bg-ink-100 text-ink-600' : 'bg-accent-100 text-accent-800',
                        )}>
                          Order {orderNo(r.key)}
                        </span>
                      )}
                      {r.added ? (
                        <input
                          className="input h-8 min-w-48"
                          placeholder="e.g. Pants — Navy"
                          value={r.color}
                          maxLength={120}
                          autoFocus={r.color === ''}
                          onChange={(e) => editRow(r.key, { color: e.target.value })}
                        />
                      ) : r.color}
                    </td>
                    {p.sizes.map((s) => (
                      <td key={s} className="td tnum text-right text-ink-700">
                        {r.added ? (
                          <input
                            className="input h-8 w-20 text-right tnum"
                            inputMode="numeric"
                            placeholder="0"
                            value={r.cells[s] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value.replace(/[\s,]/g, '');
                              if (/^\d{0,7}$/.test(v)) editRow(r.key, { cells: { ...r.cells, [s]: v } });
                            }}
                          />
                        ) : pieces(r.cells[s]) ? pieces(r.cells[s]).toLocaleString() : <span className="text-ink-300">—</span>}
                      </td>
                    ))}
                    <td className="td tnum text-right font-semibold">{rowTotal(r).toLocaleString()}</td>
                    <td className="td tnum text-right">
                      {r.added ? (
                        <input
                          className="input h-8 w-24 text-right tnum"
                          inputMode="decimal"
                          placeholder={orderPrice != null ? String(orderPrice) : '0.00'}
                          aria-label={`Price per piece for ${r.color.trim() || 'this model'}`}
                          value={r.price}
                          onChange={(e) => { if (/^\$?[\d,]*\.?\d{0,4}$/.test(e.target.value.trim())) editRow(r.key, { price: e.target.value }); }}
                        />
                      ) : priceOf(r) == null ? <span className="text-ink-300">—</span> : (
                        <span className={priceOfText(r.price) == null ? 'text-ink-500' : undefined}>{money(priceOf(r)!)}</span>
                      )}
                    </td>
                    <td className="td tnum text-right">{amountOf(r) == null ? <span className="text-ink-300">—</span> : money(amountOf(r)!)}</td>
                    <td className="td text-right">
                      <button
                        type="button"
                        className="rounded p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
                        title={`Remove ${r.color.trim() || 'this model'}`}
                        aria-label={`Remove ${r.color.trim() || 'this model'}`}
                        onClick={() => removeRow(r.key)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-ink-300 bg-ink-50">
                <tr>
                  <td className="td" />
                  <td className="td font-semibold">Total</td>
                  {p.sizes.map((s) => (
                    <td key={s} className="td tnum text-right font-semibold">
                      {rows.reduce((a, r) => a + pieces(r.cells[s]), 0).toLocaleString()}
                    </td>
                  ))}
                  <td className="td tnum text-right font-bold">{total.toLocaleString()}</td>
                  <td className="td tnum text-right text-xs text-ink-600">{totalValue != null && total > 0 ? `avg ${money(totalValue / total)}` : ''}</td>
                  <td className="td tnum text-right font-bold">{totalValue == null ? <span className="text-ink-300">—</span> : money(totalValue)}</td>
                  <td className="td" />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary btn-sm" onClick={addRow}>
                <Plus className="h-3.5 w-3.5" /> Add a model
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={chosen.length === 0}
                title={chosen.length === 0 ? 'Tick the models that should become an order of their own' : undefined}
                onClick={() => moveSelected('new')}
              >
                <Split className="h-3.5 w-3.5" />
                {chosen.length === 0 ? 'Make a separate order' : `Make a separate order from ${chosen.length} model${chosen.length === 1 ? '' : 's'}`}
              </button>
              {chosen.length > 0 && parts.map((part, i) => (
                <button key={part.id} type="button" className="btn-ghost btn-sm" onClick={() => moveSelected(part.id)}>
                  Add to Order {i + 2}
                </button>
              ))}
              {chosen.length > 0 && parts.length > 0 && chosen.some((r) => liveAssign[r.key] != null) && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => moveSelected(null)}>
                  Back to Order 1
                </button>
              )}
            </div>
            {problem && <span className="text-sm text-red-700">{problem}</span>}
          </div>
        </Card>
      ) : (
        <Card className="border-red-300">
          <CardHeader
            title="No quantities could be read from this file"
            subtitle="An order is never created without its Main Order, so this file cannot be imported as it is. Upload the original purchase order — a PDF exported from Excel or Word, or the spreadsheet itself — rather than a scan or a photo."
          />
        </Card>
      )}

      {parts.length > 0 && (
        <Card className="border-accent-300">
          <CardHeader
            title={`${parts.length + 1} orders will be created`}
            subtitle="Each becomes its own order. A BOM, lay plan or costing from the file stays with Order 1."
          />
          <ul className="divide-y divide-ink-100">
            {[{ id: 0, poNumber: mainPo }, ...parts].map((part, i) => {
              const mine = rows.filter((r) => (i === 0 ? liveAssign[r.key] == null : liveAssign[r.key] === part.id));
              return (
                <li key={part.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                  <div className="w-24 shrink-0 pt-1.5 text-sm font-semibold text-ink-900">Order {i + 1}</div>
                  <div className="w-56 shrink-0">
                    {i === 0 ? (
                      <div className="pt-1.5 text-sm">
                        <span className="font-mono font-semibold">PO {mainPo || '—'}</span>
                        <span className="ml-1 text-xs text-ink-500">from the document</span>
                      </div>
                    ) : (
                      <label className="block">
                        <span className="sr-only">PO number for Order {i + 1}</span>
                        <input
                          className="input h-8 font-mono"
                          value={part.poNumber}
                          maxLength={64}
                          placeholder="PO number"
                          onChange={(e) => onSplit(parts.map((x) => (x.id === part.id ? { ...x, poNumber: e.target.value } : x)), liveAssign)}
                        />
                      </label>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-1.5">
                      {mine.map((r) => (
                        <span key={r.key} className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-800">
                          {r.color.trim() || 'New model'}
                          {i > 0 && (
                            <button
                              type="button"
                              className="rounded-full p-0.5 text-ink-400 hover:bg-ink-200 hover:text-ink-700"
                              aria-label={`Move ${r.color.trim() || 'this model'} back to Order 1`}
                              title="Back to Order 1"
                              onClick={() => {
                                const next = { ...liveAssign };
                                delete next[r.key];
                                onSplit(parts.filter((x) => Object.values(next).includes(x.id)), next);
                              }}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      ))}
                      {mine.length === 0 && <span className="text-xs text-red-700">No models</span>}
                    </div>
                  </div>
                  <div className="tnum w-36 shrink-0 pt-1.5 text-right text-sm">
                    <div className="font-semibold">{piecesOf(mine).toLocaleString()} pcs</div>
                    {mine.every((r) => amountOf(r) != null) && mine.length > 0 && (
                      <div className="text-xs text-ink-500">{money(mine.reduce((a, r) => a + amountOf(r)!, 0))}</div>
                    )}
                  </div>
                  <div className="w-8 shrink-0 pt-0.5 text-right">
                    {i > 0 && (
                      <button
                        type="button"
                        className="rounded p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
                        aria-label={`Put Order ${i + 1}'s models back in Order 1`}
                        title="Put its models back in Order 1"
                        onClick={() => removePart(part.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {splitIssue && <p className="border-t border-ink-100 px-4 py-2.5 text-sm text-red-700">{splitIssue}</p>}
        </Card>
      )}

      {errors.length > 0 && (
        <Card>
          <CardHeader title="These must be fixed first" />
          <ul className="space-y-1.5 p-4">
            {errors.map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-red-700">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />{e.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="flex items-start gap-2.5 p-4">
          <input
            id="reserve"
            type="checkbox"
            className="mt-0.5"
            checked={reserveMaterials}
            onChange={(e) => onReserveChange(e.target.checked)}
          />
          <label htmlFor="reserve" className="text-sm">
            <span className="font-medium text-ink-900">Reserve materials as soon as the order exists</span>
          </label>
        </div>
      </Card>

      <div className="flex justify-between">
        <button className="btn-secondary" onClick={onBack} disabled={committing}>
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        {/*
          Enabled once the file yielded Main Order quantities. Nothing on this
          screen is typed, so a file that yielded none is refused here, and
          says so, rather than creating an order with an empty Main Order.
        */}
        <div className="flex items-center gap-3">
          {total === 0 && (
            <span className="text-sm text-red-700">
              {p.matrixRows.length > 0 ? 'Nothing to import: the grid holds no quantities.' : 'Nothing to import: the file holds no quantities.'}
            </span>
          )}
          {splitIssue && <span className="text-sm text-red-700">{splitIssue}</span>}
          <button className="btn-primary" onClick={onConfirm} disabled={committing || total === 0 || applying || problem != null || splitIssue != null}>
            {committing
              ? (parts.length > 0 ? `Creating ${parts.length + 1} orders…` : 'Creating the order…')
              : (parts.length > 0 ? `Create ${parts.length + 1} orders` : 'Confirm import')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className={clsx(
        'text-ink-900',
        mono && 'font-mono text-sm font-semibold',
        strong ? 'tnum text-lg font-semibold' : 'text-sm',
      )}>
        {value}
      </p>
    </div>
  );
}

export { Spinner };
