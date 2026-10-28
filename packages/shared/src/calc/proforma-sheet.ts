/**
 * The factory's proforma sheet: the layout of its own Excel proforma ("Xara
 * Proforma invoice No.64"), one row per style.
 *
 * Every figure the Excel sheet works out is worked out here, the same way:
 *
 *   Total            = Qty × Unit price
 *   No. of cartons   = Qty ÷ pieces per carton, rounded up (or typed)
 *   % of container   = cartons ÷ cartons a container holds
 *   ETA              = ETD + lead time in days
 *   Totals row       = the sum of each column
 *
 * What the Excel sheet types by hand — PO, part number, HTS code, weights,
 * dates, the QIZ and exporter blocks — is stored on the document as
 * `ProformaSheetSettings`, so a rebuild from the order keeps it.
 */

import { groupGoodsByStyle, sumGoods, type InvoiceLineInput } from './invoice.js';

/** What is typed for one style's row. Blank fields take the defaults below. */
export interface SheetRowSettings {
  description?: string | null;
  po?: string | null;
  partNo?: string | null;
  hts?: string | null;
  gw?: number | null;
  nw?: number | null;
  /** Pieces in one carton; the cartons are the quantity divided by this, rounded up. */
  perCarton?: number | null;
  /** Typed cartons, in place of the division. */
  cartons?: number | null;
  unit?: string | null;
}

/** The sheet's own fields, as the Excel proforma has them above and below the table. */
export interface ProformaSheetSettings {
  title?: string | null;
  statement?: string | null;
  shipmentFrom?: string | null;
  container?: string | null;
  cartonsPerContainer?: number | null;
  onBoardDate?: string | null;
  etd?: string | null;
  leadDays?: number | null;
  portFrom?: string | null;
  portTo?: string | null;
  consolidatingVendor?: string | null;
  cartonSize?: string | null;
  exporterName?: string | null;
  exporterAddress?: string | null;
  qizRef?: string | null;
  destination?: string | null;
  signatory?: string | null;
  /** Keyed by `sheetRowKey`. */
  rows?: Record<string, SheetRowSettings>;
}

/** The HTS codes the factory's proforma uses; the field also takes any other code. */
export const HTS_CODES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '6109900000', label: 'Knitted shirts, jerseys & tops' },
  { code: '6203430000', label: 'Shorts & trousers (synthetic)' },
  { code: '42029291', label: 'Bags & backpacks' },
];

export const SHEET_DEFAULTS = {
  statement: 'The goods stated on this invoice are duties exempted under QIZ',
  shipmentFrom: 'Egypt',
  container: '40',
  cartonsPerContainer: 410,
  leadDays: 55,
  unit: 'pce',
} as const;

const BAG = /\b(BAG|BACKPACK|HOLDALL)\b/i;
const BOTTOM = /\b(SHORTS?|TRS|TROUSERS?|PANTS?|JOGGERS?)\b/i;

/** The HTS code a style most likely takes, from its name. */
export function guessHts(name: string): string {
  if (BAG.test(name)) return '42029291';
  if (BOTTOM.test(name)) return '6203430000';
  return '6109900000';
}

/** How many pieces of a style go in one carton, as the factory's sheet divides them. */
export function guessPerCarton(name: string): number {
  if (BAG.test(name)) return 15;
  if (/\b(HOODY|HOODIE)\b/i.test(name)) return 30;
  if (/\b(GK|KEEPER|GOALKEEPER)\b/i.test(name)) return 60;
  return 120;
}

/** "TRANMERE SHIRT" → "Tranmere Shirt"; already mixed case is left alone. */
export function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  // A token with a digit ("2XL", "V4") stays as typed.
  return s.split(/(\s+)/).map((tok) => (/\d/.test(tok) || !/\S/.test(tok) ? tok
    : tok.toLowerCase().replace(/(^|[/(.-])(\p{Ll})/gu, (_, a: string, b: string) => a + b.toUpperCase()))).join('');
}

/** The key a row's typed fields are stored under: the style, and the PO on a document of several. */
export function sheetRowKey(name: string, po: string | null, manyOrders: boolean): string {
  return `${name.replace(/\s+/g, ' ').trim().toUpperCase()}${manyOrders && po ? `|${po}` : ''}`;
}

export interface SheetRow {
  key: string;
  /** The style as the goods lines name it. */
  style: string;
  description: string;
  po: string;
  partNo: string;
  hts: string;
  gw: number | null;
  nw: number | null;
  unit: string;
  perCarton: number;
  /** Cartons: typed, or the quantity divided by `perCarton` rounded up. */
  cartons: number;
  cartonsTyped: boolean;
  qty: number;
  unitPrice: number | null;
  mixedRates: boolean;
  total: number | null;
  /** cartons ÷ cartons per container; null without a container size. */
  containerShare: number | null;
  /** Positions of this row's goods lines in the document's lines. */
  lineIndexes: number[];
}

