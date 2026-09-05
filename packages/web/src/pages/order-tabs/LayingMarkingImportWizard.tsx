/**
 * Laying & Marking Excel import — launched from MarkerTab.
 *
 * Three steps, same principle as the whole-order ImportWizard: nothing is
 * written until Confirm, and every correction re-reads the stored file
 * rather than trusting client state.
 *
 *   Upload   drag a file in, or browse
 *   Map      what was found, what's unsure, fix any column
 *   Review   every detected lay, existing lays it collides with, and what to
 *            do about each collision, then confirm
 */

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Upload, AlertTriangle, Info, ArrowRight, ArrowLeft, Loader2,
} from 'lucide-react';
import { CONCEPT_META, ImportConcept, type ColumnAnalysis } from '@opsflow/shared';
import { api, type LayingImportAnalysisDto, type LayingRowDto } from '../../lib/api';
import { Modal, Card, CardHeader, EmptyState, ErrorNote, clsx, useToast } from '../../components/ui';

type Step = 'upload' | 'map' | 'review';
type Resolution = 'KEEP' | 'REPLACE' | 'ADD_NEW';

/** Only the concepts this importer recognises — a laying sheet's coordinator should not see order-import concepts in the dropdown. */
const LAYING_CONCEPT_KEYS: ImportConcept[] = [
  ImportConcept.LAY_NUMBER, ImportConcept.MARKER_NUMBER, ImportConcept.FABRIC, ImportConcept.COLOR,
  ImportConcept.PANEL, ImportConcept.SIZE_RATIO, ImportConcept.LAYERS, ImportConcept.MARKER_LENGTH,
  ImportConcept.MARKER_WIDTH, ImportConcept.TOTAL_LENGTH, ImportConcept.FABRIC_CONSUMPTION,
  ImportConcept.WASTAGE, ImportConcept.NEST_PCS, ImportConcept.EFFICIENCY, ImportConcept.CUT_DATE,
  ImportConcept.RESPONSIBLE_PERSON, ImportConcept.PO_NUMBER, ImportConcept.NOTES, ImportConcept.IGNORE,
];
const CONCEPT_OPTIONS = LAYING_CONCEPT_KEYS.map((k) => ({ value: k, label: CONCEPT_META[k].label }));

