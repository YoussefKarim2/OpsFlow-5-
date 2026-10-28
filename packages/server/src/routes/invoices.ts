/**
 * Proforma / Invoice, over HTTP.
 *
 * `POST /` builds a draft from an order; everything after that is a decision
 * about that draft — edit it, rebuild it from the order, issue it, mark it
 * sent, void it. The document itself is rendered by the web client from the
 * stored record, so what prints is what is stored, and an issued invoice
 * cannot read differently on two days.
 *
 * Every write that depends on the status carries that status in its WHERE
 * clause, so two people acting on one document at the same moment cannot
 * edit, delete or issue past each other: the second write touches nothing and
 * is told to reload.
 *
 * Permissions: `invoice:read` opens the section, `invoice:write` builds and
 * edits drafts, `invoice:issue` freezes and voids. The company letterhead is
 * edited under `settings:manage`, by a super administrator, because a bank
 * account on a customer document is not something every role should be able
 * to change.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { INVOICE_LINE_LAYOUTS, InvoiceKind, InvoiceLineKind, InvoiceStatus, SHEET_DEFAULTS, computeInvoiceTotals, resolveShippedQty, type InvoiceCandidateDto, type ProformaSheetSettings } from '@opsflow/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticate, currentUser, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { dateInput } from '../util/date-input.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../errors.js';
import { logActivity } from '../services/activity-service.js';
import { proformaSheetWorkbook } from '../services/proforma-sheet-xlsx.js';
import { contentDisposition } from '../util/upload-name.js';
import {
  INVOICE_INCLUDE, PROFILE_ID, assertDraft, assertIssuable, assertStillDraft, buildCombinedDocument, defaultCoverNote,
  carriedRates, getCompanyProfile, invoiceToDto, invoiceToListRow, isStale, lineToDto, loadInvoice, loadOrderForBuild, partsOf, pickDefaults, qtyPerOrder,
  profileToDto, sourcesOf, toBuildOrder, toBuildPackingList, toBuildShipment, withAllocatedNumber,
} from '../services/invoice-service.js';

export const invoicesRouter = Router();
invoicesRouter.use(authenticate);

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const email = z.string().trim().email('That is not an email address').max(200).nullable().optional().or(z.literal('').transform(() => null));

/** The letterhead gate: the super-admin flag, with a refusal that is about the letterhead. */
function requireLetterheadEditor(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new UnauthorizedError());
  if (!req.user.isSuperAdmin) {
    return next(new ForbiddenError('Only a super administrator can change the company letterhead and payment details.'));
  }
  next();
}

// ── Company profile ──────────────────────────────────────────────────────────

invoicesRouter.get('/company', requirePermission('invoice:read'), asyncHandler(async (_req, res) => {
  res.json({ data: await getCompanyProfile() });
}));

const profileSchema = z.object({
  name: z.string().trim().min(1, 'The company needs a name.').max(200),
  tagline: text(200),
  address: text(600),
  taxId: text(100),
  email,
  phone: text(60),
  website: text(200),
  bankDetails: text(2000),
  invoiceTerms: text(4000),
  paymentTerms: text(200),
});

invoicesRouter.put('/company', requirePermission('settings:manage'), requireLetterheadEditor, asyncHandler(async (req, res) => {
  const body = profileSchema.parse(req.body);
  const user = currentUser(req);
  const data = {
    name: body.name,
    tagline: body.tagline ?? null, address: body.address ?? null, taxId: body.taxId ?? null,
    email: body.email ?? null, phone: body.phone ?? null, website: body.website ?? null,
    bankDetails: body.bankDetails ?? null, invoiceTerms: body.invoiceTerms ?? null, paymentTerms: body.paymentTerms ?? null,
    updatedById: user.id,
  };
  const row = await prisma.companyProfile.upsert({
    where: { id: PROFILE_ID },
    create: { id: PROFILE_ID, ...data },
    update: data,
  });
  await logActivity({
    actorId: user.id, actorName: user.name,
    action: 'invoice.company.update', summary: 'Updated the company letterhead and payment details',
    entityType: 'CompanyProfile', entityId: PROFILE_ID,
  });
  res.json({ data: profileToDto(row) });
}));

// ── Candidates: orders that could be invoiced now ────────────────────────────

const SOURCE_SELECT = {
  packingLists: { select: { id: true, reference: true, approved: true, createdAt: true, cartons: { select: { qty: true } } }, orderBy: { createdAt: 'desc' as const } },
  shipments: { select: { id: true, status: true, qty: true, actualShippingDate: true, awbNumber: true, trackingNumber: true }, orderBy: { createdAt: 'desc' as const } },
};

