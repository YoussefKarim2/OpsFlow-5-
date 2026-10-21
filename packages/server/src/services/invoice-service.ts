/**
 * Proforma / Invoice — building a document from an order.
 *
 * The whole point of the section is that nobody types an invoice. The client,
 * the PO, the price, the cartons and what was ordered against them are all
 * already in OpsFlow, so the document is *built* from them and then kept as a
 * record. `buildInvoiceDocument` is the builder: it takes the order, the
 * packing list and the shipment already loaded, and returns every field the
 * draft needs. It touches no database, so it is tested by value against the
 * sample invoice this section was written from.
 *
 * What it refuses to do is invent. A missing price gives a line with no
 * amount and a warning, not a zero; a missing packing list gives a draft built
 * from the shipment, or from the order, and says so. The warnings travel with
 * the draft and are shown on screen; they are never printed.
 *
 * Numbering is allocated inside a transaction under the (kind, year, sequence)
 * unique index, and retried on a collision, so two people pressing "New"
 * together get consecutive numbers rather than an error or a duplicate. The
 * lowest free sequence is taken, so a deleted draft hands its number back.
 */

import { Prisma } from '@prisma/client';
import {
  INVOICE_NUMBER_PREFIX, InvoiceKind, InvoiceLineKind, InvoiceStatus, ShipmentStatus,
  amountInWords, computeInvoiceTotals, formatInvoiceNumber, issueBlockers, lineTotal,
  reconcileShippedAgainstOrdered, summariseSizes,
  type CompanyProfileDto, type InvoiceCartonDto, type InvoiceDto, type InvoiceLineDto,
  type InvoiceListRowDto, type InvoiceOrderRefDto, type InvoiceReconciliationGroupDto,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const dec = (v: { toString(): string } | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

// ── Company profile ──────────────────────────────────────────────────────────

export const PROFILE_ID = 'default';

export function profileToDto(p: {
  name: string; tagline: string | null; address: string | null; taxId: string | null; email: string | null;
  phone: string | null; website: string | null; bankDetails: string | null; invoiceTerms: string | null;
  paymentTerms: string | null; updatedAt?: Date | null;
}): CompanyProfileDto {
  return {
    name: p.name, tagline: p.tagline, address: p.address, taxId: p.taxId, email: p.email, phone: p.phone,
    website: p.website, bankDetails: p.bankDetails, invoiceTerms: p.invoiceTerms, paymentTerms: p.paymentTerms,
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
  };
}

/** The one row. Created with the factory's name and nothing else the first time it is asked for; a read is otherwise a read. */
export async function getCompanyProfile(): Promise<CompanyProfileDto> {
  const row = await prisma.companyProfile.findUnique({ where: { id: PROFILE_ID } })
    ?? await prisma.companyProfile.upsert({ where: { id: PROFILE_ID }, create: { id: PROFILE_ID }, update: {} });
  return profileToDto(row);
}

// ── The builder ──────────────────────────────────────────────────────────────

/** What the builder reads from an order. Narrow, so a test can build one by hand. */
export interface BuildOrder {
  id: string;
  poNumber: string;
  orderName: string;
  styleNumber: string | null;
  externalReference: string | null;
  pricePerPieceUsd: number | null;
  promisedShippingDate: Date | null;
  billingAddress: string | null;
  client: { name: string; billingAddress: string | null; email: string | null };
  colors: Array<{ id: string; name: string; productName: string | null; position: number }>;
  sizes: Array<{ id: string; name: string; position: number }>;
  /** The ORDER ledger only. */
  orderCells: Array<{ orderColorId: string; orderSizeId: string; qty: number }>;
}

export interface BuildCarton {
  id: string;
  cartonNumber: string;
  cartonSize: string | null;
  orderColorId: string | null;
  orderSizeId: string | null;
  qty: number;
  netKg: number | null;
  grossKg: number | null;
  lines: Array<{ orderSizeId: string | null; sizeLabel: string | null; qty: number }>;
}

export interface BuildPackingList {
  id: string;
  reference: string | null;
  approved: boolean;
  cartons: BuildCarton[];
}

export interface BuildShipment {
  id: string;
  status: ShipmentStatus;
  qty: number;
  actualShippingDate: Date | null;
  awbNumber: string | null;
  trackingNumber: string | null;
  containerSeal: string | null;
}

export interface BuiltLine {
  kind: InvoiceLineKind;
  description: string;
  size: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

/** The order's identity as printed: snapshotted so a rename later does not change an issued document. */
export interface OrderRef {
  id: string;
  poNumber: string;
  orderName: string;
  styleNumber: string | null;
  clientName: string;
}

export interface BuiltDocument {
  date: Date;
  dueDate: Date | null;
  paymentTerms: string | null;
  billTo: string;
  billToAddress: string | null;
  billToEmail: string | null;
  customerReference: string | null;
  shipmentRef: string | null;
  shippedOn: Date | null;
  terms: string | null;
  bankDetails: string | null;
  /** Pre-filled only when there is something the reader must be told — other shipments of the same order. */
  notes: string | null;
  seller: CompanyProfileDto;
  orderRef: OrderRef;
  lines: BuiltLine[];
  manifest: InvoiceCartonDto[];
  reconciliation: InvoiceReconciliationGroupDto[];
  warnings: string[];
}

/** "Order name — Colour", or the colour's own product name when the order gives it one. */
function productLabel(order: BuildOrder, colorId: string | null): string {
  const colour = colorId ? order.colors.find((c) => c.id === colorId) : undefined;
  if (!colour) return order.orderName;
  const base = colour.productName?.trim() || order.orderName;
  return base.toLowerCase().includes(colour.name.toLowerCase()) ? base : `${base} — ${colour.name}`;
}

/** The size rows a carton holds: its breakdown when it has one, its single size otherwise. */
function cartonContents(order: BuildOrder, carton: BuildCarton): Array<{ label: string; qty: number }> {
  const sizeName = (id: string | null) => (id ? order.sizes.find((s) => s.id === id)?.name ?? null : null);
  if (carton.lines.length > 0) {
    return carton.lines.map((l) => ({ label: sizeName(l.orderSizeId) ?? l.sizeLabel?.trim() ?? 'Unsized', qty: l.qty }));
  }
  return [{ label: sizeName(carton.orderSizeId) ?? 'Unsized', qty: carton.qty }];
}

const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** How long a quotation stands by default; the terms line "Prices are valid for 14 days" says the same. */
export const PROFORMA_VALID_DAYS = 14;

export function buildInvoiceDocument(input: {
  kind: InvoiceKind;
  order: BuildOrder;
  packingList: BuildPackingList | null;
  shipment: BuildShipment | null;
  /** The order's other packing lists with cartons — earlier or later shipments this document does not cover. */
  otherPackingLists?: BuildPackingList[];
  profile: CompanyProfileDto;
  now?: Date;
}): BuiltDocument {
  const { kind, order, packingList, shipment, profile } = input;
  const now = input.now ?? new Date();
  const others = (input.otherPackingLists ?? []).filter((l) => l.cartons.length > 0);
  const warnings: string[] = [];
  const price = order.pricePerPieceUsd;
  const sizeOrder = [...order.sizes].sort((a, b) => a.position - b.position).map((s) => s.name);
  const colourRank = (id: string | null) => (id ? order.colors.find((c) => c.id === id)?.position ?? 9999 : 9999);
  const soleColour = order.colors.length === 1 ? order.colors[0]!.id : null;

  if (price == null) {
    warnings.push('The order has no unit price, so the goods lines have no amount. Set the price on Order Details, or type a rate on each line.');
  }

  // Ordered, per colour and size, from the ORDER ledger.
  const orderedCells = order.orderCells.filter((c) => c.qty > 0).map((c) => ({
    colorId: c.orderColorId,
    label: order.sizes.find((s) => s.id === c.orderSizeId)?.name ?? 'Unsized',
    qty: c.qty,
  }));
  const orderedQty = orderedCells.reduce((a, c) => a + c.qty, 0);
  const byColour = (cells: Array<{ colorId: string | null; label: string; qty: number }>) =>
    cells.map((c) => ({ product: productLabel(order, c.colorId), label: c.label, qty: c.qty }));
  const byOrder = (cells: Array<{ label: string; qty: number }>) =>
    cells.map((c) => ({ product: order.orderName, label: c.label, qty: c.qty }));

  let lines: BuiltLine[] = [];
  let manifest: InvoiceCartonDto[] = [];
  let reconciliation: InvoiceReconciliationGroupDto[] = [];
  let notes: string | null = null;

  /** One goods line per colour from a list of (colour, size, qty) pieces. */
  const linesFromPieces = (pieces: Array<{ colorId: string | null; label: string; qty: number }>): BuiltLine[] => {
    const groups = new Map<string | null, { labels: string[]; qty: number }>();
    for (const p of pieces) {
      const g = groups.get(p.colorId) ?? { labels: [], qty: 0 };
      g.labels.push(p.label);
      g.qty += p.qty;
      groups.set(p.colorId, g);
    }
    return [...groups.entries()]
      .sort((a, b) => colourRank(a[0]) - colourRank(b[0]))
      .map(([colorId, g]) => ({
        kind: InvoiceLineKind.ITEM,
        description: productLabel(order, colorId),
        size: summariseSizes(g.labels, sizeOrder),
        quantity: g.qty,
        unitPrice: price,
        amount: null,
      }));
  };

  if (kind === InvoiceKind.PROFORMA) {
    // A quotation is priced on what was ordered. Nothing has shipped, so there
    // is no manifest and nothing to reconcile.
    lines = linesFromPieces(orderedCells);
    if (lines.length === 0) {
      warnings.push('The order has no quantities yet, so there are no goods lines. Fill the main order, or add the lines by hand.');
    }
  } else {
    const cartons = packingList?.cartons ?? [];
    if (cartons.length > 0) {
      // A carton with no colour on a one-colour order can only hold that colour.
      // On a multi-colour order it cannot be placed, so the comparison drops to
      // size level for the whole document rather than inventing a colour.
      const colourOf = (c: BuildCarton) => c.orderColorId ?? soleColour;
      const uncoloured = cartons.filter((c) => colourOf(c) == null).length;
      const shippedCells = cartons.flatMap((c) =>
        cartonContents(order, c).map((x) => ({ colorId: colourOf(c), label: x.label, qty: x.qty })));
      lines = linesFromPieces(shippedCells);
      manifest = cartons.map((c, i) => {
        const contents = cartonContents(order, c);
        return {
          n: i + 1,
          cartonNumber: c.cartonNumber,
          cartonSize: c.cartonSize,
          product: productLabel(order, colourOf(c)),
          contents,
          pieces: contents.reduce((a, x) => a + x.qty, 0),
          netKg: c.netKg,
          grossKg: c.grossKg,
        };
      });
      reconciliation = uncoloured === 0
        ? reconcileShippedAgainstOrdered(byColour(orderedCells), byColour(shippedCells), sizeOrder).groups
        : reconcileShippedAgainstOrdered(byOrder(orderedCells), byOrder(shippedCells), sizeOrder).groups;
      if (uncoloured > 0) {
        warnings.push(`${uncoloured} carton${uncoloured === 1 ? ' has' : 's have'} no colour, so shipped-vs-ordered is compared by size for the whole order rather than per colour. Set the colour on the cartons and rebuild for a colour-level comparison.`);
      }
      if (packingList && !packingList.approved) {
        warnings.push('The packing list has not been approved yet. The cartons may still change; rebuild the draft before issuing if they do.');
      }
      const packed = manifest.reduce((a, c) => a + c.pieces, 0);
      if (shipment && shipment.qty > 0 && shipment.qty !== packed) {
        warnings.push(`The cartons hold ${packed.toLocaleString()} pieces but the shipment records ${shipment.qty.toLocaleString()}. The invoice follows the cartons; check which is right.`);
      }
      if (others.length > 0) {
        // The comparison is this shipment against the whole order, so the
        // reader must be told that the rest of the order travelled separately.
        const otherQty = others.reduce((a, l) => a + l.cartons.reduce((b, c) => b + c.qty, 0), 0);
        const names = others.map((l) => l.reference?.trim() || 'another packing list').join(', ');
        notes = `Shipped-vs-ordered above compares this shipment${packingList?.reference ? ` (${packingList.reference})` : ''} with the whole order. A further ${otherQty.toLocaleString()} pcs of this order travel on ${names} and are invoiced separately.`;
        warnings.push(`This order has ${others.length} other packing list${others.length === 1 ? '' : 's'} with cartons (${otherQty.toLocaleString()} pcs). This document covers ${packingList?.reference?.trim() || 'the chosen list'} only; a note under the invoice says so.`);
      }
    } else if (shipment && shipment.qty > 0) {
      // No breakdown exists, so the comparison is the order as a whole: one
      // row, same label on both sides. Labelling the shipped side differently
      // from the ordered side would print the whole order as short.
      lines = [{
        kind: InvoiceLineKind.ITEM, description: order.orderName, size: null,
        quantity: shipment.qty, unitPrice: price, amount: null,
      }];
      reconciliation = reconcileShippedAgainstOrdered(
        [{ product: order.orderName, label: 'All sizes', qty: orderedQty }],
        [{ product: order.orderName, label: 'All sizes', qty: shipment.qty }],
      ).groups;
      warnings.push('No packing list with cartons was found, so the goods are one line at the shipment\'s quantity and there is no manifest. Pack the cartons and rebuild to get the full document.');
    } else {
      lines = linesFromPieces(orderedCells);
      warnings.push('Nothing has been packed or shipped on this order yet. The goods lines are the ordered quantities; rebuild the draft once the cartons are packed.');
    }
  }

  // The dates. An invoice is dated the day the goods left when that is known;
  // a quotation is dated today and stands for a fortnight.
  const date = kind === InvoiceKind.INVOICE && shipment?.actualShippingDate
    ? dayOf(shipment.actualShippingDate)
    : dayOf(now);
  const dueDate = kind === InvoiceKind.PROFORMA ? addDays(date, PROFORMA_VALID_DAYS) : date;
  const shippedOn = kind === InvoiceKind.INVOICE
    ? shipment?.actualShippingDate ?? null
    : order.promisedShippingDate;
  const shipmentRef = kind === InvoiceKind.INVOICE
    ? (packingList?.reference?.trim() || shipment?.awbNumber?.trim() || shipment?.trackingNumber?.trim() || shipment?.containerSeal?.trim() || null)
    : null;
  if (kind === InvoiceKind.INVOICE && !shipment) {
    warnings.push('No shipment is recorded on this order. The shipping date is blank; record the shipment on Packing & Shipping and rebuild, or fill it in by hand.');
  }

  return {
    date,
    dueDate,
    paymentTerms: profile.paymentTerms,
    billTo: order.client.name,
    billToAddress: order.billingAddress?.trim() || order.client.billingAddress?.trim() || null,
    billToEmail: order.client.email?.trim() || null,
    customerReference: order.externalReference?.trim() || null,
    shipmentRef,
    shippedOn,
    terms: profile.invoiceTerms,
    bankDetails: profile.bankDetails,
    notes,
    seller: profile,
    orderRef: { id: order.id, poNumber: order.poNumber, orderName: order.orderName, styleNumber: order.styleNumber, clientName: order.client.name },
    lines,
    manifest,
    reconciliation,
    warnings,
  };
}

/** One order of a combined build: what `buildInvoiceDocument` takes for it. */
export interface BuildPart {
  order: BuildOrder;
  packingList: BuildPackingList | null;
  shipment: BuildShipment | null;
  otherPackingLists?: BuildPackingList[];
}

export interface CombinedDocument extends BuiltDocument {
  /** One per order, in the order given, the first being `orderRef`. */
  orderRefs: OrderRef[];
  /** Pieces per order on the goods lines, for the cover note. */
  qtyByOrder: number[];
}

/** A goods line's description without the "(PO x)" a multi-order build adds. */
export const baseDescription = (d: string): string => d.replace(/\s*\(PO [^()]+\)$/, '');

/**
 * Each order's pieces on a document's goods lines, in the order given. A line
 * belongs to the PO its description ends with; on a one-order document every
 * line is that order's, and a line typed without a PO counts on the first.
 */
export function qtyPerOrder(
  lines: Array<{ kind: InvoiceLineKind; description: string; quantity: number | null }>,
  poNumbers: string[],
): number[] {
  const out = poNumbers.map(() => 0);
  for (const l of lines) {
    if (l.kind !== InvoiceLineKind.ITEM || l.quantity == null) continue;
    const i = poNumbers.length === 1 ? 0 : poNumbers.findIndex((po) => l.description.trim().endsWith(`(PO ${po})`));
    out[i < 0 ? 0 : i]! += l.quantity;
  }
  return out.map((q) => Math.round(q));
}

const uniqueJoined = (values: Array<string | null | undefined>): string | null => {
  const seen = [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))];
  return seen.length > 0 ? seen.join(', ') : null;
};

/**
 * A document over one or more orders — an order split into several POs is
 * invoiced on one document. Each order is built on its own by
 * `buildInvoiceDocument`, exactly as a single-order document is, and the
 * results are laid side by side: every goods line, carton and shipped-vs-ordered
 * group keeps the PO it came from, so nothing is pooled across orders that could
 * hide a short shipment on one of them. The bill-to is the first order's; the
 * caller makes sure every order belongs to the same customer.
 */
export function buildCombinedDocument(input: {
  kind: InvoiceKind;
  parts: BuildPart[];
  profile: CompanyProfileDto;
  now?: Date;
}): CombinedDocument {
  const { kind, parts, profile } = input;
  if (parts.length === 0) throw new ValidationError('Pick at least one order.');
  const now = input.now ?? new Date();
  const built = parts.map((p) => buildInvoiceDocument({ kind, ...p, profile, now }));
  const many = parts.length > 1;
  const po = (i: number) => parts[i]!.order.poNumber;

  const lines = built.flatMap((d, i) => d.lines.map((l) => ({
    ...l,
    description: many ? `${l.description} (PO ${po(i)})` : l.description,
  })));
  let n = 0;
  const manifest = built.flatMap((d, i) => d.manifest.map((c) => ({ ...c, n: ++n, poNumber: po(i) })));
  const reconciliation = built.flatMap((d, i) => d.reconciliation.map((g) => ({ ...g, poNumber: po(i) })));
  const warnings = built.flatMap((d, i) => d.warnings.map((w) => (many ? `PO ${po(i)}: ${w}` : w)));
  const notes = built.map((d, i) => (d.notes && many ? `PO ${po(i)}: ${d.notes}` : d.notes)).filter(Boolean).join('\n') || null;
  // One bill-to block: say so when another order carries its own address.
  const firstAddress = built[0]!.billToAddress?.trim() ?? null;
  built.forEach((d, i) => {
    const addr = d.billToAddress?.trim() ?? null;
    if (i > 0 && addr && addr !== firstAddress) {
      warnings.push(`PO ${po(i)} has its own billing address, which differs from PO ${po(0)}'s. The document is billed to PO ${po(0)}'s address; edit the bill-to block if that is wrong.`);
    }
  });

  // An invoice is dated the day the last of its goods left; a quotation today.
  const shippedDates = parts.map((p) => p.shipment?.actualShippingDate ?? null).filter((d): d is Date => d != null);
  const lastShipped = shippedDates.length > 0 ? new Date(Math.max(...shippedDates.map((d) => d.getTime()))) : null;
  const promised = parts.map((p) => p.order.promisedShippingDate).filter((d): d is Date => d != null);
  const date = kind === InvoiceKind.INVOICE && lastShipped ? dayOf(lastShipped) : dayOf(now);
  const dueDate = kind === InvoiceKind.PROFORMA ? addDays(date, PROFORMA_VALID_DAYS) : date;
  const shippedOn = kind === InvoiceKind.INVOICE
    ? lastShipped
    : promised.length > 0 ? new Date(Math.min(...promised.map((d) => d.getTime()))) : null;

  const first = built[0]!;
  return {
    ...first,
    date, dueDate, shippedOn,
    customerReference: uniqueJoined(built.map((d) => d.customerReference)),
    shipmentRef: uniqueJoined(built.map((d) => d.shipmentRef)),
    notes,
    lines, manifest, reconciliation, warnings,
    orderRefs: built.map((d) => d.orderRef),
    qtyByOrder: qtyPerOrder(lines, parts.map((p) => p.order.poNumber)),
  };
}

/** The paragraph above the document, written the way the sample reads — and promising only what is actually below. */
export function defaultCoverNote(input: {
  kind: InvoiceKind; number: string; billTo: string; shipmentRef: string | null;
  poNumber: string; orderName: string; qty: number; hasManifest: boolean;
  /** Every order on the document, when it covers more than one. */
  orders?: Array<{ poNumber: string; orderName: string; qty: number }>;
}): string {
  const { kind, number, billTo, shipmentRef, poNumber, orderName, qty, hasManifest } = input;
  const orderLine = input.orders && input.orders.length > 1
    ? input.orders.map((o) => `PO ${o.poNumber} · ${o.orderName} — ${o.qty.toLocaleString()} pcs`).join('; ')
    : `PO ${poNumber} · ${orderName} — ${qty.toLocaleString()} pcs`;
  if (kind === InvoiceKind.PROFORMA) {
    return [
      `Dear ${billTo},`,
      `Please find below proforma invoice ${number} for your order.`,
      `This proforma covers: ${orderLine}.`,
      'Kindly confirm the quantities and prices so production can be scheduled. We remain at your disposal for any query.',
    ].join('\n');
  }
  const forShipment = shipmentRef ? ` for shipment ${shipmentRef}` : '';
  return [
    `Dear ${billTo},`,
    hasManifest
      ? `Please find below invoice ${number}${forShipment}, with the shipped-quantity reconciliation and the packing list.`
      : `Please find below invoice ${number}${forShipment}.`,
    `This invoice covers: ${orderLine}.`,
    hasManifest
      ? 'Kindly arrange settlement as per the agreed terms. The shipped-versus-ordered reconciliation and the full packing list are included below. We remain at your disposal for any query.'
      : 'Kindly arrange settlement as per the agreed terms. We remain at your disposal for any query.',
  ].join('\n');
}

// ── Loading an order for the builder ─────────────────────────────────────────

const BUILD_INCLUDE = {
  client: { select: { name: true, billingAddress: true, email: true } },
  colors: { include: { color: { select: { name: true } } }, orderBy: { position: 'asc' as const } },
  sizes: { include: { size: { select: { name: true } } }, orderBy: { position: 'asc' as const } },
  quantities: { where: { ledger: 'ORDER' as const }, select: { orderColorId: true, orderSizeId: true, qty: true } },
  shipments: { orderBy: { createdAt: 'desc' as const } },
  packingLists: {
    include: {
      cartons: {
        include: { lines: { orderBy: { position: 'asc' as const } } },
        orderBy: { position: 'asc' as const },
      },
    },
    orderBy: { createdAt: 'desc' as const },
  },
  // Which lists are already on an issued invoice, so "choose for me" prefers one that is not.
  invoiceOrders: { where: { invoice: { kind: 'INVOICE' as const, status: 'ISSUED' as const } }, select: { packingListId: true } },
} satisfies Prisma.OrderInclude;

type LoadedOrder = Prisma.OrderGetPayload<{ include: typeof BUILD_INCLUDE }>;

export async function loadOrderForBuild(orderId: string): Promise<LoadedOrder> {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: orderId }, { poNumber: orderId }] },
    include: BUILD_INCLUDE,
  });
  if (!order) throw new NotFoundError('Order');
  return order;
}

