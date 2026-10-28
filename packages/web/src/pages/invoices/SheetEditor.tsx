/**
 * A proforma's shipment, exporter and per-style details — the fields the
 * factory's own Excel proforma types above and below its table, and on each
 * style's row. What is typed here is kept on the document; the figures —
 * totals, cartons, % of container, ETA — are worked out by `buildSheet` as
 * the preview is drawn.
 */

import { HTS_CODES, SHEET_DEFAULTS, sheetEta, type ProformaSheetSettings, type SheetRow } from '@opsflow/shared';
import { ComboSelect } from '../../components/ComboSelect';
import { Card, Field, Num } from '../../components/ui';

const TOP_TEXT = ['title', 'statement', 'shipmentFrom', 'container', 'onBoardDate', 'etd', 'portFrom', 'portTo',
  'consolidatingVendor', 'cartonSize', 'exporterName', 'exporterAddress', 'qizRef', 'destination', 'signatory'] as const;
const TOP_NUM = ['cartonsPerContainer', 'leadDays'] as const;
const ROW_TEXT = ['description', 'po', 'partNo', 'hts', 'unit'] as const;
const ROW_NUM = ['gw', 'nw', 'perCarton', 'cartons'] as const;

/** The details as the form holds them: every field a string, so "12." can be typed. */
export interface SheetDraft {
  top: Record<(typeof TOP_TEXT)[number] | (typeof TOP_NUM)[number], string>;
  rows: Record<string, Partial<Record<(typeof ROW_TEXT)[number] | (typeof ROW_NUM)[number], string>>>;
}

