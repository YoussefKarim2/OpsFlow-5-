/**
 * The actual costing as a PDF — the sheet, to be filed or sent.
 *
 * Laid out from the same `CostingResult` the Costing tab shows, so the two
 * cannot disagree: a figure that reads "Not calculated" on the screen reads
 * "—" here, and the reason is listed at the foot of the document rather than
 * left for the reader to guess. Figures somebody typed over the calculated
 * ones are marked with an asterisk and the calculated figure is given beside
 * them, so a costing that was reconciled against an invoice still shows what
 * the records said.
 *
 * Built with pdfkit on its standard fonts, which carry the Latin-1 characters
 * the sheet uses ("÷", "×", "—") and nothing beyond them. Nothing is drawn
 * from the database here: the order detail comes in, a buffer goes out, so
 * it can be exercised by value.
 */

import PDFDocument from 'pdfkit';
import {
  ORDER_STATUS_LABEL, fmtDate, fmtMoney, fmtNumber, fmtPct,
  type CostLineResult, type CostingResult, type OrderDetailDto, type OverrideKey,
} from '@opsflow/shared';

/** What the renderer reads from the order. Narrow, so a test can build one. */
export type CostingPdfOrder = Pick<
  OrderDetailDto,
  'poNumber' | 'orderName' | 'styleNumber' | 'itemType' | 'season' | 'status' | 'client' | 'coordinator'
> & { costing: CostingResult };

export interface CostingPdfOptions {
  /** Whose name goes in the footer. */
  generatedBy: string;
  generatedAt?: Date;
}

// ── Palette and metrics ──────────────────────────────────────────────────────
// The application's ink scale, so the document reads as OpsFlow's.
const INK = { 900: '#111827', 700: '#374151', 500: '#6b7280', 300: '#d1d5db', 200: '#e5e7eb', 100: '#f3f4f6', 50: '#f9fafb' };
const GREEN = { bg: '#ecfdf5', fg: '#047857', line: '#6ee7b7' };
const RED = { bg: '#fef2f2', fg: '#b91c1c', line: '#fca5a5' };
const VIOLET = '#6d28d9';
const WHITE = '#ffffff';

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 40, right: 40, bottom: 48, left: 40 };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;
const FOOTER_H = 22;

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

const DASH = '—';

export async function renderCostingPdf(order: CostingPdfOrder, opts: CostingPdfOptions): Promise<Buffer> {
  const c = order.costing;
  const generatedAt = opts.generatedAt ?? new Date();
  const doc = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    info: {
      // Plain ASCII, so readers that show the title do not need the UTF-16 form.
      Title: `Actual Costing - PO ${order.poNumber}`,
      Author: 'OpsFlow',
      Subject: `${order.client.name} - ${order.orderName}`,
      CreationDate: generatedAt,
    },
  });

  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const page = new Layout(doc, order);
  page.header(generatedAt);
  page.identity();
  page.quantities();
  page.machines();
  page.costingTable();
  page.result();
  page.notes();
  page.footnotes();
  page.footers(opts.generatedBy, generatedAt);

  doc.end();
  return done;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const money = (v: number | null | undefined, places = 2) => (v == null ? DASH : fmtMoney(v, '$', places));
const egp = (v: number | null | undefined, places = 2) => (v == null ? DASH : `EGP ${fmtNumber(v, { places })}`);
const num = (v: number | null | undefined, places = 0) => (v == null ? DASH : fmtNumber(v, { places }));
const pct = (v: number | null | undefined, places = 1) => (v == null ? DASH : fmtPct(v, places));
const text = (v: string | null | undefined) => (v == null || v === '' ? DASH : v);

