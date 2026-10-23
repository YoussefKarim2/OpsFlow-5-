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
import { InvoiceKind, InvoiceLineKind, InvoiceStatus, computeInvoiceTotals, resolveShippedQty, type InvoiceCandidateDto } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, currentUser, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { dateInput } from '../util/date-input.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../errors.js';
import { logActivity } from '../services/activity-service.js';
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
  lines: z.array(lineSchema).max(300).optional(),
});

invoicesRouter.put('/:id', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const body = editSchema.parse(req.body);
  const user = currentUser(req);
  const existing = await loadInvoice(req.params.id);
  assertDraft(existing);

  const scalar = <T>(v: T | undefined, current: T): T => (v === undefined ? current : v);
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.invoice.updateMany({
      where: { id: existing.id, status: InvoiceStatus.DRAFT },
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
        manifest: doc.manifest as object[], reconciliation: doc.reconciliation as object[],
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

  const { count } = await prisma.invoice.updateMany({
    where: { id: existing.id, status: InvoiceStatus.DRAFT, updatedAt: existing.updatedAt },
    data: { status: InvoiceStatus.ISSUED, issuedAt: new Date(), issuedById: user.id },
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