invoicesRouter.get('/candidates', requirePermission('invoice:read'), asyncHandler(async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: {
      cancelled: false,
      OR: [
        { shipments: { some: { qty: { gt: 0 } } } },
        { packingLists: { some: { cartons: { some: {} } } } },
      ],
    },
    select: {
      id: true, poNumber: true, orderName: true, clientId: true, pricePerPieceUsd: true,
      client: { select: { name: true } },
      ...SOURCE_SELECT,
      quantities: { where: { ledger: { in: ['ORDER', 'SHIPPED'] } }, select: { orderColorId: true, orderSizeId: true, ledger: true, qty: true } },
      // Through the join, so a document covering several orders counts on each of them.
      invoiceOrders: {
        select: { qty: true, invoice: { select: { id: true, kind: true, status: true, number: true, createdAt: true, lines: { select: { kind: true, quantity: true } } } } },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });

  const data: InvoiceCandidateDto[] = orders.map((o) => {
    const cells = o.quantities.map((q) => ({ colorId: q.orderColorId, sizeId: q.orderSizeId, ledger: q.ledger, qty: q.qty }));
    return {
      orderId: o.id, poNumber: o.poNumber, orderName: o.orderName, clientId: o.clientId, clientName: o.client.name,
      orderQty: cells.filter((c) => c.ledger === 'ORDER').reduce((a, c) => a + c.qty, 0),
      packedQty: o.packingLists.reduce((a, l) => a + l.cartons.reduce((b, c) => b + c.qty, 0), 0),
      shippedQty: resolveShippedQty(cells, o.shipments),
      pricePerPieceUsd: o.pricePerPieceUsd == null ? null : Number(o.pricePerPieceUsd.toString()),
      invoices: [...o.invoiceOrders]
        .sort((a, b) => b.invoice.createdAt.getTime() - a.invoice.createdAt.getTime())
        .map(({ qty, invoice: i }) => ({
          id: i.id, kind: i.kind, status: i.status, number: i.number,
          // This order's share of the document, so a shared invoice does not
          // count another PO's pieces as invoiced here. A row without a share
          // (built before shares were kept) is the whole document.
          totalQty: qty ?? i.lines.filter((l) => l.kind === InvoiceLineKind.ITEM).reduce((a, l) => a + (l.quantity == null ? 0 : Number(l.quantity.toString())), 0),
        })),
      ...sourcesOf(o),
    };
  });

  res.json({ data });
}));

/** The lists and consignments of one order, for the "New" dialog when it is opened on an order the candidates did not list. */
invoicesRouter.get('/order/:orderId/sources', requirePermission('invoice:read'), asyncHandler(async (req, res) => {
  const o = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.orderId }, { poNumber: req.params.orderId }] },
    select: { id: true, poNumber: true, orderName: true, clientId: true, pricePerPieceUsd: true, client: { select: { name: true } }, ...SOURCE_SELECT },
  });
  if (!o) throw new NotFoundError('Order');
  res.json({
    data: {
      orderId: o.id, poNumber: o.poNumber, orderName: o.orderName, clientId: o.clientId, clientName: o.client.name,
      pricePerPieceUsd: o.pricePerPieceUsd == null ? null : Number(o.pricePerPieceUsd.toString()),
      ...sourcesOf(o),
    },
  });
}));

// ── List ─────────────────────────────────────────────────────────────────────

invoicesRouter.get('/', requirePermission('invoice:read'), asyncHandler(async (req, res) => {
  const kind = z.nativeEnum(InvoiceKind).optional().parse(req.query.kind || undefined);
  const status = z.nativeEnum(InvoiceStatus).optional().parse(req.query.status || undefined);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const rows = await prisma.invoice.findMany({
    where: {
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(q ? {
        OR: [
          { number: { contains: q, mode: 'insensitive' } },
          { billTo: { contains: q, mode: 'insensitive' } },
          { orders: { some: { order: { poNumber: { contains: q, mode: 'insensitive' } } } } },
          { orders: { some: { order: { orderName: { contains: q, mode: 'insensitive' } } } } },
          { order: { poNumber: { contains: q, mode: 'insensitive' } } },
          { order: { orderName: { contains: q, mode: 'insensitive' } } },
          { order: { client: { name: { contains: q, mode: 'insensitive' } } } },
        ],
      } : {}),
    },
    include: INVOICE_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
    take: 500,
  });
  res.json({ data: rows.map(invoiceToListRow) });
}));

// ── Create ───────────────────────────────────────────────────────────────────

const sourceChoice = z.object({
  orderId: z.string().min(1),
  shipmentId: z.string().nullable().optional(),
  packingListId: z.string().nullable().optional(),
});