/** The labels the footnote gives the overridable cells. */
const OVERRIDE_LABEL: Record<OverrideKey, string> = {
  customer: 'Customer', orderName: 'Order name', itemType: 'Item type', poNumber: 'PO no', styleNumber: 'Style no',
  machineCostEgpPerDay: 'Machine cost', machineDaysUsed: 'Machine-days used', workDays: 'Work days',
  productivityRate: 'Productivity rate',
  orderQty: 'Order qty', cutQty: 'Cut qty', shippedQty: 'Shipped qty', firstDegreeQty: '1st degree qty',
  secondDegreeQty: '2nd degree qty', diffPct: 'Diff. percentage',
  fabricCostUsd: 'Fabric costing', accessoryCostUsd: 'Accessory costing', cmCostUsd: 'C.M', totalCostUsd: 'Total',
  sellPriceUsd: 'Sell price', unitActualCostUsd: 'Actual cost per unit', profitPerUnitUsd: 'Profit',
  profitPct: 'Profit percentage', targetPriceUsd: 'Perfect price',
};

/** How each overridable cell's calculated figure is written in the footnote. */
const OVERRIDE_FORMAT: Partial<Record<OverrideKey, (v: number | string | null) => string>> = {
  machineCostEgpPerDay: (v) => egp(v as number | null),
  workDays: (v) => num(v as number | null, 1),
  productivityRate: (v) => num(v as number | null, 1),
  diffPct: (v) => pct(v as number | null),
  profitPct: (v) => pct(v as number | null),
  fabricCostUsd: (v) => money(v as number | null),
  accessoryCostUsd: (v) => money(v as number | null),
  cmCostUsd: (v) => money(v as number | null),
  totalCostUsd: (v) => money(v as number | null),
  sellPriceUsd: (v) => money(v as number | null),
  unitActualCostUsd: (v) => money(v as number | null),
  profitPerUnitUsd: (v) => money(v as number | null),
  targetPriceUsd: (v) => money(v as number | null),
};

// ── Layout ───────────────────────────────────────────────────────────────────

/** A value cell on the key-figure grids. */
interface Cell {
  label: string;
  value: string;
  /** Printed small under the value: a unit, a source, a sum. */
  sub?: string;
  /** The override key this cell shows, so a typed figure gets its mark. */
  key?: OverrideKey;
  tone?: 'good' | 'bad';
}

class Layout {
  private y = MARGIN.top;
  private readonly c: CostingResult;
  /** Overridden cells that appeared on the page, in order, for the footnote. */
  private readonly marked: OverrideKey[] = [];

  constructor(private readonly doc: PDFKit.PDFDocument, private readonly order: CostingPdfOrder) {
    this.c = order.costing;
  }

  // ── Page control ──────────────────────────────────────────────────────

  private get bottom(): number {
    return PAGE.height - MARGIN.bottom - FOOTER_H;
  }

  /** Make room for `height` points, starting a new page if there is none. */
  private ensure(height: number): void {
    if (this.y + height <= this.bottom) return;
    this.doc.addPage();
    this.y = MARGIN.top;
    this.continuation();
  }

  /** A one-line running header on every page after the first. */
  private continuation(): void {
    const { doc } = this;
    doc.font(BOLD).fontSize(8).fillColor(INK[500])
      .text('ACTUAL COSTING', MARGIN.left, this.y, { lineBreak: false });
    doc.font(REGULAR).fontSize(8).fillColor(INK[500])
      .text(`PO ${this.order.poNumber} · ${this.order.client.name} · ${this.order.orderName}`,
        MARGIN.left, this.y, { width: CONTENT_W, align: 'right', lineBreak: false });
    this.y += 14;
    this.rule(INK[200]);
    this.y += 10;
  }

  private rule(color: string, width = 0.5): void {
    this.doc.save().moveTo(MARGIN.left, this.y).lineTo(MARGIN.left + CONTENT_W, this.y)
      .lineWidth(width).strokeColor(color).stroke().restore();
  }

  /** Text that fits one line of `width` points, shortened with an ellipsis if it must. */
  private fit(str: string, width: number): string {
    const { doc } = this;
    if (doc.widthOfString(str) <= width) return str;
    let s = str;
    while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
    return `${s.trimEnd()}…`;
  }

