/**
 * The laying sheet's own tables on the Laying & Marker screen.
 *
 * The factory's sheet is more than its lays: per colour and size it has a
 * PIECES table (with EFF / LENGHT / RATE above it), a LAYER table and a METER
 * table; per fabric and colour a fabric table in the bill-of-materials layout
 * (Item Sort / Dep. | Item | Description | Color | Qty | Unit | Material
 * issued | Shortage | Issued to); and the cut notes, the fabric date and the
 * sign-offs. These are shown here as the sheet lays them out.
 */

import { useState } from 'react';
import { fmtDate } from '@opsflow/shared';
import { Card, CardHeader, Num, EmptyState, clsx } from './ui';

export interface SheetColourTable {
  block: number;
  kind: 'PIECES' | 'LAYERS' | 'METERS';
  title: string | null;
  sizes: string[];
  rows: Array<{ fabric: string | null; colour: string; panel: string | null; bySize: Record<string, number>; total: number | null }>;
  totals: { bySize: Record<string, number>; total: number | null } | null;
  params: { eff: Record<string, number>; markerLengthM: Record<string, number>; rate: Record<string, number> } | null;
}

export interface LayingSheet {
  jobId: string;
  fileName: string;
  importedAt: string | null;
  header?: { cutNotes?: string | null; fabricDateToExternal?: string | null; spreadNotes?: string | null } | null;
  signatures?: Record<string, string | null> | null;
  sizes?: string[];
  colourTables?: SheetColourTable[];
}

const KIND_LABEL: Record<SheetColourTable['kind'], string> = { PIECES: 'Pieces', LAYERS: 'Layers', METERS: 'Metres' };

const cellText = (n: number | null | undefined, places = 2) =>
  n == null ? '' : n.toLocaleString('en-US', { maximumFractionDigits: places });

/**
 * The sheet's colour × size tables: Pieces (with Eff %, Length and Rate per
 * size), Layers and Metres. The sheet keeps a second set to the right — the
 * planner's working copy — shown when it holds anything.
 */
