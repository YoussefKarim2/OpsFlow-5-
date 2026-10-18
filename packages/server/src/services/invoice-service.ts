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
 * unique index, and retried once on a collision, so two people pressing "New"
 * together get consecutive numbers rather than an error or a duplicate.
 */

import { Prisma } from '@prisma/client';
import {
  INVOICE_NUMBER_PREFIX, InvoiceKind, InvoiceLineKind, InvoiceStatus, ShipmentStatus,
  amountInWords, computeInvoiceTotals, formatInvoiceNumber, issueBlockers, lineTotal,
  reconcileShippedAgainstOrdered, summariseSizes,
  type CompanyProfileDto, type InvoiceCartonDto, type InvoiceDto, type InvoiceLineDto,
  type InvoiceListRowDto, type InvoiceReconciliationGroupDto,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const dec = (v: { toString(): string } | null | undefined): number | null =>
  v == null ? null : Number(v.toString());

// ── Company profile ──────────────────────────────────────────────────────────

const PROFILE_ID = 'default';

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

/** The one row, created with the factory's name and nothing else the first time it is asked for. */
export async function getCompanyProfile(): Promise<CompanyProfileDto> {
  const row = await prisma.companyProfile.upsert({
    where: { id: PROFILE_ID },
    create: { id: PROFILE_ID },
    update: {},
  });
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
  seller: CompanyProfileDto;
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

const today = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export function buildInvoiceDocument(input: {
  kind: InvoiceKind;
  order: BuildOrder;
  packingList: BuildPackingList | null;
  shipment: BuildShipment | null;
  profile: CompanyProfileDto;
  now?: Date;
}): BuiltDocument {
  const { kind, order, packingList, shipment, profile } = input;
  const now = input.now ?? new Date();
  const warnings: string[] = [];
  const price = order.pricePerPieceUsd;
  const sizeOrder = [...order.sizes].sort((a, b) => a.position - b.position).map((s) => s.name);
  const colourRank = (id: string | null) => (id ? order.colors.find((c) => c.id === id)?.position ?? 9999 : 9999);

  if (price == null) {
    warnings.push('The order has no unit price, so the goods lines have no amount. Set the price on Order Details, or type a rate on each line.');
  }

  // Ordered, per colour and size, from the ORDER ledger.
  const ordered = order.orderCells
    .filter((c) => c.qty > 0)
    .map((c) => ({
      colorId: c.orderColorId,
      product: productLabel(order, c.orderColorId),
      label: order.sizes.find((s) => s.id === c.orderSizeId)?.name ?? 'Unsized',
      qty: c.qty,
    }));

  let lines: BuiltLine[] = [];
  let manifest: InvoiceCartonDto[] = [];
  let reconciliation: InvoiceReconciliationGroupDto[] = [];

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
    lines = linesFromPieces(ordered);
    if (lines.length === 0) {
      warnings.push('The order has no quantities yet, so there are no goods lines. Fill the main order, or add the lines by hand.');
    }
  } else {
    const cartons = packingList?.cartons ?? [];
    if (cartons.length > 0) {
      const shipped = cartons.flatMap((c) =>
        cartonContents(order, c).map((x) => ({ colorId: c.orderColorId, product: productLabel(order, c.orderColorId), label: x.label, qty: x.qty })));
      lines = linesFromPieces(shipped);
      manifest = cartons.map((c, i) => {
        const contents = cartonContents(order, c);
        return {
          n: i + 1,
          cartonNumber: c.cartonNumber,
          cartonSize: c.cartonSize,
          product: productLabel(order, c.orderColorId),
          contents,
          pieces: contents.reduce((a, x) => a + x.qty, 0),
          netKg: c.netKg,
          grossKg: c.grossKg,
        };
      });
      reconciliation = reconcileShippedAgainstOrdered(ordered, shipped, sizeOrder).groups;
      if (packingList && !packingList.approved) {
        warnings.push('The packing list has not been approved yet. The cartons may still change; rebuild the draft before issuing if they do.');
      }
      const packed = manifest.reduce((a, c) => a + c.pieces, 0);
      if (shipment && shipment.qty > 0 && shipment.qty !== packed) {
        warnings.push(`The cartons hold ${packed.toLocaleString()} pieces but the shipment records ${shipment.qty.toLocaleString()}. The invoice follows the cartons; check which is right.`);
      }
    } else if (shipment && shipment.qty > 0) {
      lines = [{
        kind: InvoiceLineKind.ITEM, description: order.orderName, size: null,
        quantity: shipment.qty, unitPrice: price, amount: null,
      }];
      reconciliation = reconcileShippedAgainstOrdered(ordered, [{ product: order.orderName, label: 'All sizes', qty: shipment.qty }], sizeOrder).groups;
      warnings.push('No packing list with cartons was found, so the goods are one line at the shipment\'s quantity and there is no manifest. Pack the cartons and rebuild to get the full document.');
    } else {
      lines = linesFromPieces(ordered);
      warnings.push('Nothing has been packed or shipped on this order yet. The goods lines are the ordered quantities; rebuild the draft once the cartons are packed.');
    }
  }

  // The dates. An invoice is dated the day the goods left when that is known;
  // a quotation is dated today. Due on the same day until somebody says otherwise.
  const date = kind === InvoiceKind.INVOICE && shipment?.actualShippingDate
    ? today(shipment.actualShippingDate)
    : today(now);
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
    dueDate: date,
    paymentTerms: profile.paymentTerms,
    billTo: order.client.name,
    billToAddress: order.billingAddress?.trim() || order.client.billingAddress?.trim() || null,
    billToEmail: order.client.email?.trim() || null,
    customerReference: order.externalReference?.trim() || null,
    shipmentRef,
    shippedOn,
    terms: profile.invoiceTerms,
    bankDetails: profile.bankDetails,
    seller: profile,
    lines,
    manifest,
    reconciliation,
    warnings,
  };
}