  /** A figure, with its mark when somebody typed it over the calculation. */
  private shown(value: string, key?: OverrideKey): string {
    if (!key || !this.c.overridden.includes(key)) return value;
    if (!this.marked.includes(key)) this.marked.push(key);
    return `${value}*`;
  }

  // ── Sections ──────────────────────────────────────────────────────────

  header(generatedAt: Date): void {
    const { doc, order, c } = this;
    const h = 64;
    doc.save().rect(MARGIN.left, this.y, CONTENT_W, h).fill(INK[900]).restore();

    doc.font(BOLD).fontSize(18).fillColor(WHITE)
      .text('ACTUAL COSTING', MARGIN.left + 18, this.y + 14, { lineBreak: false });
    doc.font(REGULAR).fontSize(9).fillColor(INK[300])
      .text(this.fit(`${order.client.name}  ·  ${order.orderName}`, 320), MARGIN.left + 18, this.y + 40, { lineBreak: false });

    const right = MARGIN.left + CONTENT_W - 18;
    doc.font(BOLD).fontSize(13).fillColor(WHITE)
      .text(`PO ${order.poNumber}`, right - 200, this.y + 15, { width: 200, align: 'right', lineBreak: false });
    doc.font(REGULAR).fontSize(8.5).fillColor(INK[300])
      .text(c.costingDate ? `Costing date ${fmtDate(c.costingDate)}` : `Issued ${fmtDate(generatedAt)}`,
        right - 200, this.y + 34, { width: 200, align: 'right', lineBreak: false });
    doc.text(ORDER_STATUS_LABEL[order.status] ?? order.status,
      right - 200, this.y + 46, { width: 200, align: 'right', lineBreak: false });

    this.y += h + 16;
  }

  private sectionTitle(title: string, subtitle?: string): void {
    this.ensure(30);
    const { doc } = this;
    doc.font(BOLD).fontSize(10.5).fillColor(INK[900]).text(title, MARGIN.left, this.y, { lineBreak: false });
    // Measured in the title's own font, before the subtitle's is set.
    const titleW = doc.widthOfString(title);
    if (subtitle) {
      doc.font(REGULAR).fontSize(7.5).fillColor(INK[500])
        .text(subtitle, MARGIN.left + titleW + 8, this.y + 2.5, {
          width: CONTENT_W - titleW - 8, lineBreak: false,
        });
    }
    this.y += 15;
    this.rule(INK[900], 0.8);
    this.y += 8;
  }

  /** A grid of labelled figures, `cols` to the row. */
  private grid(cells: Cell[], cols: number): void {
    const { doc } = this;
    const rowH = 36;
    const colW = CONTENT_W / cols;
    for (let i = 0; i < cells.length; i += cols) {
      this.ensure(rowH);
      const row = cells.slice(i, i + cols);
      row.forEach((cell, j) => {
        const x = MARGIN.left + j * colW;
        doc.font(REGULAR).fontSize(6.8).fillColor(INK[500])
          .text(cell.label.toUpperCase(), x, this.y, { width: colW - 8, lineBreak: false, characterSpacing: 0.3 });
        const value = this.shown(cell.value, cell.key);
        doc.font(BOLD).fontSize(11)
          .fillColor(cell.tone === 'good' ? GREEN.fg : cell.tone === 'bad' ? RED.fg : value === DASH ? INK[300] : INK[900])
          .text(this.fit(value, colW - 8), x, this.y + 10, { lineBreak: false });
        if (cell.sub) {
          doc.font(REGULAR).fontSize(6.8).fillColor(INK[500])
            .text(this.fit(cell.sub, colW - 8), x, this.y + 24, { lineBreak: false });
        }
      });
      this.y += rowH;
    }
    this.y += 6;
  }