/**
 * One order (`orderId`, as the order's Invoice step links it) or several
 * (`orders`): an order split into several POs is invoiced on one document.
 */
const createSchema = z.object({
  kind: z.nativeEnum(InvoiceKind),
  orders: z.array(sourceChoice).min(1, 'Pick at least one order.').max(30, 'At most 30 orders on one document.').optional(),
  orderId: z.string().min(1).optional(),
  shipmentId: z.string().nullable().optional(),
  packingListId: z.string().nullable().optional(),
}).refine((b) => b.orders || b.orderId, { message: 'Pick at least one order.' });

type SourceChoice = z.infer<typeof sourceChoice>;

/** The builder's inputs for one or more orders, honouring each one's chosen list and consignment. */
async function buildFor(kind: InvoiceKind, choices: SourceChoice[]) {
  const forInvoice = kind === InvoiceKind.INVOICE;
  const loadedAll = [];
  for (const c of choices) loadedAll.push(await loadOrderForBuild(c.orderId));
  // An order may be named by id or PO; the same order twice is one order —
  // unless the two ask for different packing lists or shipments, which one
  // order on one document cannot honour, so that is refused rather than guessed.
  const seen = new Map<string, SourceChoice>();
  const picked = loadedAll.map((loaded, i) => ({ loaded, choice: choices[i]! })).filter(({ loaded, choice }) => {
    const before = seen.get(loaded.id);
    if (!before) { seen.set(loaded.id, choice); return true; }
    if ((before.packingListId ?? null) !== (choice.packingListId ?? null) || (before.shipmentId ?? null) !== (choice.shipmentId ?? null)) {
      throw new ValidationError(`PO ${loaded.poNumber} is listed twice with different packing lists or shipments. One order goes on a document once.`);
    }
    return false;
  });
  for (const { loaded } of picked) {
    if (loaded.cancelled) throw new ConflictError(`PO ${loaded.poNumber} is cancelled. A cancelled order is not invoiced.`);
  }
  const clients = new Set(picked.map(({ loaded }) => loaded.clientId));
  if (clients.size > 1) {
    const owners = picked.map(({ loaded }) => `PO ${loaded.poNumber} (${loaded.client.name})`).join(', ');
    throw new ValidationError(`One document is billed to one customer, and these orders belong to different customers: ${owners}. Build a document per customer.`);
  }
  const parts = picked.map(({ loaded, choice }) => {
    const { packingList, shipment } = pickDefaults(loaded, choice);
    return {
      loaded,
      shipmentId: forInvoice ? shipment?.id ?? null : null,
      packingListId: forInvoice ? packingList?.id ?? null : null,
      build: {
        order: toBuildOrder(loaded),
        packingList: forInvoice && packingList ? toBuildPackingList(packingList) : null,
        shipment: forInvoice && shipment ? toBuildShipment(shipment) : null,
        otherPackingLists: forInvoice ? loaded.packingLists.filter((l) => l.id !== packingList?.id).map(toBuildPackingList) : [],
      },
    };
  });
  const profile = await getCompanyProfile();
  const doc = buildCombinedDocument({ kind, parts: parts.map((p) => p.build), profile });
  return { parts, doc };
}

/**
 * A new proforma's sheet fields: the customer's last proforma sheet without
 * its dates and title, or the factory's defaults with the letterhead as exporter.
 */
async function seedSheet(clientId: string, seller: { name?: string; address?: string | null }): Promise<ProformaSheetSettings> {
  const last = await prisma.invoice.findFirst({
    where: { kind: InvoiceKind.PROFORMA, sheet: { not: Prisma.DbNull }, order: { clientId } },
    orderBy: { createdAt: 'desc' }, select: { sheet: true },
  });
  if (last?.sheet) {
    const { title: _t, onBoardDate: _o, etd: _e, rows, ...kept } = last.sheet as ProformaSheetSettings;
    // A style's part number, HTS code, pieces per carton and unit are the
    // style's; its PO, cartons, weights and wording belong to that one order.
    const carried: NonNullable<ProformaSheetSettings['rows']> = {};
    for (const [key, r] of Object.entries(rows ?? {})) {
      const row = { partNo: r.partNo ?? null, hts: r.hts ?? null, perCarton: r.perCarton ?? null, unit: r.unit ?? null };
      if (Object.values(row).some((v) => v != null)) carried[key] = row;
    }
    return { ...kept, rows: carried };
  }
  return {
    statement: SHEET_DEFAULTS.statement, shipmentFrom: SHEET_DEFAULTS.shipmentFrom,
    container: SHEET_DEFAULTS.container, cartonsPerContainer: SHEET_DEFAULTS.cartonsPerContainer, leadDays: SHEET_DEFAULTS.leadDays,
    consolidatingVendor: seller.name ?? null, exporterName: seller.name ?? null, exporterAddress: seller.address ?? null,
    rows: {},
  };
}