export function toBuildOrder(o: LoadedOrder): BuildOrder {
  return {
    id: o.id, poNumber: o.poNumber, orderName: o.orderName, styleNumber: o.styleNumber,
    externalReference: o.externalReference, pricePerPieceUsd: dec(o.pricePerPieceUsd),
    promisedShippingDate: o.promisedShippingDate, billingAddress: o.billingAddress,
    client: o.client,
    colors: o.colors.map((c) => ({ id: c.id, name: c.color.name, productName: c.productName, position: c.position })),
    sizes: o.sizes.map((s) => ({ id: s.id, name: s.size.name, position: s.position })),
    orderCells: o.quantities,
  };
}

export function toBuildPackingList(l: LoadedOrder['packingLists'][number]): BuildPackingList {
  return {
    id: l.id, reference: l.reference, approved: l.approved,
    cartons: l.cartons.map((c) => ({
      id: c.id, cartonNumber: c.cartonNumber, cartonSize: c.cartonSize,
      orderColorId: c.orderColorId, orderSizeId: c.orderSizeId, qty: c.qty,
      netKg: dec(c.netWeightKg), grossKg: dec(c.grossWeightKg),
      lines: c.lines.map((ln) => ({ orderSizeId: ln.orderSizeId, sizeLabel: ln.sizeLabel, qty: ln.qty })),
    })),
  };
}