  identity(): void {
    const { c, order } = this;
    this.sectionTitle('The order', 'as recorded on it');
    this.grid([
      { label: 'Customer', value: text(c.identity.customer), key: 'customer' },
      { label: 'Order name', value: text(c.identity.orderName), key: 'orderName' },
      { label: 'PO no', value: text(c.identity.poNumber), key: 'poNumber' },
      { label: 'Style no', value: text(c.identity.styleNumber), key: 'styleNumber' },
      { label: 'Item type', value: text(c.identity.itemType), key: 'itemType' },
      { label: 'Season', value: text(order.season) },
      { label: 'Coordinator', value: text(order.coordinator?.name) },
      { label: 'Dollar rate', value: c.dollarRate == null ? DASH : fmtNumber(c.dollarRate, { places: 2 }), sub: 'EGP per $' },
    ], 4);
  }

  quantities(): void {
    const { c } = this;
    this.sectionTitle('Quantities', 'from the order ledgers and the cutting, inspection and shipping records');
    this.grid([
      { label: 'Order qty', value: num(c.orderQty), key: 'orderQty', sub: 'pcs' },
      { label: 'Cut qty', value: num(c.cutQty), key: 'cutQty',
        sub: c.source.cutQtySource === 'recorded' ? 'cutting records' : 'cut order' },
      { label: '1st degree qty', value: num(c.firstDegreeQty), key: 'firstDegreeQty', sub: 'passed inspection' },
      { label: '2nd degree qty', value: num(c.secondDegreeQty), key: 'secondDegreeQty', sub: 'graded B' },
      { label: 'Shipped qty', value: num(c.shippedQty), key: 'shippedQty', sub: 'pcs' },
      { label: 'Diff. percentage', value: pct(c.diffPct), key: 'diffPct', sub: 'shipped against ordered' },
    ], 6);
  }

  machines(): void {
    const { c } = this;
    const daysSub = c.daysInLineSource === 'production'
      ? 'days with sewing recorded'
      : c.daysInLineSource === 'typed' ? 'as entered' : undefined;
    this.sectionTitle('Machine economics', "the factory's figures and what follows from them");
    this.grid([
      { label: 'Daily cost', value: egp(c.dailyCostEgp, 0), sub: 'the whole factory, per day' },
      { label: 'All factory machines', value: num(c.machineCount) },
      { label: 'Line machines', value: num(c.lineMachineQty) },
      { label: 'Days in line', value: num(c.daysInLineUsed), sub: daysSub },
      { label: 'Machine cost', value: egp(c.machineCostEgpPerDay), key: 'machineCostEgpPerDay', sub: 'daily cost ÷ all machines' },
      { label: 'Machine-days used', value: num(c.machineDaysUsed), key: 'machineDaysUsed', sub: 'line machines × days in line' },
      { label: 'Work days', value: num(c.workDays, 2), key: 'workDays', sub: 'machine-days ÷ all machines' },
      { label: 'Productivity rate', value: num(c.productivityRate, 1), key: 'productivityRate', sub: 'cut qty ÷ work days, pcs per day' },
    ], 4);
  }

  // ── The costing table ─────────────────────────────────────────────────

  private static readonly COLS = [
    { key: 'section', title: 'Section', w: 64, align: 'left' },
    { key: 'item', title: 'Item', w: 150, align: 'left' },
    { key: 'planned', title: 'Planned', w: 50, align: 'right' },
    { key: 'actual', title: 'Actual cons.', w: 58, align: 'right' },
    { key: 'unit', title: 'Unit', w: 34, align: 'center' },
    { key: 'price', title: 'Unit price', w: 56, align: 'right' },
    { key: 'cost', title: 'Cost', w: 62, align: 'right' },
    { key: 'pct', title: '%', w: 41, align: 'right' },
  ] as const;

  private tableHead(): void {
    const { doc } = this;
    const h = 18;
    this.ensure(h + 24);
    doc.save().rect(MARGIN.left, this.y, CONTENT_W, h).fill(INK[100]).restore();
    let x = MARGIN.left;
    for (const col of Layout.COLS) {
      doc.font(BOLD).fontSize(7).fillColor(INK[700])
        .text(col.title.toUpperCase(), x + 4, this.y + 5.5, { width: col.w - 8, align: col.align, lineBreak: false, characterSpacing: 0.3 });
      x += col.w;
    }
    this.y += h;
  }