/** The join rows for a built document, the first order first. */
const orderRows = (
  parts: Awaited<ReturnType<typeof buildFor>>['parts'],
  doc: Awaited<ReturnType<typeof buildFor>>['doc'],
  qty: number[] = doc.qtyByOrder,
) =>
  parts.map((p, i) => ({
    orderId: p.loaded.id, packingListId: p.packingListId, shipmentId: p.shipmentId,
    position: i, orderRef: doc.orderRefs[i] as object, qty: qty[i] ?? 0,
  }));

/** One activity entry on every order the document covers, so each order's history shows it. */
async function logOnOrders(orderIds: string[], entry: Omit<Parameters<typeof logActivity>[0], 'orderId'>) {
  for (const orderId of orderIds) await logActivity({ ...entry, orderId });
}

const poList = (refs: Array<{ poNumber: string }>) => refs.map((r) => r.poNumber).join(', ');

invoicesRouter.post('/', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const user = currentUser(req);
  const choices: SourceChoice[] = body.orders
    ?? [{ orderId: body.orderId!, packingListId: body.packingListId, shipmentId: body.shipmentId }];
  const { parts, doc } = await buildFor(body.kind, choices);
  const first = parts[0]!;
  // Numbered in the year it is raised, whatever date the goods left: a run of
  // numbers belongs to the year the office is working in.
  const year = new Date().getUTCFullYear();
  const qty = computeInvoiceTotals(doc.lines).totalQty;
  // A proforma is laid out as the factory's own sheet, its typed fields
  // carried from the customer's last one.
  const sheet = body.kind === InvoiceKind.PROFORMA ? await seedSheet(first.loaded.clientId, doc.seller as { name?: string; address?: string | null }) : null;

  const created = await withAllocatedNumber(body.kind, year, async (tx, number, sequence) =>
    tx.invoice.create({
      data: {
        kind: body.kind, number, year, sequence,
        orderId: first.loaded.id, shipmentId: first.shipmentId, packingListId: first.packingListId,
        date: doc.date, dueDate: doc.dueDate, paymentTerms: doc.paymentTerms,
        billTo: doc.billTo, billToAddress: doc.billToAddress, billToEmail: doc.billToEmail,
        customerReference: doc.customerReference, shipmentRef: doc.shipmentRef, shippedOn: doc.shippedOn,
        coverNote: defaultCoverNote({
          kind: body.kind, number, billTo: doc.billTo, shipmentRef: doc.shipmentRef,
          poNumber: first.loaded.poNumber, orderName: first.loaded.orderName, qty, hasManifest: doc.manifest.length > 0,
          orders: parts.map((p, i) => ({ poNumber: p.loaded.poNumber, orderName: p.loaded.orderName, qty: doc.qtyByOrder[i] ?? 0 })),
        }),
        terms: doc.terms, bankDetails: doc.bankDetails, notes: doc.notes,
        ...(sheet ? { lineLayout: 'SHEET', sheet: sheet as object } : {}),
        seller: doc.seller as object, orderRef: doc.orderRef as object,
        manifest: doc.manifest as object[], reconciliation: doc.reconciliation as object[],
        warnings: doc.warnings,
        preparedById: user.id,
        orders: { create: orderRows(parts, doc) },
        lines: {
          create: doc.lines.map((l, i) => ({
            kind: l.kind, description: l.description, size: l.size,
            quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, position: i,
          })),
        },
      },
      include: INVOICE_INCLUDE,
    }));

  await logOnOrders(parts.map((p) => p.loaded.id), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.create',
    summary: `Built ${body.kind === InvoiceKind.PROFORMA ? 'proforma invoice' : 'invoice'} ${created.number} — ${qty.toLocaleString()} pcs${parts.length > 1 ? ` across PO ${poList(doc.orderRefs)}` : ''}`,
    entityType: 'Invoice', entityId: created.id,
  });

  res.status(201).json({ data: invoiceToDto(created) });
}));

// ── The proforma sheet as Excel ──────────────────────────────────────────────

/**
 * The document as the factory's Excel proforma: the `invoice` sheet and one
 * sheet per style, with the same formulas. Built from the stored document,
 * so it says what the screen says.
 */
