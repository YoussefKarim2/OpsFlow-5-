/**
 * The factory proforma sheet, as it prints: the layout of the factory's own
 * Excel proforma ("Xara Proforma invoice No.64"). Title and QIZ line, the
 * shipment block, one row per style — Qty, PO#, Part No., Description, HTS
 * Code, G.W, N.W, cartons, unit, unit price, total, % of container — the
 * totals row, then the exporter block, terms, bank details and signature.
 *
 * Every figure comes from `buildSheet`, the same equations the Excel export
 * writes as formulas, so the screen and the download agree.
 */

import { InvoiceLineKind, InvoiceStatus, SHEET_DEFAULTS, buildSheet, defaultSheetTitle, sheetEta, type InvoiceDto } from '@opsflow/shared';
import { clsx } from './ui';

const money = (n: number | null) => (n == null ? '' : `$ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const rate = (n: number | null) => (n == null ? '' : `$ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);
const whole = (n: number | null) => (n == null ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 3 }));
const pct = (n: number | null) => (n == null ? '' : `${Math.round(n * 100)}%`);
/** "21-Oct-26", as the factory's sheet formats its dates. */
const dmy = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCDate()}-${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}-${String(d.getUTCFullYear()).slice(2)}`;
};

// The factory sheet's column widths, A to L.
const WIDTHS = [17.66, 20.83, 21.5, 49.33, 26.66, 8.83, 8.66, 16.83, 9.16, 19.5, 25.16, 19.5];
const TOTAL_WIDTH = WIDTHS.reduce((a, b) => a + b, 0);

export function ProformaSheetDocument({ doc }: { doc: InvoiceDto }) {
  const s = doc.sheet ?? {};
  const orders = doc.orders?.length ? doc.orders : [doc.order];
  const { rows, totals } = buildSheet(doc.lines, orders, s);
  const extras = doc.lines.filter((l) => l.kind === InvoiceLineKind.EXTRA);
  const extrasTotal = extras.reduce((a, l) => a + (l.lineTotal ?? 0), 0);
  const address = (doc.billToAddress ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lead = s.leadDays ?? SHEET_DEFAULTS.leadDays;
  const terms = (doc.terms ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  const bank = (doc.bankDetails ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  const exporter = s.exporterName ?? doc.seller.name;
  const watermark = doc.status === InvoiceStatus.VOID ? 'VOID' : doc.status === InvoiceStatus.DRAFT ? 'DRAFT' : null;
  const cartonsNote = `${whole(totals.cartons)} carton NW: ${totals.nw ? whole(totals.nw) : ''} KG. GW: ${totals.gw ? whole(totals.gw) : ''} KG.${s.cartonSize ? ` Size ${s.cartonSize}` : ''}`;

  const head: Array<[string, string]> = [
    ['Shipment From', s.shipmentFrom ?? SHEET_DEFAULTS.shipmentFrom],
    ['Date :', dmy(doc.date)],
    ['Shipment To', doc.billTo],
    ['Address :', address[0] ?? ''],
    ['', address[1] ?? ''],
    ['', address.slice(2).join(', ')],
    ['container', s.container ?? SHEET_DEFAULTS.container],
    ['On Board Date:', dmy(s.onBoardDate)],
    ['ETD:', dmy(s.etd)],
    ['ETA:', dmy(sheetEta(s.etd, lead))],
    ['Shipment From', s.portFrom ?? ''],
    ['Shipment To', s.portTo ?? ''],
    ['Consolidating vendor:', s.consolidatingVendor ?? ''],
    ['No. of cartons', cartonsNote],
  ];

  return (
    <div className="invoice-sheet print-document relative mx-auto w-full max-w-[210mm] overflow-hidden rounded-lg border border-ink-200 bg-white px-6 py-7 font-[Arial,Helvetica,sans-serif] text-[10.5px] leading-snug text-black shadow-card print:text-[9pt]">
      {watermark && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
          <span className={clsx('select-none -rotate-[28deg] text-[120px] font-black tracking-[0.3em] opacity-[0.07]', watermark === 'VOID' ? 'text-red-700' : 'text-black')}>{watermark}</span>
        </div>
      )}

      <h1 className="text-center text-[17px] font-bold leading-tight">{s.title?.trim() || defaultSheetTitle(doc.order.clientName, doc.number, doc.date)}</h1>
      <p className="mt-1 text-center text-[15px] font-bold">{s.statement ?? SHEET_DEFAULTS.statement}</p>

      <table className="mt-5 text-[12px]">
        <tbody>
          {head.map(([label, value], i) => (
            <tr key={i}>
              <td className="w-40 py-[2px] pr-3 align-top">{label}</td>
              <td className="py-[2px] align-top" dir="auto">
                {value}
                {label === 'ETA:' && <span className="ml-10 text-ink-700">Based on {lead} days lead time</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="mt-4 w-full table-fixed border-collapse text-[9.5px] font-bold">
        <colgroup>{WIDTHS.map((w, i) => <col key={i} style={{ width: `${(w / TOTAL_WIDTH) * 100}%` }} />)}</colgroup>
        <thead>
          <tr className="text-center">
            {['Qty', 'PO#', 'Part No.', 'Description', 'HTS Code', 'G.W', 'N.W', 'No. Of Cartons', 'Unit', 'UNIT Price in $', 'Total Price in $', '%ge of container'].map((h) => (
              <th key={h} className="border-2 border-black px-1 py-1.5 align-middle leading-tight">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={12} className="border border-black px-2 py-3 text-center font-normal italic text-ink-500">No goods lines.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.key} className="text-center align-middle">
              <td className="tnum border border-black px-1 py-1">{whole(r.qty)}</td>
              <td className="border border-black px-1 py-1 break-words">{r.po}</td>
              <td className="border border-black px-1 py-1 break-words">{r.partNo}</td>
              <td className="border border-black px-1.5 py-1 text-left" dir="auto">{r.description}</td>
              <td className="tnum border border-black px-1 py-1">{r.hts}</td>
              <td className="tnum border border-black px-1 py-1">{whole(r.gw)}</td>
              <td className="tnum border border-black px-1 py-1">{whole(r.nw)}</td>
              <td className="tnum border border-black px-1 py-1">{whole(r.cartons)}</td>
              <td className="border border-black px-1 py-1">{r.unit}</td>
              <td className="tnum border border-black px-1 py-1" title={r.mixedRates ? 'Average rate: this style has colours at different rates' : undefined}>
                {rate(r.unitPrice)}{r.mixedRates && <span className="font-normal"> avg</span>}
              </td>
              <td className="tnum border border-black px-1 py-1">{money(r.total)}</td>
              <td className="tnum border border-black px-1 py-1">{pct(r.containerShare)}</td>
            </tr>
          ))}
          <tr className="text-center text-[10.5px]">
            <td className="tnum border-2 border-black px-1 py-2">{whole(totals.qty)}</td>
            <td className="border-y-2 border-black" />
            <td className="border-y-2 border-black" />
            <td className="border-2 border-black px-1 py-2">Total</td>
            <td className="border-y-2 border-black" />
            <td className="tnum border-2 border-black px-1 py-2">{totals.gw ? whole(totals.gw) : ''}</td>
            <td className="tnum border-2 border-black px-1 py-2">{totals.nw ? whole(totals.nw) : ''}</td>
            <td className="tnum border-2 border-black px-1 py-2">{whole(totals.cartons)}</td>
            <td className="border-y-2 border-black" />
            <td className="border-y-2 border-black" />
            <td className="tnum border-2 border-black px-1 py-2">{money(totals.total)}</td>
            <td className="tnum border-2 border-black px-1 py-2">{pct(totals.containerShare)}</td>
          </tr>
          {extras.map((l, i) => (
            <tr key={l.id || `x${i}`} className="text-center">
              <td colSpan={3} />
              <td className="px-1.5 py-1 text-left" dir="auto">{l.description}</td>
              <td colSpan={6} />
              <td className="tnum px-1 py-1">{money(l.lineTotal)}</td>
              <td />
            </tr>
          ))}
          {extras.length > 0 && (
            <tr className="text-center text-[10.5px]">
              <td colSpan={3} />
              <td className="px-1.5 py-1 text-left">Amount due</td>
              <td colSpan={6} />
              <td className="tnum border-t-2 border-black px-1 py-1">{money(totals.total == null ? null : totals.total + extrasTotal)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      {doc.totals.incomplete && (
        <p className="mt-1 text-[10px] font-medium text-amber-800">One or more styles have no rate yet; the total covers only the priced styles.</p>
      )}

      <table className="mt-6 text-[12px] font-bold">
        <tbody>
          {([['Name :', exporter], ['Address :', s.exporterAddress ?? doc.seller.address ?? ''], ['QIZ Ref. No. :', s.qizRef ?? ''], ['Destination :', s.destination ?? ''], ['Exporter Name :', exporter]] as const).map(([l, v]) => (
            <tr key={l}><td className="w-40 py-[2px] pr-3 align-top">{l}</td><td className="py-[2px]" dir="auto">{v}</td></tr>
          ))}
        </tbody>
      </table>

      {(terms.length > 0 || bank.length > 0) && (
        <div className="avoid-break mt-5 text-[12px] font-bold">
          <p>Terms and conditions</p>
          <table className="mt-1">
            <tbody>
              {terms.map((t, i) => (
                <tr key={`t${i}`}><td className="w-8 py-[2px] align-top">{i + 1}</td><td colSpan={2} className="py-[2px]" dir="auto">{t.replace(/^\d+[.)]\s*/, '')}</td></tr>
              ))}
              {bank.map((b, i) => {
                const m = /^([^:]{1,40}):\s*(.*)$/.exec(b);
                return (
                  <tr key={`b${i}`}>
                    <td />
                    <td className="w-36 py-[2px] pr-3 align-top">{m ? m[1]!.trim() : b}</td>
                    <td className="py-[2px] font-mono text-[11px]">{m ? `: ${m[2]}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="avoid-break mt-6 text-[12px] font-bold">
        <p>For and in behalf of {exporter}</p>
        {s.signatory && <p className="mt-1">{s.signatory}</p>}
      </div>
    </div>
  );
}