export function toBuildShipment(s: LoadedOrder['shipments'][number]): BuildShipment {
  return {
    id: s.id, status: s.status, qty: s.qty, actualShippingDate: s.actualShippingDate,
    awbNumber: s.awbNumber, trackingNumber: s.trackingNumber, containerSeal: s.containerSeal,
  };
}

/**
 * Which packing list and which shipment an invoice is for, when the caller did
 * not say: among lists with cartons, one not already on an issued invoice,
 * approved first, newest first; the consignment furthest along.
 */
export function pickDefaults(o: LoadedOrder, chosen: { packingListId?: string | null; shipmentId?: string | null }) {
  let packingList = chosen.packingListId ? o.packingLists.find((l) => l.id === chosen.packingListId) : undefined;
  if (chosen.packingListId && !packingList) throw new NotFoundError('Packing list');
  if (!packingList) {
    const invoiced = new Set(o.invoiceOrders.map((i) => i.packingListId).filter((id): id is string => id != null));
    const withCartons = o.packingLists.filter((l) => l.cartons.length > 0);
    const fresh = withCartons.filter((l) => !invoiced.has(l.id));
    const pool = fresh.length > 0 ? fresh : withCartons;
    packingList = pool.find((l) => l.approved) ?? pool[0] ?? o.packingLists[0];
  }

  let shipment = chosen.shipmentId ? o.shipments.find((s) => s.id === chosen.shipmentId) : undefined;
  if (chosen.shipmentId && !shipment) throw new NotFoundError('Shipment');
  if (!shipment) {
    const rank: Record<ShipmentStatus, number> = { DELIVERED: 4, SHIPPED: 3, BOOKED: 2, READY: 1, NOT_READY: 0 };
    shipment = [...o.shipments].sort((a, b) => rank[b.status] - rank[a.status])[0];
  }
  return { packingList: packingList ?? null, shipment: shipment ?? null };
}