/** The paragraph above the document, written the way the sample reads. */
export function defaultCoverNote(input: {
  kind: InvoiceKind; number: string; billTo: string; shipmentRef: string | null;
  poNumber: string; orderName: string; qty: number;
}): string {
  const { kind, number, billTo, shipmentRef, poNumber, orderName, qty } = input;
  const orderLine = `PO ${poNumber} · ${orderName} — ${qty.toLocaleString()} pcs`;
  if (kind === InvoiceKind.PROFORMA) {
    return [
      `Dear ${billTo},`,
      `Please find below proforma invoice ${number} for your order.`,
      `This proforma covers: ${orderLine}.`,
      'Kindly confirm the quantities and prices so production can be scheduled. We remain at your disposal for any query.',
    ].join('\n');
  }
  return [
    `Dear ${billTo},`,
    `Please find below invoice ${number}${shipmentRef ? ` for shipment ${shipmentRef}` : ''}, with the shipped-quantity reconciliation and the packing list.`,
    `This invoice covers: ${orderLine}.`,
    'Kindly arrange settlement as per the agreed terms. The shipped-versus-ordered reconciliation and the full packing list are included below. We remain at your disposal for any query.',
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
 * not say: the approved list with cartons if there is one, else the newest
 * with cartons; the consignment furthest along, else the newest.
 */
export function pickDefaults(o: LoadedOrder, chosen: { packingListId?: string | null; shipmentId?: string | null }) {
  let packingList = chosen.packingListId ? o.packingLists.find((l) => l.id === chosen.packingListId) : undefined;
  if (chosen.packingListId && !packingList) throw new NotFoundError('Packing list');
  if (!packingList) {
    const withCartons = o.packingLists.filter((l) => l.cartons.length > 0);
    packingList = withCartons.find((l) => l.approved) ?? withCartons[0] ?? o.packingLists[0];
  }

  let shipment = chosen.shipmentId ? o.shipments.find((s) => s.id === chosen.shipmentId) : undefined;
  if (chosen.shipmentId && !shipment) throw new NotFoundError('Shipment');
  if (!shipment) {
    const rank: Record<ShipmentStatus, number> = { DELIVERED: 4, SHIPPED: 3, BOOKED: 2, READY: 1, NOT_READY: 0 };
    shipment = [...o.shipments].sort((a, b) => rank[b.status] - rank[a.status])[0];
  }
  return { packingList: packingList ?? null, shipment: shipment ?? null };
}

// ── Numbering ────────────────────────────────────────────────────────────────

/** The next sequence of this kind and year. Must run inside the creating transaction. */
export async function nextSequence(tx: Prisma.TransactionClient, kind: InvoiceKind, year: number): Promise<number> {
  const last = await tx.invoice.aggregate({ where: { kind, year }, _max: { sequence: true } });
  return (last._max.sequence ?? 0) + 1;
}

export const numberFor = (kind: InvoiceKind, year: number, sequence: number) =>
  formatInvoiceNumber(kind, year, sequence, INVOICE_NUMBER_PREFIX);

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Run `work` with a freshly allocated number, once more if another draft took
 * the same number in the meantime. The unique index is what makes the second
 * attempt safe: it cannot produce a duplicate, only a retry.
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
      if (isUniqueViolation(e) && attempt < 2) continue;
      throw e;
    }
  }
}