export function ColourTablesCard({ sheet }: { sheet: LayingSheet }) {
  const tables = sheet.colourTables ?? [];
  const blocks = [...new Set(tables.map((t) => t.block))].sort((a, b) => a - b)
    .filter((b) => tables.some((t) => t.block === b && t.rows.some((r) => Object.values(r.bySize).some((v) => v !== 0))));
  const [kind, setKind] = useState<SheetColourTable['kind']>('PIECES');
  const [block, setBlock] = useState(blocks[0] ?? 1);
  if (tables.length === 0 || blocks.length === 0) return null;

  const table = tables.find((t) => t.block === block && t.kind === kind) ?? tables.find((t) => t.block === block)!;
  const sizes = table.sizes.filter((s) => table.rows.some((r) => r.bySize[s] != null) || table.params?.rate[s] != null || table.totals?.bySize[s] != null);
  const kinds = (['PIECES', 'LAYERS', 'METERS'] as const).filter((k) => tables.some((t) => t.block === block && t.kind === k));
  const params = kind === 'PIECES' ? tables.find((t) => t.block === block && t.kind === 'PIECES')?.params ?? null : null;

  return (
    <Card>
      <CardHeader
        title="Cut tables by colour"
        subtitle={`As on the laying sheet ${sheet.fileName}${sheet.importedAt ? `, imported ${fmtDate(sheet.importedAt)}` : ''}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {blocks.length > 1 && (
              <div className="inline-flex rounded-md border border-ink-200 p-0.5 text-xs">
                {blocks.map((b, i) => (
                  <button key={b} type="button" onClick={() => setBlock(b)}
                    className={clsx('rounded px-2 py-1', block === b ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50')}>
                    {i === 0 ? 'Main tables' : 'Working copy'}
                  </button>
                ))}
              </div>
            )}
            <div className="inline-flex rounded-md border border-ink-200 p-0.5 text-xs" role="tablist">
              {kinds.map((k) => (
                <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                  className={clsx('rounded px-2.5 py-1', kind === k ? 'bg-accent-600 text-white' : 'text-ink-600 hover:bg-ink-50')}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            {params && (['eff', 'markerLengthM', 'rate'] as const).map((p) => (
              Object.keys(params[p]).length === 0 ? null : (
                <tr key={p} className="border-b border-ink-100 bg-white">
                  <th colSpan={3} className="px-3 py-1 text-right text-2xs font-semibold uppercase tracking-wider text-ink-500">
                    {p === 'eff' ? 'Eff %' : p === 'markerLengthM' ? 'Length (m)' : 'Rate (pcs / layer)'}
                  </th>
                  {sizes.map((s) => (
                    <td key={s} className="px-2 py-1 text-center text-xs tnum text-ink-600">
                      {params[p][s] == null ? '' : p === 'eff' ? `${cellText(params[p][s], 1)}%` : cellText(params[p][s])}
                    </td>
                  ))}
                  <td />
                </tr>
              )
            ))}
            <tr>
              <th className="th">Fabric</th>
              <th className="th">Colour</th>
              <th className="th">Panel</th>
              {sizes.map((s) => <th key={s} className="th text-center">{s}</th>)}
              <th className="th text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {table.rows.map((r, i) => (
              <tr key={`${r.colour}-${i}`}>
                <td className="td text-xs">{r.fabric ?? '—'}</td>
                <td className="td text-xs font-medium">{r.colour}</td>
                <td className="td text-xs text-ink-500">{r.panel ?? '—'}</td>
                {sizes.map((s) => (
                  <td key={s} className="td text-center">
                    <span className={clsx('tnum text-sm', !r.bySize[s] && 'text-ink-300', (r.bySize[s] ?? 0) < 0 && 'text-red-600')}>
                      {r.bySize[s] ? cellText(r.bySize[s]) : '·'}
                    </span>
                  </td>
                ))}
                <td className="td text-right font-semibold tnum">{cellText(r.total ?? Object.values(r.bySize).reduce((a, b) => a + b, 0))}</td>
              </tr>
            ))}
          </tbody>
          {table.totals && (
            <tfoot>
              <tr className="border-t-2 border-ink-300 bg-ink-100">
                <td colSpan={3} className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-600">Totals</td>
                {sizes.map((s) => (
                  <td key={s} className="px-2 py-2 text-center text-sm font-semibold tnum">{cellText(table.totals!.bySize[s]) || '·'}</td>
                ))}
                <td className="px-3 py-2 text-right text-sm font-bold tnum">{cellText(table.totals.total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}

export interface FabricRow {
  id?: string;
  fabric: string; color: string; requiredM: number;
  issuedM: number | null; actualConsumptionM: number | null; shortageM: number;
  description?: string | null; issuedTo?: string | null; notes?: string | null; fromSheet?: boolean;
}

/** Fabric per fabric and colour, in the laying sheet's fabric-table layout. */
export function FabricPositionCard({ fabrics }: { fabrics: FabricRow[] }) {
  const total = fabrics.reduce((a, f) => a + f.requiredM, 0);
  return (
    <Card>
      <CardHeader
        title="Fabric position"
        subtitle={fabrics.length > 0 ? `${fabrics.length} fabric/colour${fabrics.length === 1 ? '' : 's'} · ${Math.round(total).toLocaleString()} m required` : undefined}
      />
      {fabrics.length === 0 ? (
        <EmptyState title="No fabric records" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">Item sort / Dep.</th>
                <th className="th">Item</th>
                <th className="th">Description</th>
                <th className="th">Colour</th>
                <th className="th text-right">Qty</th>
                <th className="th">Unit</th>
                <th className="th text-right">Material issued</th>
                <th className="th text-right">Consumed</th>
                <th className="th text-right">Shortage</th>
                <th className="th">Issued to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {fabrics.map((f, i) => (
                <tr key={f.id ?? i}>
                  <td className="td text-xs text-ink-500">Fabric</td>
                  <td className="td font-medium">{f.fabric}</td>
                  <td className="td text-xs">{f.description || '—'}</td>
                  <td className="td text-xs">{f.color || '—'}</td>
                  <td className="td text-right font-semibold"><Num value={f.requiredM} places={f.requiredM % 1 === 0 ? 0 : 2} /></td>
                  <td className="td text-xs text-ink-500">m</td>
                  <td className="td text-right"><Num value={f.issuedM} places={(f.issuedM ?? 0) % 1 === 0 ? 0 : 2} fallback="—" /></td>
                  <td className="td text-right"><Num value={f.actualConsumptionM} places={(f.actualConsumptionM ?? 0) % 1 === 0 ? 0 : 2} fallback="—" /></td>
                  <td className="td text-right">
                    {f.issuedM == null ? <span className="text-ink-300">—</span> : (
                      <span className={clsx('tnum text-sm font-semibold', f.shortageM > 0 ? 'text-red-600' : 'text-emerald-600')}>
                        {f.shortageM > 0 ? `${(Math.round(f.shortageM * 100) / 100).toLocaleString()} m` : 'Covered'}
                      </span>
                    )}
                  </td>
                  <td className="td text-xs">{f.issuedTo || '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-300 bg-ink-100">
                <td colSpan={4} className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-600">Total</td>
                <td className="px-3 py-2 text-right text-sm font-bold tnum">{(Math.round(total * 100) / 100).toLocaleString()}</td>
                <td className="px-3 py-2 text-xs text-ink-500">m</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

export interface CuttingRow {
  id: string; cutDate: string | null; cuttingTeam: string | null; cutByName: string | null;
  inspectedByName: string | null; numberingByName?: string | null; bundledByName?: string | null; approvedByName?: string | null;
  actualCutQty: number | null; fabricUsedM: number | null; notes: string | null;
}

/** "Cut notes: …" lines of a note, as label and value. */
function noteLines(notes: string | null): Array<{ label: string | null; value: string }> {
  return (notes ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^([A-Za-z][A-Za-z /]{1,40}):\s*(.*)$/);
    return m ? { label: m[1]!, value: m[2]! } : { label: null, value: l };
  });
}

/**
 * Cutting: the laying sheet's own record — fabric date to external, cut
 * notes, and who cut, numbered, inspected, bundled and approved — then every
 * cut recorded since.
 */
export function CuttingCard({ cutting }: { cutting: CuttingRow[] }) {
  // A record with no date and no quantity is the sheet's sign-off block, not a cut.
  const isSheet = (c: CuttingRow) => !c.cutDate && c.actualCutQty == null && c.fabricUsedM == null;
  const sheets = cutting.filter(isSheet);
  const cuts = cutting.filter((c) => !isSheet(c));
  const signOffs = (c: CuttingRow) => [
    ['Cut by', c.cutByName], ['Numbering', c.numberingByName], ['Inspected', c.inspectedByName],
    ['Bundled', c.bundledByName], ['Approved', c.approvedByName],
  ] as Array<[string, string | null | undefined]>;

  return (
    <Card>
      <CardHeader title="Cutting records" subtitle="The laying sheet's notes and sign-offs, then each cut recorded" />
      {cutting.length === 0 ? (
        <EmptyState title="Nothing cut yet" />
      ) : (
        <div className="space-y-4 p-4">
          {sheets.map((c) => {
            const lines = noteLines(c.notes);
            const dateLine = lines.find((l) => /fabric date/i.test(l.label ?? ''));
            const other = lines.filter((l) => l !== dateLine);
            return (
              <dl key={c.id} className="grid gap-x-6 gap-y-3 rounded-md border border-ink-200 bg-ink-50/50 p-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="label">Fabric date to external</dt>
                  <dd className="text-sm font-medium text-ink-900">{dateLine?.value ? fmtDate(dateLine.value) : '—'}</dd>
                </div>
                {signOffs(c).map(([k, v]) => (
                  <div key={k}>
                    <dt className="label">{k}</dt>
                    <dd className={clsx('text-sm', v ? 'font-medium text-ink-900' : 'text-ink-300')}>{v || '—'}</dd>
                  </div>
                ))}
                <div className="sm:col-span-2 lg:col-span-3">
                  <dt className="label">Cut notes</dt>
                  <dd className="whitespace-pre-line text-sm text-ink-800" dir="auto">
                    {other.length === 0 ? <span className="text-ink-300">—</span>
                      : other.map((l, i) => <span key={i} className="block">{l.label && !/^cut notes$/i.test(l.label) ? `${l.label}: ` : ''}{l.value}</span>)}
                  </dd>
                </div>
              </dl>
            );
          })}
          {cuts.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-ink-200">
              <table className="w-full">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    <th className="th">Date</th>
                    <th className="th">Team</th>
                    <th className="th">Cut by</th>
                    <th className="th">Signed off</th>
                    <th className="th text-right">Qty</th>
                    <th className="th text-right">Fabric used</th>
                    <th className="th">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {cuts.map((c) => (
                    <tr key={c.id}>
                      <td className="td">{c.cutDate ? fmtDate(c.cutDate) : '—'}</td>
                      <td className="td text-xs">{c.cuttingTeam || '—'}</td>
                      <td className="td text-xs">{c.cutByName || '—'}</td>
                      <td className="td text-xs text-ink-600">
                        {signOffs(c).slice(1).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}
                      </td>
                      <td className="td text-right font-semibold"><Num value={c.actualCutQty} fallback="—" /></td>
                      <td className="td text-right"><Num value={c.fabricUsedM} places={0} suffix=" m" fallback="—" /></td>
                      <td className="td max-w-[18rem] whitespace-normal text-xs text-ink-600" dir="auto">{c.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