  private tableRow(
    cells: Partial<Record<(typeof Layout.COLS)[number]['key'], string>>,
    style: { fill?: string; bold?: boolean; muted?: boolean; top?: boolean; size?: number } = {},
  ): void {
    const { doc } = this;
    const h = 17;
    if (this.y + h > this.bottom) {
      this.ensure(h);
      this.tableHead();
    }
    if (style.fill) doc.save().rect(MARGIN.left, this.y, CONTENT_W, h).fill(style.fill).restore();
    if (style.top) this.rule(INK[900], 0.8);
    let x = MARGIN.left;
    for (const col of Layout.COLS) {
      const v = cells[col.key];
      if (v != null) {
        const bold = style.bold || col.key === 'section';
        doc.font(bold ? BOLD : REGULAR).fontSize(style.size ?? 8)
          .fillColor(style.muted || v === DASH ? INK[500] : INK[900])
          .text(this.fit(v, col.w - 8), x + 4, this.y + 5, { width: col.w - 8, align: col.align, lineBreak: false });
      }
      x += col.w;
    }
    this.y += h;
    this.doc.save().moveTo(MARGIN.left, this.y).lineTo(MARGIN.left + CONTENT_W, this.y)
      .lineWidth(0.3).strokeColor(INK[200]).stroke().restore();
  }

  private lineRow(section: string, l: CostLineResult, countedIn?: string): void {
    this.tableRow({
      section,
      item: l.label,
      planned: DASH,
      actual: l.quantity == null ? DASH : fmtNumber(l.quantity, { places: 2 }),
      unit: l.unit,
      price: l.unitPriceUsd == null ? DASH : fmtMoney(l.unitPriceUsd, '$', 4),
      cost: money(l.cost),
      pct: countedIn ? `in ${countedIn}` : pct(l.pctOfTotal),
    });
  }

  costingTable(): void {
    const { c } = this;
    this.sectionTitle('Costing', 'materials from the bill of materials, outside work from the External Order section, in US dollars');
    this.tableHead();

    const block = (caption: string, lines: CostLineResult[], empty: string) => {
      if (lines.length === 0) {
        this.tableRow({ section: caption, item: empty }, { muted: true });
        return;
      }
      lines.forEach((l, i) => this.lineRow(i === 0 ? caption : '', l));
    };
    const subtotal = (label: string, value: number | null, key: OverrideKey, share: number | null) =>
      this.tableRow({ item: label, cost: this.shown(money(value), key), pct: pct(share) }, { fill: INK[50], bold: true });

    block('UsedFabric', c.groups.fabric.lines, 'No fabric on the bill of materials');
    subtotal('Fabric Costing', c.fabricCostUsd, 'fabricCostUsd', c.groups.fabric.pctOfTotal);

    block('UsedAcc', c.groups.accessory.lines, 'No accessories on the bill of materials');
    subtotal('Accessory Costing', c.accessoryCostUsd, 'accessoryCostUsd', c.groups.accessory.pctOfTotal);

    const total = c.totalCostUsd;
    const share = (v: number | null) => (v == null || total == null || total === 0 ? null : (v / total) * 100);
    this.tableRow({ section: 'Outside work', item: 'Sublimation', cost: money(c.sublimationCostUsd), pct: pct(share(c.sublimationCostUsd)) });
    this.tableRow({ item: 'Embroidery', cost: money(c.embroideryCostUsd), pct: pct(share(c.embroideryCostUsd)) });
    for (const l of c.groups.external.lines) this.lineRow('', l);
    for (const l of c.groups.other.lines) this.lineRow('', l);

    // C.M, multiplied out like every other row: the pieces it is charged
    // against, the cost of each, and the total.
    const cmPerPiece = c.cmCostUsd != null && c.firstDegreeQty ? c.cmCostUsd / c.firstDegreeQty : null;
    this.tableRow({
      section: 'C.M',
      item: 'Production — daily cost ÷ productivity rate, per piece passed',
      actual: num(c.firstDegreeQty),
      unit: 'PCS',
      price: cmPerPiece == null ? DASH : fmtMoney(cmPerPiece, '$', 4),
      cost: this.shown(money(c.cmCostUsd), 'cmCostUsd'),
      pct: pct(share(c.cmCostUsd)),
    }, { fill: INK[50] });

    this.tableRow({
      section: 'Total', item: 'Total actual cost',
      cost: this.shown(money(total), 'totalCostUsd'),
      pct: total == null ? DASH : '100.0%',
    }, { fill: INK[100], bold: true, top: true, size: 9 });
    this.y += 12;
  }