// ── Reading back ─────────────────────────────────────────────────────────────

export const INVOICE_INCLUDE = {
  lines: { orderBy: { position: 'asc' as const } },
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

/** The cartons as the manifest remembers them, against the cartons as they are now. */
export function manifestFingerprint(manifest: InvoiceCartonDto[]): string {
  return manifest.map((c) => `${c.cartonNumber}=${c.pieces}`).join('|');
}
export function cartonsFingerprint(cartons: Array<{ cartonNumber: string; qty: number }>): string {
  return cartons.map((c) => `${c.cartonNumber}=${c.qty}`).join('|');
}

export function invoiceToDto(inv: LoadedInvoice, stale = false): InvoiceDto {
  const lines = inv.lines.map(lineToDto);
  const totals = computeInvoiceTotals(lines);
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    id: inv.id,
    kind: inv.kind,
    status: inv.status,
    number: inv.number,
    date: inv.date.toISOString(),
    dueDate: iso(inv.dueDate),
    paymentTerms: inv.paymentTerms,
    order: {
      id: inv.order.id, poNumber: inv.order.poNumber, orderName: inv.order.orderName,
      styleNumber: inv.order.styleNumber, clientName: inv.order.client.name,
    },
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

export function invoiceToListRow(inv: LoadedInvoice): InvoiceListRowDto {
  const totals = computeInvoiceTotals(inv.lines.map(lineToDto));
  return {
    id: inv.id, kind: inv.kind, status: inv.status, number: inv.number,
    date: inv.date.toISOString(), dueDate: inv.dueDate?.toISOString() ?? null,
    orderId: inv.order.id, poNumber: inv.order.poNumber, orderName: inv.order.orderName,
    clientName: inv.order.client.name, billTo: inv.billTo,
    totalQty: totals.totalQty, total: totals.total, incomplete: totals.incomplete,
    issuedAt: inv.issuedAt?.toISOString() ?? null, sentAt: inv.sentAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

/** A draft whose packing list has changed underneath it. Issued documents are never stale: they are the record. */
export async function isStale(inv: LoadedInvoice): Promise<boolean> {
  if (inv.status !== InvoiceStatus.DRAFT || inv.kind !== InvoiceKind.INVOICE || !inv.packingListId) return false;
  const cartons = await prisma.carton.findMany({
    where: { packingListId: inv.packingListId },
    select: { cartonNumber: true, qty: true },
    orderBy: { position: 'asc' },
  });
  return cartonsFingerprint(cartons) !== manifestFingerprint(inv.manifest as unknown as InvoiceCartonDto[]);
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

export function assertIssuable(dto: InvoiceDto): void {
  const blockers = issueBlockers(dto);
  if (blockers.length > 0) throw new ValidationError(blockers.join(' '));
}
