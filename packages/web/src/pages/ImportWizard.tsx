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

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle, Info,
  ArrowRight, ArrowLeft, Save, Loader2,
} from 'lucide-react';
import {
  CONCEPT_META, ImportConcept, fmtNumber,
  type ColumnAnalysis,
} from '@opsflow/shared';
import { api, type ImportAnalysisDto } from '../lib/api';
import {
  Card, CardHeader, EmptyState, ErrorNote, Field, Spinner, clsx, useToast,
} from '../components/ui';

type Step = 'upload' | 'analyse' | 'map' | 'review';

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

  const { data: lookups } = useQuery({ queryKey: ['lookups'], queryFn: api.reference.lookups });

  const upload = useMutation({
    mutationFn: (f: File) => api.import.upload(f),
    onSuccess: (r) => { setResult(r); setError(null); setStep('analyse'); },
    onError: (e) => { setError(e); setFile(null); },
  });

  const remap = useMutation({
    mutationFn: (body: { sheetName?: string; columnMapping?: Record<string, string>; fieldOverrides?: Record<string, string | number | null> }) =>
      api.import.remap(result!.jobId, body),
    onSuccess: (r) => { setResult(r); setError(null); },
    onError: setError,
  });

  const commit = useMutation({
    mutationFn: () => api.import.commit(result!.jobId, {
      columnMapping: Object.keys(columnMapping).length > 0 ? columnMapping : undefined,
      overrides: Object.keys(fieldOverrides).length > 0 ? fieldOverrides : undefined,
      sheetName: result?.analysis?.sheetName,
      reserveMaterials,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      const short = r.reservation?.short.length ?? 0;
      toast.success(
        `Created ${r.poNumber}.` +
        (r.reservation ? ` ${r.reservation.reserved.length} material line${r.reservation.reserved.length === 1 ? '' : 's'} reserved` : '') +
        (short > 0 ? `, ${short} short.` : r.reservation ? '.' : ''),
      );
      navigate(`/orders/${r.orderId}`);
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
    setColumnMapping({}); setFieldOverrides({});
  };

  const analysis = result?.analysis ?? null;
  const errors = result?.issues.filter((i) => i.level === 'ERROR') ?? [];
  const canCommit = result?.canCommit === true;

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

      <Stepper current={step} reached={result ? (canCommit ? 'review' : 'map') : 'upload'} onStep={setStep} available={!!result} />

      {error != null && <ErrorNote error={error} />}

      {step === 'upload' && (
        <UploadStep
          file={file}
          busy={upload.isPending}
          onFile={(f) => { setFile(f); upload.mutate(f); }}
        />
      )}

      {step === 'analyse' && result && (
        <AnalyseStep
          result={result}
          onSheetChange={(sheetName) => remap.mutate({ sheetName })}
          busy={remap.isPending}
          onNext={() => setStep(analysis && analysis.readiness.ready && errors.length === 0 ? 'review' : 'map')}
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
            title="This file matched a known layout"
            detail="It was read with a fixed profile, so there are no columns to map. Go straight to review."
            action={<button className="btn-primary btn-sm" onClick={() => setStep('review')}>Review the order</button>}
          />
        </Card>
      )}

      {step === 'review' && result && (
        <ReviewStep
          result={result}
          fieldOverrides={fieldOverrides}
          onField={(field, value) => {
            const next = { ...fieldOverrides, [field]: value };
            setFieldOverrides(next);
          }}
          onApplyFields={() => remap.mutate({ fieldOverrides, columnMapping, sheetName: analysis?.sheetName })}
          applying={remap.isPending}
          reserveMaterials={reserveMaterials}
          onReserveChange={setReserveMaterials}
          onBack={() => setStep(analysis ? 'map' : 'analyse')}
          onConfirm={() => commit.mutate()}
          committing={commit.isPending}
          canCommit={canCommit}
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
  file, busy, onFile,
}: {
  file: File | null; busy: boolean; onFile: (f: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback((f: File | undefined) => {
    if (!f) return;
    onFile(f);
  }, [onFile]);

  return (
    <Card>
      <div className="p-5">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handle(e.dataTransfer.files[0]);
          }}
          className={clsx(
            'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors',
            dragging ? 'border-accent-500 bg-accent-50' : 'border-ink-300 bg-ink-50/50',
          )}
        >
          {busy ? (
            <>
              <Loader2 className="mb-3 h-8 w-8 animate-spin text-accent-600" />
              <p className="text-sm font-medium text-ink-800">Reading {file?.name}…</p>
              <p className="mt-1 text-xs text-ink-500">Finding the table and working out the columns.</p>
            </>
          ) : (
            <>
              <Upload className="mb-3 h-8 w-8 text-ink-400" />
              <p className="text-sm font-medium text-ink-800">Drop an Excel file here</p>
              <p className="mt-1 text-xs text-ink-500">or</p>
              <button className="btn-secondary btn-sm mt-2" onClick={() => inputRef.current?.click()}>
                Browse files
              </button>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xlsm"
                className="hidden"
                onChange={(e) => handle(e.target.files?.[0])}
              />
              <p className="mt-4 max-w-md text-2xs text-ink-400">
                .xlsx or .xlsm, up to 25 MB. Any layout — the importer reads the AGE workbook by its
                sheet names, and anything else by working out what its columns mean.
              </p>
            </>
          )}
        </div>

        {file && !busy && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-ink-200 bg-white px-3 py-2">
            <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
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
              : `Matched the ${result.profile} layout at ${Math.round(result.profileConfidence * 100)}% confidence`
          }
          action={
            a && a.candidateSheets.length > 1 && (
              <select
                className="input w-52"
                value={a.sheetName}
                disabled={busy}
                onChange={(e) => onSheetChange(e.target.value)}
              >
                {a.candidateSheets.map((s) => (
                  <option key={s.name} value={s.name}>{s.name} ({s.rows} rows)</option>
                ))}
              </select>
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
                      <select
                        className="input"
                        value={value}
                        disabled={busy}
                        onChange={(e) => onChange(c.index, e.target.value)}
                      >
                        {CONCEPT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
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
            <select className="input w-64" value={saveFor} onChange={(e) => setSaveFor(e.target.value)}>
              <option value="">Any customer with this file shape</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
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
const REVIEW_FIELDS: Array<{ field: string; label: string; required?: boolean }> = [
  { field: 'poNumber', label: 'PO number', required: true },
  { field: 'clientName', label: 'Customer', required: true },
  { field: 'orderName', label: 'Order name' },
  { field: 'styleNumber', label: 'Style' },
  { field: 'season', label: 'Season' },
  { field: 'requiredDeliveryDate', label: 'Delivery date' },
];

const CONFIDENCE: Record<string, { label: string; chip: string }> = {
  HIGH:   { label: 'High confidence',   chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  MEDIUM: { label: 'Please confirm',    chip: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  LOW:    { label: 'Low confidence',    chip: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
  NONE:   { label: 'Not found',         chip: 'bg-ink-100 text-ink-500 ring-ink-300/40' },
};

/**
 * What the importer found, and where it found it.
 *
 * The point of this panel is that the coordinator can check the import against
 * the workbook open on their other screen without guessing: every row names the
 * sheet and the cell. Anything the importer is not sure about is separated out
 * at the top with the question stated, rather than being applied quietly and
 * discovered three weeks later when the order ships on the wrong date.
 */
function DetectedPanel({
  result, onField,
}: {
  result: ImportAnalysisDto;
  onField: (field: string, value: string) => void;
}) {
  const mappings = result.mappings ?? [];
  if (mappings.length === 0) return null;

  const uncertain = mappings.filter(
    (m) => m.resolved && m.confidence !== 'HIGH' && m.sampleValue,
  );
  const confident = mappings.filter((m) => m.resolved && m.confidence === 'HIGH');
  const missing = mappings.filter((m) => !m.resolved);

  return (
    <>
      {uncertain.length > 0 && (
        <Card className="border-amber-300">
          <CardHeader
            title="Please confirm these"
            subtitle="OpsFlow read them, but is not certain. Nothing is guessed silently."
          />
          <ul className="divide-y divide-ink-100">
            {uncertain.map((m) => (
              <li key={m.field} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-ink-900">{m.label}</span>
                  <span className={clsx('chip', CONFIDENCE[m.confidence].chip)}>
                    {CONFIDENCE[m.confidence].label}
                  </span>
                  {m.sheet && (
                    <span className="font-mono text-2xs text-ink-500">
                      {m.sheet}{m.cell ? ` · ${m.cell}` : ''}
                    </span>
                  )}
                </div>
                {m.interpretation && (
                  <p className="mt-0.5 text-xs text-ink-600">{m.interpretation}</p>
                )}

                {/* An ambiguous date gets both readings as buttons. This is the
                    03/09 case: third of September, or ninth of March. */}
                {m.alternative ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-600">Which is right?</span>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => onField(m.field, m.sampleValue ?? '')}
                    >
                      {m.sampleValue}
                    </button>
                    <span className="text-xs text-ink-400">or</span>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => onField(m.field, m.alternative!.value)}
                    >
                      {m.alternative.value}
                    </button>
                    <span className="text-2xs text-ink-400">
                      ({m.alternative.interpretation})
                    </span>
                  </div>
                ) : (
                  <p className="mt-1 text-sm font-semibold text-ink-900">
                    {m.sampleValue}
                    <span className="ml-2 text-xs font-normal text-ink-500">
                      — correct it in Order details below if this is wrong
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="What was found, and where"
          subtitle={`${confident.length} read with confidence${missing.length ? ` · ${missing.length} not in the file` : ''}`}
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Field</th>
                <th className="th">Value</th>
                <th className="th">Sheet</th>
                <th className="th">Cell</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {[...confident, ...uncertain, ...missing].map((m) => (
                <tr key={m.field} className={clsx(!m.resolved && 'bg-ink-50/70')}>
                  <td className="td text-sm font-medium text-ink-800">
                    {m.label}
                    {m.required && <span className="ml-1 text-red-500">*</span>}
                  </td>
                  <td className={clsx('td text-sm', m.sampleValue ? 'text-ink-900' : 'italic text-ink-400')}>
                    {m.sampleValue ?? 'not in the file'}
                  </td>
                  <td className="td text-xs text-ink-600">{m.sheet ?? '—'}</td>
                  <td className="td font-mono text-2xs text-ink-600">{m.cell ?? '—'}</td>
                  <td className="td">
                    <span className={clsx('chip', CONFIDENCE[m.confidence].chip)}>
                      {CONFIDENCE[m.confidence].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-ink-100 bg-ink-50 px-4 py-2 text-2xs text-ink-500">
          A field marked <strong>not in the file</strong> was genuinely absent. It is left empty
          rather than guessed — type it below if you know it.
        </p>
      </Card>
    </>
  );
}

function ReviewStep({
  result, fieldOverrides, onField, onApplyFields, applying,
  reserveMaterials, onReserveChange, onBack, onConfirm, committing, canCommit,
}: {
  result: ImportAnalysisDto;
  fieldOverrides: Record<string, string>;
  onField: (field: string, value: string) => void;
  onApplyFields: () => void;
  applying: boolean;
  reserveMaterials: boolean;
  onReserveChange: (v: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
  committing: boolean;
  canCommit: boolean;
}) {
  const p = result.preview;
  const errors = result.issues.filter((i) => i.level === 'ERROR');
  const value = (field: string) => fieldOverrides[field] ?? String(p.order[field] ?? '');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Import preview" subtitle="Nothing has been created yet." />
        <div className="grid gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Summary label="Order" value={String(p.order.poNumber ?? '—')} mono />
          <Summary label="Customer" value={String(p.order.clientName ?? '—')} />
          <Summary label="Colours" value={String(p.colors.length)} />
          <Summary label="Sizes" value={String(p.sizes.length)} />
          <Summary label="Total quantity" value={fmtNumber(p.matrixTotal, { places: 0 })} strong />
          <Summary label="Rows read" value={String(result.analysis?.rowsDetected ?? p.matrixRows.length)} />
        </div>
      </Card>

      <DetectedPanel result={result} onField={onField} />

      <Card>
        <CardHeader
          title="Order details"
          subtitle="Anything the file did not carry can be typed here."
          action={
            <button className="btn-secondary btn-sm" onClick={onApplyFields} disabled={applying}>
              {applying ? 'Applying…' : 'Apply changes'}
            </button>
          }
        />
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {REVIEW_FIELDS.map((f) => (
            <Field key={f.field} label={f.label + (f.required ? ' *' : '')}>
              <input
                className={clsx('input', f.required && !value(f.field) && 'border-amber-400')}
                value={value(f.field)}
                onChange={(e) => onField(f.field, e.target.value)}
              />
            </Field>
          ))}
        </div>
      </Card>

      {p.matrixRows.length > 0 && (
        <Card>
          <CardHeader title="Quantity matrix" subtitle="As it will be created" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Colour</th>
                  {p.sizes.map((s) => <th key={s} className="th text-right">{s}</th>)}
                  <th className="th text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {p.matrixRows.map((r) => (
                  <tr key={r.color}>
                    <td className="td font-medium">{r.color}</td>
                    {p.sizes.map((s) => (
                      <td key={s} className="td tnum text-right text-ink-700">
                        {r.cells[s] ? r.cells[s].toLocaleString() : <span className="text-ink-300">—</span>}
                      </td>
                    ))}
                    <td className="td tnum text-right font-semibold">{r.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-ink-300 bg-ink-50">
                <tr>
                  <td className="td font-semibold">Total</td>
                  {p.sizes.map((s) => (
                    <td key={s} className="td tnum text-right font-semibold">
                      {p.matrixRows.reduce((a, r) => a + (r.cells[s] ?? 0), 0).toLocaleString()}
                    </td>
                  ))}
                  <td className="td tnum text-right font-bold">{p.matrixTotal.toLocaleString()}</td>
                </tr>
              </tfoot>
            </table>
          </div>
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
            <span className="mt-0.5 block text-xs text-ink-500">
              Commits available stock to this order and reports anything genuinely short. Nothing is
              issued or consumed — the material stays on the shelf.
            </span>
          </label>
        </div>
      </Card>

      <div className="flex justify-between">
        <button className="btn-secondary" onClick={onBack} disabled={committing}>
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <button className="btn-primary" onClick={onConfirm} disabled={!canCommit || committing}>
          {committing ? 'Creating the order…' : 'Confirm import'}
        </button>
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