invoicesRouter.get('/:id/export.xlsx', requirePermission('invoice:read'), asyncHandler(async (req, res) => {
  const loaded = await loadInvoice(req.params.id);
  const inv = invoiceToDto(loaded);
  const orders = await Promise.all(inv.orders.map(async (o) => toBuildOrder(await loadOrderForBuild(o.id))));
  const buffer = await proformaSheetWorkbook(inv, orders);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `${inv.number} ${inv.kind === InvoiceKind.PROFORMA ? 'Proforma' : 'Invoice'}.xlsx`));
  res.send(buffer);
}));

// ── Read one ─────────────────────────────────────────────────────────────────

invoicesRouter.get('/:id', requirePermission('invoice:read'), asyncHandler(async (req, res) => {
  const inv = await loadInvoice(req.params.id);
  res.json({ data: invoiceToDto(inv, await isStale(inv)) });
}));

// ── Edit a draft ─────────────────────────────────────────────────────────────

const lineSchema = z.object({
  kind: z.nativeEnum(InvoiceLineKind).default('ITEM'),
  description: z.string().trim().min(1, 'Every line needs a description.').max(400),
  size: text(120),
  quantity: z.number().min(0).max(1e9).nullable().optional(),
  unitPrice: z.number().min(0).max(1e9).nullable().optional(),
  amount: z.number().min(-1e9).max(1e9).nullable().optional(),
});

/**
 * A document's carton, typed by hand or copied from the order's packing list
 * and then adjusted. Rebuilding an invoice puts its packing list back, when
 * the order has one.
 */
const cartonSchema = z.object({
  cartonNumber: z.string().trim().max(60).default(''),
  cartonSize: text(60),
  product: z.string().trim().max(200).default(''),
  poNumber: z.string().trim().max(60).optional(),
  contents: z.array(z.object({ label: z.string().trim().max(60), qty: z.number().int().min(0).max(1e7) })).max(100).default([]),
  contentsText: text(300),
  pieces: z.number().int().min(0).max(1e7),
  netKg: z.number().min(0).max(1e6).nullable().optional(),
  grossKg: z.number().min(0).max(1e6).nullable().optional(),
});

const sheetNum = (max: number) => z.number().min(0).max(max).nullable().optional();
const sheetDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is written YYYY-MM-DD.').nullable().optional();
/** The factory proforma sheet's typed fields. */
const sheetSchema = z.object({
  title: text(300), statement: text(300), shipmentFrom: text(120), container: text(40),
  cartonsPerContainer: sheetNum(100_000), onBoardDate: sheetDay, etd: sheetDay, leadDays: sheetNum(365),
  portFrom: text(120), portTo: text(120), consolidatingVendor: text(200), cartonSize: text(60),
  exporterName: text(200), exporterAddress: text(400), qizRef: text(60), destination: text(120), signatory: text(120),
  rows: z.record(z.string().max(300), z.object({
    description: text(200), po: text(60), partNo: text(60), hts: text(30),
    gw: sheetNum(1e7), nw: sheetNum(1e7), perCarton: sheetNum(100_000), cartons: sheetNum(1e6), unit: text(20),
  })).refine((r) => Object.keys(r).length <= 600, 'Too many rows on one sheet.').optional(),
});

const editSchema = z.object({
  date: dateInput.optional(),
  dueDate: dateInput.nullable().optional(),
  paymentTerms: text(200),
  billTo: z.string().trim().min(1, 'The bill-to name is needed.').max(300).optional(),
  billToAddress: text(600),
  billToEmail: email,
  // Room for a document over many orders, whose references, notes and cover
  // note list every PO: the editor sends every field back on each save.
  customerReference: text(2000),
  shipmentRef: text(2000),
  shippedOn: dateInput.nullable().optional(),
  coverNote: text(12000),
  terms: text(4000),
  bankDetails: text(2000),
  notes: text(12000),
  lineLayout: z.enum(INVOICE_LINE_LAYOUTS).optional(),
  sheet: sheetSchema.nullable().optional(),
  cartons: z.array(cartonSchema).max(500).optional(),
  /** The version the editor opened, so a save never lands on a newer one. */
  updatedAt: z.string().optional(),
  lines: z.array(lineSchema).max(300).optional(),
});