/** The packing lists and consignments of an order, as the New-document dialog lists them. */
export function sourcesOf(o: {
  packingLists: Array<{ id: string; reference: string | null; approved: boolean; createdAt: Date; cartons: Array<{ qty: number }> }>;
  shipments: Array<{ id: string; status: ShipmentStatus; qty: number; actualShippingDate: Date | null; awbNumber: string | null; trackingNumber: string | null }>;
}) {
  return {
    packingLists: o.packingLists.map((l) => ({
      id: l.id, reference: l.reference, approved: l.approved, cartonCount: l.cartons.length,
      totalQty: l.cartons.reduce((a, c) => a + c.qty, 0), createdAt: l.createdAt.toISOString(),
    })),
    shipments: o.shipments.map((s) => ({
      id: s.id, status: s.status, qty: s.qty, actualShippingDate: s.actualShippingDate?.toISOString() ?? null,
      awbNumber: s.awbNumber, trackingNumber: s.trackingNumber,
    })),
  };
}

// ── Numbering ────────────────────────────────────────────────────────────────

/** The lowest free sequence of this kind and year, so a deleted draft hands its number back. Runs inside the creating transaction. */
export async function nextSequence(tx: Prisma.TransactionClient, kind: InvoiceKind, year: number): Promise<number> {
  const taken = await tx.invoice.findMany({ where: { kind, year }, select: { sequence: true }, orderBy: { sequence: 'asc' } });
  let next = 1;
  for (const { sequence } of taken) {
    if (sequence > next) break;
    if (sequence === next) next += 1;
  }
  return next;
}