const str = (v: unknown) => (v == null ? '' : String(v));
const num = (s: string | undefined): number | null => {
  const t = (s ?? '').trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function sheetDraftFrom(s: ProformaSheetSettings | null): SheetDraft {
  const top = Object.fromEntries([...TOP_TEXT, ...TOP_NUM].map((k) => [k, str(s?.[k])])) as SheetDraft['top'];
  const rows: SheetDraft['rows'] = {};
  for (const [key, r] of Object.entries(s?.rows ?? {})) {
    const out: SheetDraft['rows'][string] = {};
    for (const k of [...ROW_TEXT, ...ROW_NUM]) if (r[k] != null && r[k] !== '') out[k] = str(r[k]);
    rows[key] = out;
  }
  return { top, rows };
}

export function sheetSettingsFrom(d: SheetDraft): ProformaSheetSettings {
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  const out: ProformaSheetSettings = {};
  for (const k of TOP_TEXT) out[k] = t(d.top[k]);
  for (const k of TOP_NUM) out[k] = num(d.top[k]);
  const rows: NonNullable<ProformaSheetSettings['rows']> = {};
  for (const [key, r] of Object.entries(d.rows)) {
    const row: NonNullable<ProformaSheetSettings['rows']>[string] = {};
    for (const k of ROW_TEXT) { const v = t(r[k] ?? ''); if (v != null) row[k] = v; }
    for (const k of ROW_NUM) { const v = num(r[k]); if (v != null) row[k] = v; }
    if (Object.keys(row).length > 0) rows[key] = row;
  }
  out.rows = rows;
  return out;
}

/** What would stop a save: a number field holding something that is not a number. */
export function sheetProblem(d: SheetDraft): string | null {
  for (const k of TOP_NUM) if (d.top[k].trim() !== '' && num(d.top[k]) == null) return `Shipment: "${d.top[k]}" is not a number.`;
  for (const k of ['onBoardDate', 'etd'] as const) if (d.top[k] && !/^\d{4}-\d{2}-\d{2}$/.test(d.top[k])) return 'Shipment: a date is not complete.';
  for (const r of Object.values(d.rows)) for (const k of ROW_NUM) if ((r[k] ?? '').trim() !== '' && num(r[k]) == null) return `Styles: "${r[k]}" is not a number.`;
  return null;
}

type TopField = (k: keyof SheetDraft['top'], label: string, placeholder?: string, hint?: string) => JSX.Element;
const topField = (draft: SheetDraft, onChange: (d: SheetDraft) => void): TopField => (k, label, placeholder, hint) => (
  <Field label={label} hint={hint}>
    <input className="input text-xs" dir="auto" value={draft.top[k]} placeholder={placeholder} onChange={(e) => onChange({ ...draft, top: { ...draft.top, [k]: e.target.value } })} />
  </Field>
);

/** The shipment block of a proforma. */
export function ShipmentEditor({ draft, onChange }: { draft: SheetDraft; onChange: (d: SheetDraft) => void }) {
  const top = (k: keyof SheetDraft['top'], v: string) => onChange({ ...draft, top: { ...draft.top, [k]: v } });
  const eta = sheetEta(draft.top.etd || null, num(draft.top.leadDays) ?? SHEET_DEFAULTS.leadDays);
  const text = topField(draft, onChange);
  return (
      <Card>
        <div className="card-header"><h3 className="card-title">Shipment</h3></div>
        <div className="grid grid-cols-2 gap-3 p-4">
          {text('shipmentFrom', 'Shipment from', SHEET_DEFAULTS.shipmentFrom)}
          {text('container', 'Container', SHEET_DEFAULTS.container)}
          <Field label="On board date"><input type="date" className="input text-xs" value={draft.top.onBoardDate} onChange={(e) => top('onBoardDate', e.target.value)} /></Field>
          <Field label="ETD"><input type="date" className="input text-xs" value={draft.top.etd} onChange={(e) => top('etd', e.target.value)} /></Field>
          <Field label="Lead time (days)" hint={eta ? `ETA = ETD + days: ${eta}` : 'ETA = ETD + days'}>
            <input className="input tnum text-xs" inputMode="numeric" value={draft.top.leadDays} placeholder={String(SHEET_DEFAULTS.leadDays)} onChange={(e) => top('leadDays', e.target.value)} />
          </Field>
          <Field label="Cartons per container" hint="% of container = cartons ÷ this">
            <input className="input tnum text-xs" inputMode="numeric" value={draft.top.cartonsPerContainer} placeholder={String(SHEET_DEFAULTS.cartonsPerContainer)} onChange={(e) => top('cartonsPerContainer', e.target.value)} />
          </Field>
          {text('portFrom', 'From (port)', 'Cairo/Egypt')}
          {text('portTo', 'To (port)', 'L/A')}
          {text('consolidatingVendor', 'Consolidating vendor')}
          {text('cartonSize', 'Carton size', '45x45x65CM')}
        </div>
        <p className="border-t border-ink-100 px-4 py-2 text-2xs text-ink-500">Shipment to and its address are the Bill to block.</p>
      </Card>
  );
}

/** The exporter block and the wording at the bottom of every document; blank fields print the letterhead's. */
export function ExporterEditor({ draft, onChange, defaultTitle, letterhead, wording }: {
  draft: SheetDraft; onChange: (d: SheetDraft) => void; defaultTitle: string;
  letterhead: { name: string; address: string | null; qizRef?: string | null; signatory?: string | null };
  /** The title line and the QIZ statement print on a proforma only. */
  wording: boolean;
}) {
  const text = topField(draft, onChange);
  return (
      <Card>
        <div className="card-header"><h3 className="card-title">{wording ? 'Exporter & wording' : 'Exporter'}</h3></div>
        <div className="grid grid-cols-2 gap-3 p-4">
          {wording && <div className="col-span-2">{text('title', 'Title line', defaultTitle, 'Printed under the letterhead when filled.')}</div>}
          {wording && <div className="col-span-2">{text('statement', 'Statement', SHEET_DEFAULTS.statement)}</div>}
          {text('exporterName', 'Exporter name', letterhead.name)}
          {text('qizRef', 'QIZ Ref. No.', letterhead.qizRef ?? '')}
          <div className="col-span-2">{text('exporterAddress', 'Exporter address', letterhead.address ?? '')}</div>
          {text('destination', 'Destination', 'Los Angeles, USA')}
          {text('signatory', 'Signed by', letterhead.signatory ?? '')}
        </div>
        <p className="border-t border-ink-100 px-4 py-2 text-2xs text-ink-500">The stamp, terms and bank details come from the letterhead; terms and bank details can be edited under Text.</p>
      </Card>
  );
}

/** Each style's PO, part number, HTS code, weights, cartons and unit. */
export function StylesEditor({ draft, onChange, rows, rates, onRate }: {
  draft: SheetDraft;
  onChange: (d: SheetDraft) => void;
  rows: SheetRow[];
  /** Each row's rate as typed on its goods lines, when they agree. */
  rates: Record<string, string>;
  /** Sets the rate of every goods line of a row. */
  onRate: (row: SheetRow, value: string) => void;
}) {
  const row = (key: string, k: keyof SheetDraft['rows'][string], v: string) =>
    onChange({ ...draft, rows: { ...draft.rows, [key]: { ...draft.rows[key], [k]: v } } });
  const knownHts = [...new Set([...HTS_CODES.map((h) => h.code), ...rows.map((r) => r.hts)])];
  const htsLabel = (code: string) => HTS_CODES.find((h) => h.code === code)?.label;

  return (
    <Card>
      <div className="card-header"><h3 className="card-title">Styles</h3><span className="text-2xs text-ink-500">{rows.length} style{rows.length === 1 ? '' : 's'}</span></div>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 [&>*]:border-b [&>*]:border-ink-100">
        {rows.length === 0 && <p className="px-4 py-3 text-xs text-ink-500">No goods lines yet. Rebuild from the order.</p>}
        {rows.map((r) => {
          const d = draft.rows[r.key] ?? {};
          const input = (k: keyof typeof d, label: string, placeholder: string, numeric = false) => (
            <label className="block">
              <span className="text-2xs text-ink-500">{label}</span>
              <input className={numeric ? 'input tnum !py-1 text-right text-xs' : 'input !py-1 text-xs'} dir={numeric ? undefined : 'auto'}
                inputMode={numeric ? 'decimal' : undefined} value={d[k] ?? ''} placeholder={placeholder} onChange={(e) => row(r.key, k, e.target.value)} />
            </label>
          );
          return (
            <div key={r.key} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-semibold text-ink-800" dir="auto">{r.style}</span>
                <span className="tnum shrink-0 text-ink-600">{r.qty.toLocaleString()} pcs · <Num value={r.total} kind="money" fallback="—" /></span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {input('description', 'Description', r.description)}
                {input('po', 'PO#', r.po)}
                {input('partNo', 'Part No.', '')}
                <label className="block">
                  <span className="text-2xs text-ink-500">HTS Code</span>
                  <ComboSelect allowCustom maxLength={30} className="input !py-1 text-xs" aria-label="HTS Code"
                    value={d.hts ?? r.hts} onChange={(e) => row(r.key, 'hts', e.target.value)}>
                    {knownHts.map((c) => <option key={c} value={c}>{htsLabel(c) ? `${c} · ${htsLabel(c)}` : c}</option>)}
                  </ComboSelect>
                </label>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                <label className="block">
                  <span className="text-2xs text-ink-500">Unit price</span>
                  <input className="input tnum !py-1 text-right text-xs" inputMode="decimal" value={rates[r.key] ?? ''}
                    placeholder={r.mixedRates ? 'mixed' : ''} title={r.mixedRates ? 'The colours of this style have different rates; typing one sets them all' : 'Sets the rate of every colour of this style'}
                    onChange={(e) => onRate(r, e.target.value)} />
                </label>
                {input('perCarton', 'Pcs / carton', String(r.perCarton), true)}
                {input('cartons', 'Cartons', `${r.cartons}`, true)}
                {input('unit', 'Unit', r.unit)}
                {input('gw', 'G.W', '', true)}
                {input('nw', 'N.W', '', true)}
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-ink-100 px-4 py-2 text-2xs text-ink-500">
        Cartons = Qty ÷ pieces per carton, rounded up, unless typed. Total = Qty × Unit price.
      </p>
    </Card>
  );
}