invoicesRouter.put('/:id', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const body = editSchema.parse(req.body);
  const user = currentUser(req);
  const existing = await loadInvoice(req.params.id);
  assertDraft(existing);
  // Saved over a newer version (a rebuild, or another person's save) would
  // silently put the old lines and cartons back.
  if (body.updatedAt && body.updatedAt !== existing.updatedAt.toISOString()) {
    throw new ConflictError(`${existing.number} changed since you opened it. Reload it, then make your edit again.`);
  }
  if (body.cartons && existing.kind === InvoiceKind.INVOICE && hasPackingList(existing)) {
    throw new ValidationError('This invoice\'s cartons are its packing list. Change them on the order\'s Packing tab and rebuild.');
  }
  const refPo = (r: unknown) => (r as { poNumber?: string } | null)?.poNumber;
  const docPos = new Set([
    ...existing.orders.map((o) => refPo(o.orderRef) ?? o.order.poNumber),
    refPo(existing.orderRef), existing.order?.poNumber,
  ].filter(Boolean));
  for (const c of body.cartons ?? []) {
    if (c.poNumber && !docPos.has(c.poNumber)) throw new ValidationError(`Carton ${c.cartonNumber || '?'} names PO ${c.poNumber}, which is not on this document.`);
  }
  const cartons = body.cartons?.map((c, i) => ({
    ...c, n: i + 1, netKg: c.netKg ?? null, grossKg: c.grossKg ?? null,
    cartonSize: c.cartonSize ?? null, contentsText: c.contentsText ?? null,
    // Pieces follow the size list when there is one, so the two cannot disagree.
    pieces: c.contents.length > 0 ? c.contents.reduce((a, x) => a + x.qty, 0) : c.pieces,
  }));

  const scalar = <T>(v: T | undefined, current: T): T => (v === undefined ? current : v);
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.invoice.updateMany({
      // The version the editor opened, in the write itself: two saves at the
      // same moment cannot both pass a check made before it.
      where: { id: existing.id, status: InvoiceStatus.DRAFT, ...(body.updatedAt ? { updatedAt: new Date(body.updatedAt) } : {}) },
      data: {
        date: body.date ? new Date(body.date) : existing.date,
        dueDate: body.dueDate === undefined ? existing.dueDate : body.dueDate === null ? null : new Date(body.dueDate),
        paymentTerms: scalar(body.paymentTerms, existing.paymentTerms),
        billTo: scalar(body.billTo, existing.billTo),
        billToAddress: scalar(body.billToAddress, existing.billToAddress),
        billToEmail: scalar(body.billToEmail, existing.billToEmail),
        customerReference: scalar(body.customerReference, existing.customerReference),
        shipmentRef: scalar(body.shipmentRef, existing.shipmentRef),
        shippedOn: body.shippedOn === undefined ? existing.shippedOn : body.shippedOn === null ? null : new Date(body.shippedOn),
        coverNote: scalar(body.coverNote, existing.coverNote),
        terms: scalar(body.terms, existing.terms),
        bankDetails: scalar(body.bankDetails, existing.bankDetails),
        notes: scalar(body.notes, existing.notes),
        lineLayout: scalar(body.lineLayout, existing.lineLayout),
        ...(body.sheet !== undefined ? { sheet: body.sheet === null ? Prisma.DbNull : (body.sheet as object) } : {}),
        ...(cartons ? { manifest: cartons as object[] } : {}),
      },
    });
    assertStillDraft(count, existing.number);
    if (body.lines) {
      // Replaced wholesale: the draft is one document, and a half-written set
      // of lines is worse than the previous one.
      await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
      if (body.lines.length > 0) {
        await tx.invoiceLine.createMany({
          data: body.lines.map((l, i) => ({
            invoiceId: existing.id, kind: l.kind, description: l.description, size: l.size ?? null,
            quantity: l.kind === InvoiceLineKind.ITEM ? l.quantity ?? null : null,
            unitPrice: l.kind === InvoiceLineKind.ITEM ? l.unitPrice ?? null : null,
            amount: l.kind === InvoiceLineKind.EXTRA ? l.amount ?? null : null,
            position: i,
          })),
        });
      }
      // Keep each order's share in step with the lines as typed.
      const rows = existing.orders;
      const pos = rows.map((r) => (r.orderRef as { poNumber?: string } | null)?.poNumber ?? r.order.poNumber);
      const shares = qtyPerOrder(body.lines.map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity ?? null })), pos);
      for (const [i, r] of rows.entries()) {
        // By invoice and order, not row id: a rebuild in the meantime replaces the rows.
        await tx.invoiceOrder.updateMany({ where: { invoiceId: existing.id, orderId: r.orderId }, data: { qty: shares[i] ?? 0 } });
      }
    }
    return tx.invoice.findUniqueOrThrow({ where: { id: existing.id }, include: INVOICE_INCLUDE });
  });

  await logOnOrders(partsOf(existing).map((p) => p.orderId), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.update', summary: `Edited draft ${existing.number}`,
    entityType: 'Invoice', entityId: existing.id,
  });

  res.json({ data: invoiceToDto(updated, await isStale(updated)) });
}));

/** Whether any order on the document was built from a packing list. */
const hasPackingList = (inv: { packingListId: string | null; orders: Array<{ packingListId: string | null }> }) =>
  inv.packingListId != null || inv.orders.some((o) => o.packingListId != null);