export const numberFor = (kind: InvoiceKind, year: number, sequence: number) =>
  formatInvoiceNumber(kind, year, sequence, INVOICE_NUMBER_PREFIX);

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Run `work` with a freshly allocated number, again if another draft took the
 * same number in the meantime. The unique index is what makes the retry safe:
 * it cannot produce a duplicate, only another attempt.
 */
export async function withAllocatedNumber<T>(
  kind: InvoiceKind, year: number,
  work: (tx: Prisma.TransactionClient, number: string, sequence: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const sequence = await nextSequence(tx, kind, year);
        return work(tx, numberFor(kind, year, sequence), sequence);
      });
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 4) continue;
      throw e;
    }
  }
}

// ── Reading back ─────────────────────────────────────────────────────────────

export const INVOICE_INCLUDE = {
  lines: { orderBy: { position: 'asc' as const } },
  orders: {
    orderBy: { position: 'asc' as const },
    include: { order: { select: { id: true, poNumber: true, orderName: true, styleNumber: true, client: { select: { name: true } } } } },
  },
  order: { select: { id: true, poNumber: true, orderName: true, styleNumber: true, client: { select: { name: true } } } },
  preparedBy: { select: { name: true } },
  issuedBy: { select: { name: true } },
} satisfies Prisma.InvoiceInclude;