  // ── The result ────────────────────────────────────────────────────────

  result(): void {
    const { doc, c } = this;
    const h = 122;
    this.ensure(h + 30);
    this.sectionTitle('The result', 'per piece, against what shipped');

    const tone = c.isProfitable === true ? GREEN : c.isProfitable === false ? RED : null;
    doc.save().rect(MARGIN.left, this.y, CONTENT_W, h)
      .fillAndStroke(tone?.bg ?? INK[50], tone?.line ?? INK[200]).restore();

    // The verdict, top right, as the screen's pill.
    const verdict = c.isProfitable === true ? 'IN PROFIT' : c.isProfitable === false ? 'AT A LOSS' : 'NOT CALCULABLE YET';
    doc.font(BOLD).fontSize(8).fillColor(tone?.fg ?? INK[500]);
    const vw = doc.widthOfString(verdict) + 16;
    const vx = MARGIN.left + CONTENT_W - 12 - vw;
    doc.save().roundedRect(vx, this.y + 10, vw, 16, 8).fillAndStroke(WHITE, tone?.line ?? INK[300]).restore();
    doc.fillColor(tone?.fg ?? INK[500]).text(verdict, vx + 8, this.y + 14.5, { lineBreak: false, characterSpacing: 0.4 });

    const cells: Cell[] = [
      { label: 'Total actual cost', value: money(c.totalCostUsd), key: 'totalCostUsd', sub: 'every cost above, added up' },
      { label: 'Actual cost / unit', value: money(c.unitActualCostUsd), key: 'unitActualCostUsd',
        sub: c.unitActualCostEgp == null ? 'total cost ÷ shipped qty' : `${egp(c.unitActualCostEgp)} · total ÷ shipped` },
      { label: 'Sell price', value: money(c.sellPriceUsd), key: 'sellPriceUsd', sub: 'per piece, from Order Details' },
      { label: 'Profit / unit', value: money(c.profitPerUnitUsd), key: 'profitPerUnitUsd', sub: 'sell price - cost per unit',
        tone: c.isProfitable === true ? 'good' : c.isProfitable === false ? 'bad' : undefined },
      { label: 'Profit percentage', value: pct(c.profitPct), key: 'profitPct', sub: 'profit ÷ sell price',
        tone: c.isProfitable === true ? 'good' : c.isProfitable === false ? 'bad' : undefined },
      { label: 'Total profit', value: money(c.totalProfitUsd), sub: 'profit per unit × shipped qty',
        tone: c.isProfitable === true ? 'good' : c.isProfitable === false ? 'bad' : undefined },
    ];
    if (c.targetPriceUsd != null || c.overridden.includes('targetPriceUsd')) {
      cells.push({ label: 'Perfect price', value: money(c.targetPriceUsd), key: 'targetPriceUsd', sub: 'cost per unit plus a 20% mark-up' });
    }

    const inner = MARGIN.left + 14;
    const colW = (CONTENT_W - 28) / 3;
    const startY = this.y + 36;
    // The first row is set larger, so the second starts further down.
    const rowTop = [0, 44, 80];
    cells.forEach((cell, i) => {
      const x = inner + (i % 3) * colW;
      const y = startY + rowTop[Math.floor(i / 3)]!;
      doc.font(REGULAR).fontSize(6.8).fillColor(INK[500])
        .text(cell.label.toUpperCase(), x, y, { lineBreak: false, characterSpacing: 0.3 });
      const value = this.shown(cell.value, cell.key);
      doc.font(BOLD).fontSize(i < 3 ? 14 : 11)
        .fillColor(cell.tone === 'good' ? GREEN.fg : cell.tone === 'bad' ? RED.fg : value === DASH ? INK[300] : INK[900])
        .text(value, x, y + 9, { lineBreak: false });
      if (cell.sub) {
        doc.font(REGULAR).fontSize(6.5).fillColor(INK[500])
          .text(this.fit(cell.sub, colW - 10), x, y + (i < 3 ? 25 : 22), { lineBreak: false });
      }
    });
    this.y += h + 14;
  }