// ── A document's cartons from the order's packing list ─────────────────────

/**
 * The cartons already packed for this document's orders, as an invoice lists
 * them, to copy in and adjust. Read only: nothing is saved until the draft is.
 */
invoicesRouter.post('/:id/cartons-from-packing', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const existing = await loadInvoice(req.params.id);
  assertDraft(existing);
  // The lists this document names, so an invoice copies its own packing list
  // rather than whichever one would be picked by default.
  const { doc } = await buildFor(InvoiceKind.INVOICE, partsOf(existing));
  if (doc.manifest.length === 0) {
    throw new ValidationError('No cartons have been packed for this order yet. Add them on the order\'s Packing tab, or type them here.');
  }
  res.json({ data: doc.manifest });
}));

// ── Rebuild a draft from the order ───────────────────────────────────────────

/**
 * Read the order again and replace the facts: the goods lines, the manifest,
 * the reconciliation, the letterhead, the order's identity and the warnings.
 * What a person typed is kept: the cover note, the terms, the bill-to block,
 * the dates, the notes, the extra lines, a shipment reference or date the
 * order still cannot supply, and a rate typed on a goods line the order still
 * has no price for.
 */
invoicesRouter.post('/:id/rebuild', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const existing = await loadInvoice(req.params.id);
  assertDraft(existing);

  const { parts, doc } = await buildFor(existing.kind, partsOf(existing));
  const first = parts[0]!;
  const typedRate = carriedRates(
    existing.lines.filter((l) => l.kind === InvoiceLineKind.ITEM && l.unitPrice != null)
      .map((l) => ({ description: l.description, unitPrice: Number(l.unitPrice!.toString()) })),
    parts.map((p) => p.loaded.poNumber),
  );
  const extras = existing.lines.filter((l) => l.kind === InvoiceLineKind.EXTRA);
  const lines = [
    ...doc.lines.map((l) => ({ ...l, unitPrice: l.unitPrice ?? typedRate.get(l.description) ?? null })),
    ...extras.map((l) => ({ kind: l.kind, description: l.description, size: l.size, quantity: null, unitPrice: null, amount: l.amount == null ? null : Number(l.amount.toString()) })),
  ];

  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.invoice.updateMany({
      where: { id: existing.id, status: InvoiceStatus.DRAFT },
      data: {
        orderId: first.loaded.id, shipmentId: first.shipmentId, packingListId: first.packingListId,
        shipmentRef: doc.shipmentRef ?? existing.shipmentRef,
        shippedOn: doc.shippedOn ?? existing.shippedOn,
        notes: existing.notes ?? doc.notes,
        seller: doc.seller as object, orderRef: doc.orderRef as object,
        // An invoice built from a packing list takes its cartons from it, even
        // none; cartons typed by hand (a proforma's, or an invoice's with no
        // packing list) are kept.
        manifest: (existing.kind === InvoiceKind.INVOICE && parts.some((p) => p.packingListId) ? doc.manifest : existing.manifest) as object[], reconciliation: doc.reconciliation as object[],
        warnings: doc.warnings, builtAt: new Date(),
      },
    });
    assertStillDraft(count, existing.number);
    await tx.invoiceOrder.deleteMany({ where: { invoiceId: existing.id } });
    const shares = qtyPerOrder(lines, parts.map((p) => p.loaded.poNumber));
    await tx.invoiceOrder.createMany({ data: orderRows(parts, doc, shares).map((r) => ({ ...r, invoiceId: existing.id })) });
    await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
    if (lines.length > 0) {
      await tx.invoiceLine.createMany({
        data: lines.map((l, i) => ({
          invoiceId: existing.id, kind: l.kind, description: l.description, size: l.size,
          quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, position: i,
        })),
      });
    }
    return tx.invoice.findUniqueOrThrow({ where: { id: existing.id }, include: INVOICE_INCLUDE });
  });

  await logOnOrders(partsOf(existing).map((p) => p.orderId), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.rebuild', summary: `Rebuilt draft ${existing.number} from the order`,
    entityType: 'Invoice', entityId: existing.id,
  });

  res.json({ data: invoiceToDto(updated, false) });
}));

// ── Issue, send, void, delete ────────────────────────────────────────────────