export type LoadedInvoice = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

export function lineToDto(l: LoadedInvoice['lines'][number]): InvoiceLineDto {
  const quantity = dec(l.quantity);
  const unitPrice = dec(l.unitPrice);
  const amount = dec(l.amount);
  return {
    id: l.id, kind: l.kind, description: l.description, size: l.size, quantity, unitPrice, amount,
    lineTotal: lineTotal({ kind: l.kind, description: l.description, quantity, unitPrice, amount }),
    position: l.position,
  };
}

/** Everything about a carton the manifest prints, so any change to it makes the draft stale. */
export function manifestFingerprint(manifest: InvoiceCartonDto[]): string {
  return manifest
    .map((c) => `${c.cartonNumber}=${c.pieces}|${c.cartonSize ?? ''}|${c.netKg ?? ''}|${c.grossKg ?? ''}|${c.contents.map((x) => `${x.label}:${x.qty}`).join(',')}`)
    .join('\n');
}

/** The orders on a document with the list and consignment each was read from, the first one first. */
type PartRow = { orderId: string; packingListId: string | null; shipmentId: string | null };
export function partsOf(inv: PartRow & { orders: PartRow[] }): PartRow[] {
  return inv.orders.length > 0
    ? inv.orders.map((o) => ({ orderId: o.orderId, packingListId: o.packingListId, shipmentId: o.shipmentId }))
    : [{ orderId: inv.orderId, packingListId: inv.packingListId, shipmentId: inv.shipmentId }];
}