export interface SheetTotals {
  qty: number;
  cartons: number;
  gw: number;
  nw: number;
  total: number | null;
  containerShare: number | null;
}

/** ETD + lead days, as an ISO day; null without an ETD. */
export function sheetEta(etd: string | null | undefined, leadDays: number | null | undefined): string | null {
  if (!etd) return null;
  const day = etd.slice(0, 10);
  const d = new Date(`${day}T00:00:00.000Z`);
  // "2026-02-30" is not a date; JavaScript would quietly make it 2 March.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return null;
  const lead = leadDays != null && Number.isFinite(leadDays) ? leadDays : SHEET_DEFAULTS.leadDays;
  return new Date(d.getTime() + lead * 86_400_000).toISOString().slice(0, 10);
}

/** True for a real calendar day written YYYY-MM-DD. */
export function isCalendarDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The table of the factory's proforma: one row per style, worked out as its Excel sheet does. */
export function buildSheet(
  lines: ReadonlyArray<InvoiceLineInput>,
  orders: ReadonlyArray<{ poNumber: string; orderName: string; styleNumber?: string | null }>,
  settings: ProformaSheetSettings | null | undefined,
): { rows: SheetRow[]; totals: SheetTotals } {
  const typed = settings?.rows ?? {};
  const perContainer = settings?.cartonsPerContainer ?? SHEET_DEFAULTS.cartonsPerContainer;
  const indexed = lines.map((l, i) => ({ ...l, i }));
  const many = orders.length > 1;
  const rows = groupGoodsByStyle(indexed, orders).map((g): SheetRow => {
    const o = orders[g.orderIndex]!;
    const key = sheetRowKey(g.name, o.poNumber, many);
    const t = typed[key] ?? {};
    const sum = sumGoods(g.lines);
    const qty = sum.quantity ?? 0;
    // The HTS code, cartons and wording follow the style the lines name, even
    // when the order is that one style and the row is named after the order.
    const label = g.style ?? g.name;
    const perCarton = t.perCarton && t.perCarton > 0 ? t.perCarton : guessPerCarton(label);
    const cartonsTyped = t.cartons != null && t.cartons >= 0;
    const cartons = cartonsTyped ? t.cartons! : qty > 0 ? Math.ceil(qty / perCarton) : 0;
    return {
      key,
      style: g.name,
      description: t.description?.trim() || titleCase(label),
      po: t.po?.trim() || o.poNumber,
      partNo: t.partNo?.trim() || (g.wholeOrder && o.styleNumber ? o.styleNumber : ''),
      hts: t.hts?.trim() || guessHts(label),
      gw: t.gw ?? null,
      nw: t.nw ?? null,
      unit: t.unit?.trim() || SHEET_DEFAULTS.unit,
      perCarton,
      cartons,
      cartonsTyped,
      qty,
      unitPrice: sum.unitPrice,
      mixedRates: sum.mixedRates,
      total: sum.lineTotal,
      containerShare: perContainer > 0 ? cartons / perContainer : null,
      lineIndexes: g.lines.map((l) => l.i),
    };
  });
  const add = (f: (r: SheetRow) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  const priced = rows.every((r) => r.total != null);
  const cents = rows.reduce((a, r) => a + Math.round((r.total ?? 0) * 100), 0);
  const cartons = add((r) => r.cartons);
  return {
    rows,
    totals: {
      qty: add((r) => r.qty),
      cartons,
      gw: add((r) => r.gw),
      nw: add((r) => r.nw),
      total: priced ? cents / 100 : null,
      containerShare: perContainer > 0 ? cartons / perContainer : null,
    },
  };
}

/** The sheet's title when none is typed: "Xara Proforma invoice No.PI-2026-0001 on 21 Oct. 26". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function defaultSheetTitle(clientName: string, number: string, dateIso: string): string {
  const d = new Date(dateIso);
  const month = Number.isNaN(d.getTime()) ? '' : MONTHS[d.getUTCMonth()]!;
  const on = Number.isNaN(d.getTime()) ? '' : ` on ${d.getUTCDate()} ${month}${month === 'May' ? '' : '.'} ${String(d.getUTCFullYear()).slice(2)}`;
  return `${clientName ? `${clientName} ` : ''}Proforma invoice No.${number}${on}`;
}