export function LayingMarkingImportWizard({
  orderId, orderPoNumber, onClose,
}: {
  orderId: string;
  orderPoNumber: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [analysis, setAnalysis] = useState<LayingImportAnalysisDto | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (f: File) => api.layingImport.upload(orderId, f),
    onSuccess: (result) => {
      setAnalysis(result);
      setResolutions(Object.fromEntries(result.conflicts.map((c) => [c.key, 'REPLACE' as Resolution])));
      setStep('map');
    },
    onError: (e) => toast.error(e),
  });

  const remap = useMutation({
    mutationFn: (mapping: Record<string, string>) =>
      api.layingImport.remap(orderId, analysis!.jobId, { columnMapping: mapping }),
    onSuccess: (result) => {
      setAnalysis(result);
      setResolutions((prev) => {
        const next = { ...prev };
        for (const c of result.conflicts) if (!(c.key in next)) next[c.key] = 'REPLACE';
        return next;
      });
    },
    onError: (e) => toast.error(e),
  });

  const commit = useMutation({
    mutationFn: () => api.layingImport.commit(orderId, analysis!.jobId, resolutions),
    onSuccess: (result) => {
      toast.success(
        `Imported: ${result.markersCreated} lay${result.markersCreated === 1 ? '' : 's'} added` +
        (result.markersUpdated > 0 ? `, ${result.markersUpdated} replaced` : ''),
      );
      qc.invalidateQueries({ queryKey: ['markers', orderId] });
      qc.invalidateQueries({ queryKey: ['laying-import-history', orderId] });
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const handleFile = useCallback((f: File | undefined) => {
    if (!f) return;
    setFile(f);
    upload.mutate(f);
  }, [upload]);

  const onChangeColumn = (index: number, concept: string) => {
    const next = { ...columnMapping, [String(index)]: concept };
    setColumnMapping(next);
  };

  return (
    <Modal open onClose={onClose} title="Import Laying & Marking Excel" subtitle={`PO ${orderPoNumber}`} wide>
      <div className="space-y-4">
        {step === 'upload' && (
          <Card>
            <div className="p-5">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
                className={clsx(
                  'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors',
                  dragging ? 'border-accent-500 bg-accent-50' : 'border-ink-300 bg-ink-50/50',
                )}
              >
                {upload.isPending ? (
                  <>
                    <Loader2 className="mb-3 h-8 w-8 animate-spin text-accent-600" />
                    <p className="text-sm font-medium text-ink-800">Reading {file?.name}…</p>
                    <p className="mt-1 text-xs text-ink-500">Finding the lay table and working out the columns.</p>
                  </>
                ) : (
                  <>
                    <Upload className="mb-3 h-8 w-8 text-ink-400" />
                    <p className="text-sm font-medium text-ink-800">Drop a Laying & Marking Excel file here</p>
                    <p className="mt-1 text-xs text-ink-500">or</p>
                    <button className="btn-secondary btn-sm mt-2" onClick={() => inputRef.current?.click()}>
                      Browse files
                    </button>
                    <input
                      ref={inputRef} type="file" accept=".xlsx,.xlsm" className="hidden"
                      onChange={(e) => handleFile(e.target.files?.[0])}
                    />
                    <p className="mt-4 max-w-md text-2xs text-ink-400">
                      .xlsx or .xlsm, up to 25 MB. Any layout — column headings such as Fabric, Layers,
                      Marker Length or No. of Ply are recognised however they're worded.
                    </p>
                  </>
                )}
              </div>
              {upload.isError && <div className="mt-3"><ErrorNote error={upload.error} /></div>}
            </div>
          </Card>
        )}

        {step === 'map' && analysis && (
          <MapStep
            analysis={analysis}
            columnMapping={columnMapping}
            busy={remap.isPending}
            onChange={onChangeColumn}
            onBack={() => setStep('upload')}
            onNext={() => {
              if (Object.keys(columnMapping).length > 0) remap.mutate(columnMapping, { onSuccess: () => setStep('review') });
              else setStep('review');
            }}
          />
        )}

        {step === 'review' && analysis && (
          <ReviewStep
            analysis={analysis}
            resolutions={resolutions}
            onResolutionChange={(key, r) => setResolutions((prev) => ({ ...prev, [key]: r }))}
            onBack={() => setStep('map')}
            onConfirm={() => commit.mutate()}
            committing={commit.isPending}
          />
        )}
      </div>
    </Modal>
  );
}

function IssueList({ issues }: { issues: LayingImportAnalysisDto['issues'] }) {
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-ink-100 p-4">
      {issues.map((issue, i) => (
        <div
          key={i}
          className={clsx(
            'flex items-start gap-2 rounded-md px-3 py-2 text-xs',
            issue.level === 'ERROR' ? 'bg-red-50 text-red-800'
              : issue.level === 'WARNING' ? 'bg-amber-50 text-amber-800'
              : 'bg-ink-50 text-ink-600',
          )}
        >
          {issue.level === 'INFO' ? <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

function MapStep({
  analysis, columnMapping, busy, onChange, onBack, onNext,
}: {
  analysis: LayingImportAnalysisDto;
  columnMapping: Record<string, string>;
  busy: boolean;
  onChange: (index: number, concept: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const unconfirmed = analysis.columns.filter((c: ColumnAnalysis) => c.needsConfirmation);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`Sheet: ${analysis.sheetName || '(none found)'}`}
          subtitle={
            unconfirmed.length === 0
              ? `Every column was recognised. ${analysis.rows.length} lay${analysis.rows.length === 1 ? '' : 's'} detected.`
              : `${unconfirmed.length} column${unconfirmed.length === 1 ? '' : 's'} need${unconfirmed.length === 1 ? 's' : ''} confirming`
          }
        />
        {analysis.columns.length === 0 ? (
          <EmptyState title="No table detected" detail="Try a different sheet, or check the file has a header row." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Column in the file</th>
                  <th className="th">Sample values</th>
                  <th className="th w-56">What it represents</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {analysis.columns.map((c) => {
                  const value = columnMapping[String(c.index)] ?? c.concept;
                  const flagged = c.needsConfirmation && !columnMapping[String(c.index)];
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
                        <select className="input" value={value} disabled={busy} onChange={(e) => onChange(c.index, e.target.value)}>
                          {CONCEPT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <IssueList issues={analysis.issues} />
      </Card>

      <div className="flex justify-between">
        <button className="btn-secondary" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</button>
        <button className="btn-primary" onClick={onNext} disabled={busy || !analysis.canCommit}>
          {busy ? 'Re-reading…' : 'Review'} <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ReviewStep({
  analysis, resolutions, onResolutionChange, onBack, onConfirm, committing,
}: {
  analysis: LayingImportAnalysisDto;
  resolutions: Record<string, Resolution>;
  onResolutionChange: (key: string, r: Resolution) => void;
  onBack: () => void;
  onConfirm: () => void;
  committing: boolean;
}) {
  const conflictByKey = new Map(analysis.conflicts.map((c) => [c.key, c]));
  const conflictKeys = analysis.conflicts.map((c) => c.key);

  return (
    <div className="space-y-4">
      {analysis.priorImportExists && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>A Laying & Marking file has already been imported for this order. Check this isn't a duplicate upload before confirming.</span>
        </div>
      )}

      {conflictKeys.length > 0 && (
        <div className="flex items-center justify-between rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
          <span>{conflictKeys.length} row{conflictKeys.length === 1 ? '' : 's'} match an existing lay — choose what to do with each.</span>
          <div className="flex gap-1.5">
            {(['KEEP', 'REPLACE', 'ADD_NEW'] as Resolution[]).map((r) => (
              <button
                key={r} className="btn-ghost btn-sm"
                onClick={() => conflictKeys.forEach((k) => onResolutionChange(k, r))}
              >
                Set all: {r === 'KEEP' ? 'Keep' : r === 'REPLACE' ? 'Replace' : 'Add new'}
              </button>
            ))}
          </div>
        </div>
      )}

      <Card>
        <CardHeader title="Detected lays" subtitle={`${analysis.rows.length} row${analysis.rows.length === 1 ? '' : 's'}`} />
        {analysis.rows.length === 0 ? (
          <EmptyState title="No lays to import" detail="Go back and check the column mapping." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">#</th>
                  <th className="th">Fabric</th>
                  <th className="th">Panel</th>
                  <th className="th">Size ratio</th>
                  <th className="th text-right">Layers</th>
                  <th className="th text-right">Marker (m)</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {analysis.rows.map((row: LayingRowDto) => {
                  const key = row.markerNumber ? `marker:${row.markerNumber}` : `row:${row.rowNumber}`;
                  const conflict = conflictByKey.get(key);
                  return (
                    <RowLine
                      key={row.rowNumber} row={row} conflict={conflict}
                      resolution={resolutions[key]} onResolutionChange={(r) => onResolutionChange(key, r)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <IssueList issues={analysis.issues} />
      </Card>

      <div className="flex justify-between">
        <button className="btn-secondary" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</button>
        <button className="btn-primary" onClick={onConfirm} disabled={committing || !analysis.canCommit || analysis.rows.length === 0}>
          {committing ? 'Importing…' : 'Confirm import'}
        </button>
      </div>
    </div>
  );
}

function RowLine({
  row, conflict, resolution, onResolutionChange,
}: {
  row: LayingRowDto;
  conflict: LayingImportAnalysisDto['conflicts'][number] | undefined;
  resolution: Resolution | undefined;
  onResolutionChange: (r: Resolution) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  return (
    <>
      <tr className={clsx(conflict && 'bg-amber-50/40')}>
        <td className="td tnum text-ink-400">{row.rowNumber}</td>
        <td className="td text-xs">{row.fabricName || <span className="text-ink-300">—</span>}{row.fabricColor && <span className="text-ink-400"> · {row.fabricColor}</span>}</td>
        <td className="td text-xs">{row.panel}</td>
        <td className="td font-mono text-2xs text-ink-600">{row.sizeRatio || '—'}</td>
        <td className="td text-right tnum">{row.layers ?? '—'}</td>
        <td className="td text-right tnum">{row.markerLengthM ?? '—'}</td>
        <td className="td">
          {conflict ? (
            <div className="flex items-center gap-2">
              <select
                className="input input-sm"
                value={resolution ?? 'REPLACE'}
                onChange={(e) => onResolutionChange(e.target.value as Resolution)}
              >
                <option value="KEEP">Keep existing</option>
                <option value="REPLACE">Replace</option>
                <option value="ADD_NEW">Add as new</option>
              </select>
              <button className="text-2xs text-accent-600 underline" onClick={() => setShowDiff((v) => !v)}>
                {showDiff ? 'Hide' : 'Compare'}
              </button>
            </div>
          ) : (
            <span className="chip bg-emerald-50 text-emerald-700 ring-emerald-600/20">New</span>
          )}
        </td>
      </tr>
      {conflict && showDiff && (
        <tr className="bg-ink-50">
          <td colSpan={7} className="px-3 py-2 text-2xs">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="font-semibold text-ink-600">Current value</p>
                <p>Fabric: {conflict.existing.fabricName}{conflict.existing.fabricColor ? ` · ${conflict.existing.fabricColor}` : ''}</p>
                <p>Layers: {conflict.existing.layers} · Marker length: {conflict.existing.markerLengthM} m</p>
              </div>
              <div>
                <p className="font-semibold text-ink-600">Imported value</p>
                <p>Fabric: {row.fabricName}{row.fabricColor ? ` · ${row.fabricColor}` : ''}</p>
                <p>Layers: {row.layers ?? '—'} · Marker length: {row.markerLengthM ?? '—'} m</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