invoicesRouter.post('/:id/issue', requirePermission('invoice:issue'), asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const existing = await loadInvoice(req.params.id);
  assertDraft(existing);
  assertIssuable(invoiceToDto(existing, await isStale(existing)));

  const count = await prisma.$transaction(async (tx) => {
    // One issue at a time, so two people issuing invoices for the same goods
    // cannot both pass the check below.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('invoice-issue'))`;
    if (existing.kind === InvoiceKind.INVOICE) {
      // The same packing list or consignment billed twice is the same goods
      // billed twice. Different lists of one order (a split shipment) are fine.
      for (const p of partsOf(existing).filter((x) => x.packingListId || x.shipmentId)) {
        const twin = await tx.invoice.findFirst({
          where: {
            id: { not: existing.id }, kind: InvoiceKind.INVOICE, status: InvoiceStatus.ISSUED,
            orders: { some: { orderId: p.orderId, OR: [
              ...(p.packingListId ? [{ packingListId: p.packingListId }] : []),
              ...(p.shipmentId ? [{ shipmentId: p.shipmentId }] : []),
            ] } },
          },
          select: { number: true },
        });
        if (twin) {
          throw new ConflictError(`These goods are already invoiced on ${twin.number}. Void that invoice first, or build this one from another packing list.`);
        }
      }
    }
    const { count: n } = await tx.invoice.updateMany({
      where: { id: existing.id, status: InvoiceStatus.DRAFT, updatedAt: existing.updatedAt },
      data: { status: InvoiceStatus.ISSUED, issuedAt: new Date(), issuedById: user.id },
    });
    return n;
  });
  // The updatedAt guard means what was validated is what gets issued: an edit
  // landing between the check and the write bumps updatedAt and this touches nothing.
  assertStillDraft(count, existing.number);
  const updated = await loadInvoice(existing.id);
  const totals = computeInvoiceTotals(updated.lines.map(lineToDto));
  await logOnOrders(partsOf(existing).map((p) => p.orderId), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.issue',
    summary: `Issued ${existing.number} — $${totals.total.toLocaleString('en-US', { minimumFractionDigits: 2 })} for ${totals.totalQty.toLocaleString()} pcs`,
    entityType: 'Invoice', entityId: existing.id,
    meta: { total: totals.total, qty: totals.totalQty },
  });
  res.json({ data: invoiceToDto(updated) });
}));

invoicesRouter.post('/:id/sent', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const existing = await loadInvoice(req.params.id);
  if (existing.status !== InvoiceStatus.ISSUED) {
    throw new ConflictError('Only an issued document can be marked as sent. Issue it first.');
  }
  const { count } = await prisma.invoice.updateMany({
    where: { id: existing.id, status: InvoiceStatus.ISSUED },
    data: { sentAt: existing.sentAt ?? new Date() },
  });
  if (count === 0) throw new ConflictError(`${existing.number} is no longer issued. Reload it.`);
  await logOnOrders(partsOf(existing).map((p) => p.orderId), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.sent', summary: `Marked ${existing.number} as sent to the customer`,
    entityType: 'Invoice', entityId: existing.id,
  });
  res.json({ data: invoiceToDto(await loadInvoice(existing.id)) });
}));

invoicesRouter.post('/:id/void', requirePermission('invoice:issue'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why it is being voided.').max(500) }).parse(req.body ?? {});
  const user = currentUser(req);
  const existing = await loadInvoice(req.params.id);
  if (existing.status === InvoiceStatus.VOID) throw new ConflictError(`${existing.number} is already void.`);
  if (existing.status === InvoiceStatus.DRAFT) {
    throw new ConflictError('A draft is deleted, not voided. Voiding is for an issued document that must keep its number.');
  }
  const { count } = await prisma.invoice.updateMany({
    where: { id: existing.id, status: InvoiceStatus.ISSUED },
    data: { status: InvoiceStatus.VOID, voidedAt: new Date(), voidReason: reason },
  });
  if (count === 0) throw new ConflictError(`${existing.number} is no longer issued. Reload it.`);
  await logOnOrders(partsOf(existing).map((p) => p.orderId), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.void', summary: `Voided ${existing.number}: ${reason}`,
    entityType: 'Invoice', entityId: existing.id,
  });
  res.json({ data: invoiceToDto(await loadInvoice(existing.id)) });
}));

invoicesRouter.delete('/:id', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const existing = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { orders: { select: { orderId: true, packingListId: true, shipmentId: true }, orderBy: { position: 'asc' } } },
  });
  if (!existing) throw new NotFoundError('Invoice');
  assertDraft(existing);
  const { count } = await prisma.invoice.deleteMany({ where: { id: existing.id, status: InvoiceStatus.DRAFT } });
  assertStillDraft(count, existing.number);
  await logOnOrders(partsOf(existing).map((p) => p.orderId), {
    actorId: user.id, actorName: user.name,
    action: 'invoice.delete', summary: `Deleted draft ${existing.number}`,
    entityType: 'Invoice', entityId: existing.id,
  });
  res.status(204).end();
}));