/** A draft whose cartons changed underneath it. Issued documents are never stale: they are the record. */
export async function isStale(inv: LoadedInvoice): Promise<boolean> {
  if (inv.status !== InvoiceStatus.DRAFT || inv.kind !== InvoiceKind.INVOICE) return false;
  const manifest = inv.manifest as unknown as InvoiceCartonDto[];
  const parts = partsOf(inv);
  for (const part of parts) {
    // The cartons this order contributed: tagged with its PO, or the whole
    // manifest on a document built before cartons carried one.
    const row = inv.orders.find((o) => o.orderId === part.orderId);
    const po = (row?.orderRef as unknown as OrderRef | null)?.poNumber ?? row?.order.poNumber;
    const own = parts.length === 1 ? manifest : manifest.filter((c) => c.poNumber === po);
    if (await partIsStale(part.orderId, part.packingListId, own)) return true;
  }
  return false;
}

async function partIsStale(orderId: string, packingListId: string | null, built: InvoiceCartonDto[]): Promise<boolean> {
  if (!packingListId) {
    // Built before anything was packed: the moment a carton exists, the
    // ordered quantities it carries are no longer what shipped.
    const packed = await prisma.carton.count({ where: { packingList: { orderId } } });
    return packed > 0;
  }
  const list = await prisma.packingList.findUnique({
    where: { id: packingListId },
    include: {
      order: { include: { sizes: { include: { size: { select: { name: true } } } } } },
      cartons: { include: { lines: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
    },
  });
  if (!list) return true;
  const sizes = list.order.sizes.map((s) => ({ id: s.id, name: s.size.name, position: s.position }));
  const order = { sizes } as BuildOrder;
  const now = toBuildPackingList(list).cartons.map((c, i): InvoiceCartonDto => {
    const contents = cartonContents(order, c);
    return { n: i + 1, cartonNumber: c.cartonNumber, cartonSize: c.cartonSize, product: '', contents, pieces: contents.reduce((a, x) => a + x.qty, 0), netKg: c.netKg, grossKg: c.grossKg };
  });
  return manifestFingerprint(now) !== manifestFingerprint(built);
}

export function invoiceToDto(inv: LoadedInvoice, stale = false): InvoiceDto {
  const lines = inv.lines.map(lineToDto);
  const totals = computeInvoiceTotals(lines);
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  // The snapshot, when there is one; the live order only for a row built before snapshots existed.
  const ref = (inv.orderRef as unknown as OrderRef | null) ?? {
    id: inv.order.id, poNumber: inv.order.poNumber, orderName: inv.order.orderName,
    styleNumber: inv.order.styleNumber, clientName: inv.order.client.name,
  };
  return {
    id: inv.id,
    kind: inv.kind,
    status: inv.status,
    number: inv.number,
    date: inv.date.toISOString(),
    dueDate: iso(inv.dueDate),
    paymentTerms: inv.paymentTerms,
    order: { ...ref, id: inv.order.id },
    orders: orderRefsOf(inv, ref),
    shipmentId: inv.shipmentId,
    packingListId: inv.packingListId,
    billTo: inv.billTo,
    billToAddress: inv.billToAddress,
    billToEmail: inv.billToEmail,
    customerReference: inv.customerReference,
    shipmentRef: inv.shipmentRef,
    shippedOn: iso(inv.shippedOn),
    coverNote: inv.coverNote,
    terms: inv.terms,
    bankDetails: inv.bankDetails,
    notes: inv.notes,
    seller: inv.seller as unknown as CompanyProfileDto,
    lines,
    manifest: inv.manifest as unknown as InvoiceCartonDto[],
    reconciliation: inv.reconciliation as unknown as InvoiceReconciliationGroupDto[],
    warnings: (inv.warnings as unknown as string[]) ?? [],
    totals,
    totalInWords: amountInWords(totals.total),
    preparedByName: inv.preparedBy?.name ?? null,
    issuedByName: inv.issuedBy?.name ?? null,
    issuedAt: iso(inv.issuedAt),
    sentAt: iso(inv.sentAt),
    voidedAt: iso(inv.voidedAt),
    voidReason: inv.voidReason,
    stale,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
  };
}

/** Every order on a document from its snapshots, falling back to the live order where a row has none. */
function orderRefsOf(inv: LoadedInvoice, first: OrderRef): InvoiceOrderRefDto[] {
  if (inv.orders.length === 0) {
    return [{ ...first, id: inv.order.id, packingListId: inv.packingListId, shipmentId: inv.shipmentId }];
  }
  return inv.orders.map((o) => {
    const snap = o.orderRef as unknown as OrderRef | null;
    return {
      id: o.order.id,
      poNumber: snap?.poNumber ?? o.order.poNumber,
      orderName: snap?.orderName ?? o.order.orderName,
      styleNumber: snap ? snap.styleNumber : o.order.styleNumber,
      clientName: snap?.clientName ?? o.order.client.name,
      packingListId: o.packingListId,
      shipmentId: o.shipmentId,
    };
  });
}

export function invoiceToListRow(inv: LoadedInvoice): InvoiceListRowDto {
  const totals = computeInvoiceTotals(inv.lines.map(lineToDto));
  const ref = (inv.orderRef as unknown as OrderRef | null);
  const firstRef: OrderRef = ref ?? {
    id: inv.order.id, poNumber: inv.order.poNumber, orderName: inv.order.orderName,
    styleNumber: inv.order.styleNumber, clientName: inv.order.client.name,
  };
  return {
    id: inv.id, kind: inv.kind, status: inv.status, number: inv.number,
    date: inv.date.toISOString(), dueDate: inv.dueDate?.toISOString() ?? null,
    orderId: inv.order.id, poNumber: ref?.poNumber ?? inv.order.poNumber, orderName: ref?.orderName ?? inv.order.orderName,
    clientName: ref?.clientName ?? inv.order.client.name, billTo: inv.billTo,
    orders: orderRefsOf(inv, firstRef).map((o) => ({ orderId: o.id, poNumber: o.poNumber, orderName: o.orderName })),
    totalQty: totals.totalQty, total: totals.total, incomplete: totals.incomplete,
    issuedAt: inv.issuedAt?.toISOString() ?? null, sentAt: inv.sentAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

export async function loadInvoice(id: string): Promise<LoadedInvoice> {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
  if (!inv) throw new NotFoundError('Invoice');
  return inv;
}

/** The rule every write shares: only a draft changes. */
export function assertDraft(inv: { status: InvoiceStatus; number: string }): void {
  if (inv.status === InvoiceStatus.ISSUED) {
    throw new ConflictError(`${inv.number} has been issued. The customer holds that copy; it cannot be changed. Void it and raise a new one if it is wrong.`);
  }
  if (inv.status === InvoiceStatus.VOID) {
    throw new ConflictError(`${inv.number} is void and cannot be changed.`);
  }
}

/**
 * Thrown when a status-guarded write touched nothing: the document moved on
 * between the read and the write — somebody issued, voided or deleted it.
 */
export function assertStillDraft(count: number, number: string): void {
  if (count === 0) {
    throw new ConflictError(`${number} changed while you were working on it — it was issued, voided or deleted by somebody else. Reload it.`);
  }
}

export function assertIssuable(dto: InvoiceDto): void {
  const blockers = issueBlockers(dto);
  if (blockers.length > 0) throw new ValidationError(blockers.join(' '));
}