  notes(): void {
    const { doc, c } = this;
    const body = (c.notes ?? '').trim();
    if (!body) return;
    doc.font(REGULAR).fontSize(8.5);
    const height = doc.heightOfString(body, { width: CONTENT_W - 24 });
    this.ensure(height + 40);
    this.sectionTitle('Notes');
    doc.fillColor(INK[700]).text(body, MARGIN.left + 12, this.y, { width: CONTENT_W - 24 });
    this.y = doc.y + 12;
  }

  /**
   * What the asterisks mean, and why any figure is blank.
   *
   * The screen says both beside the figure; a document says them once, at the
   * foot, so the figures above stay figures.
   */
  footnotes(): void {
    const { doc, c } = this;
    const notes: string[] = [];

    if (this.marked.length > 0) {
      const parts = this.marked.map((key) => {
        const calc = c.calculated[key];
        const fmt = OVERRIDE_FORMAT[key];
        const shown = calc == null ? DASH : fmt ? fmt(calc) : typeof calc === 'number' ? fmtNumber(calc, { places: 2 }) : String(calc);
        return `${OVERRIDE_LABEL[key]} (calculated: ${shown})`;
      });
      notes.push(`* Typed in on the costing sheet rather than calculated: ${parts.join('; ')}.`);
    }

    const seen = new Set<string>();
    const waiting = [
      'sellPriceUsd', 'shippedQty', 'dollarRate', 'machineCostEgpPerDay', 'machineDaysUsed', 'workDays',
      'productivityRate', 'cmCostUsd', 'fabricCostUsd', 'accessoryCostUsd', 'totalCostUsd',
    ]
      .map((k) => c.waiting[k])
      .filter((m): m is string => !!m && !seen.has(m) && (seen.add(m), true));
    if (waiting.length > 0) {
      notes.push(`Figures shown as "${DASH}" are not calculated yet: ${waiting.map((w) => w.replace(/^Waiting for /, '')).join('; ')}.`);
    }

    if (notes.length === 0) return;
    doc.font(REGULAR).fontSize(7.2);
    const height = notes.reduce((h, n) => h + doc.heightOfString(n, { width: CONTENT_W }) + 3, 0);
    this.ensure(height + 14);
    this.rule(INK[200]);
    this.y += 7;
    for (const n of notes) {
      doc.fillColor(n.startsWith('*') ? VIOLET : INK[500]).text(n, MARGIN.left, this.y, { width: CONTENT_W });
      this.y = doc.y + 3;
    }
  }

  /** Who produced it and when, and the page count, on every page. */
  footers(generatedBy: string, generatedAt: Date): void {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    const stamp = `Generated by OpsFlow for ${generatedBy} · ${fmtDate(generatedAt)} ${generatedAt.toISOString().slice(11, 16)} UTC`;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin must not open a fresh page.
      doc.page.margins.bottom = 0;
      const y = PAGE.height - MARGIN.bottom + 8;
      doc.save().moveTo(MARGIN.left, y - 6).lineTo(MARGIN.left + CONTENT_W, y - 6)
        .lineWidth(0.3).strokeColor(INK[200]).stroke().restore();
      doc.font(REGULAR).fontSize(6.8).fillColor(INK[500])
        .text(stamp, MARGIN.left, y, { lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN.left, y, { width: CONTENT_W, align: 'right', lineBreak: false });
      doc.page.margins.bottom = MARGIN.bottom;
    }
  }
}
