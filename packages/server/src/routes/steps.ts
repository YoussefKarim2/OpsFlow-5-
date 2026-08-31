/**
 * The guided order routine, over HTTP.
 *
 * One router for the things a coordinator does step by step: read where the
 * order stands, record a decision about a step, and fill in the four steps that
 * had nowhere to be entered before — the customer's own documents, the special
 * instructions for this order, finished stock, and the proforma invoice.
 *
 * Every write here records a *fact somebody entered*. None of them claims
 * anything happened: uploading the artwork does not mean printing is approved,
 * and recording finished stock does not mean the order is short by less. What
 * those facts add up to is worked out on read, by @opsflow/shared.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { StageKey, StageStatus, STEP_BY_KEY } from '@opsflow/shared';
import { prisma } from '../db.js';
import { requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, BadRequestError, ValidationError, ConflictError } from '../errors.js';
import { storage } from '../services/storage/index.js';
import { logActivity } from '../services/activity-service.js';
import { sanitiseHtml } from '../util/sanitise-html.js';
import { getOrderSteps, setStepStatus, markStepStarted } from '../services/step-service.js';

export const stepsRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve an order by id or PO number, exactly as the rest of the API does. */
async function resolveOrderId(idOrPo: string): Promise<string> {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: idOrPo }, { poNumber: idOrPo }] },
    select: { id: true },
  });
  if (!order) throw new NotFoundError('Order');
  return order.id;
}

function parseStageKey(raw: string): StageKey {
  const key = raw.toUpperCase() as StageKey;
  if (!STEP_BY_KEY[key]) {
    throw new ValidationError(
      `"${raw}" is not one of the eighteen steps in the order routine.`,
    );
  }
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// The step rail
// ─────────────────────────────────────────────────────────────────────────────

stepsRouter.get('/:id/steps', requirePermission('order:read'), asyncHandler(async (req, res) => {
  res.json({ data: await getOrderSteps(req.params.id) });
}));

const statusSchema = z.object({
  // Null is "let the data speak again" — see setStepStatus.
  status: z.enum([
    StageStatus.COMPLETED, StageStatus.WAITING, StageStatus.BLOCKED, StageStatus.NOT_REQUIRED,
  ]).nullable(),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(4000).optional(),
});

stepsRouter.post('/:id/steps/:stageKey/status', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const stageKey = parseStageKey(req.params.stageKey);
  const body = statusSchema.parse(req.body);
  const user = currentUser(req);

  await setStepStatus({
    orderId,
    stageKey,
    status: body.status,
    reason: body.reason ?? null,
    notes: body.notes,
    actorId: user.id,
    actorName: user.name,
  });

  res.json({ data: await getOrderSteps(orderId) });
}));

stepsRouter.post('/:id/steps/:stageKey/start', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  await markStepStarted(orderId, parseStageKey(req.params.stageKey));
  res.json({ data: await getOrderSteps(orderId) });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Customer Reference: attachments
//
// The upload control the README has listed as missing since Phase 1. Step 1 of
// the workbook is a picture of what the customer sent; without an upload it was
// the one step nobody could ever finish.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What may be uploaded. An allowlist, not a blocklist: a blocklist is a list of
 * the dangerous types somebody thought of.
 */
const ALLOWED_UPLOADS: Record<string, readonly string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/msword': ['.doc'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
};

const ALLOWED_EXTENSIONS = new Set(Object.values(ALLOWED_UPLOADS).flat());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // multer's callback is an overload pair: cb(error) rejects, cb(null, true)
    // accepts. Passing both accepts the file regardless of the error.
    if (/[/\\]|\.\./.test(file.originalname)) {
      cb(new BadRequestError('That file name is not allowed.'));
      return;
    }
    const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new BadRequestError(
        `"${ext || 'that file'}" cannot be uploaded. Allowed: ` +
        `${[...ALLOWED_EXTENSIONS].sort().join(', ')}.`,
      ));
      return;
    }
    const expected = ALLOWED_UPLOADS[file.mimetype];
    if (!expected || !expected.includes(ext)) {
      cb(new BadRequestError(
        `The file is named "${ext}" but arrived as "${file.mimetype}". Re-save it and try again.`,
      ));
      return;
    }
    cb(null, true);
  },
});

/**
 * The first bytes of the formats that have a reliable signature.
 *
 * The extension and the MIME type are both claims the client makes. These are
 * not. A `.pdf` that does not begin `%PDF-` is something else wearing the name.
 */
const MAGIC: Array<{ ext: readonly string[]; bytes: readonly number[]; label: string }> = [
  { ext: ['.pdf'], bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  { ext: ['.png'], bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG image' },
  { ext: ['.jpg', '.jpeg'], bytes: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { ext: ['.gif'], bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF image' },
  { ext: ['.xlsx', '.docx'], bytes: [0x50, 0x4b, 0x03, 0x04], label: 'Office document' },
];

function assertContentMatchesName(buffer: Buffer, fileName: string): void {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const rule = MAGIC.find((m) => m.ext.includes(ext));
  if (!rule) return; // .txt, .csv, .doc, .xls have no signature worth checking
  const ok = rule.bytes.every((b, i) => buffer[i] === b);
  if (!ok) {
    throw new BadRequestError(
      `"${fileName}" is not really a ${rule.label} — its contents do not match its name.`,
    );
  }
}

const documentTypes = [
  'CUSTOMER_PO', 'CUSTOMER_REFERENCE', 'ARTWORK', 'TECH_PACK', 'FABRIC_PHOTO',
  'SAMPLE_PHOTO', 'MARKER_FILE', 'BOM', 'EXTERNAL_OP_DOC', 'PACKING_LIST',
  'QUALITY_REPORT', 'INVOICE', 'SHIPPING_DOC', 'PROFORMA_INVOICE', 'OTHER',
] as const;

stepsRouter.post(
  '/:id/attachments',
  requirePermission('order:edit'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const orderId = await resolveOrderId(req.params.id);
    const file = req.file;
    if (!file) throw new BadRequestError('No file was uploaded.');

    assertContentMatchesName(file.buffer, file.originalname);

    const parsed = z.object({
      documentType: z.enum(documentTypes).default('CUSTOMER_REFERENCE'),
      stageKey: z.string().optional(),
    }).parse(req.body ?? {});

    const stageKey = parsed.stageKey ? parseStageKey(parsed.stageKey) : null;
    const user = currentUser(req);

    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    // Re-uploading the same document name and type is a new *version*, not a
    // duplicate row. The workbook had "artwork_final_FINAL_2.pdf" for this.
    const previous = await prisma.attachment.findFirst({
      where: { orderId, fileName: file.originalname, documentType: parsed.documentType },
      orderBy: { version: 'desc' },
      select: { version: true, checksum: true },
    });
    if (previous?.checksum === checksum) {
      throw new ConflictError(
        `"${file.originalname}" is already attached to this order, byte for byte. ` +
        `Nothing has been changed.`,
      );
    }

    const storageKey = await storage.put(file.buffer, {
      fileName: file.originalname,
      mimeType: file.mimetype,
      prefix: `orders/${orderId}`,
    });

    const stage = stageKey
      ? await prisma.orderStage.findUnique({
          where: { orderId_stageKey: { orderId, stageKey } },
          select: { id: true },
        })
      : null;

    const attachment = await prisma.attachment.create({
      data: {
        orderId,
        orderStageId: stage?.id ?? null,
        stageKey,
        fileName: file.originalname,
        documentType: parsed.documentType,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        storageDriver: storage.name,
        version: (previous?.version ?? 0) + 1,
        checksum,
        uploadedById: user.id,
      },
      include: { uploadedBy: { select: { name: true } } },
    });

    await logActivity({
      orderId,
      actorId: user.id,
      actorName: user.name,
      action: 'attachment.upload',
      summary: `Attached "${file.originalname}"${attachment.version > 1 ? ` (version ${attachment.version})` : ''}`,
      entityType: 'Attachment',
      entityId: attachment.id,
      meta: { documentType: parsed.documentType, sizeBytes: file.size },
    });

    res.status(201).json({
      data: {
        id: attachment.id,
        fileName: attachment.fileName,
        documentType: attachment.documentType,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        version: attachment.version,
        stageKey: attachment.stageKey,
        uploadedByName: attachment.uploadedBy.name,
        createdAt: attachment.createdAt.toISOString(),
        downloadUrl: await storage.url(attachment.storageKey),
      },
    });
  }),
);

stepsRouter.delete('/:id/attachments/:attachmentId', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const attachment = await prisma.attachment.findFirst({
    where: { id: req.params.attachmentId, orderId },
  });
  if (!attachment) throw new NotFoundError('Attachment');

  const user = currentUser(req);
  await prisma.attachment.delete({ where: { id: attachment.id } });
  // The row goes first. If the blob delete fails we are left with an orphaned
  // file, which is waste; the other order would leave a row pointing at nothing,
  // which is a broken link on somebody's screen.
  await storage.delete(attachment.storageKey).catch(() => undefined);

  await logActivity({
    orderId,
    actorId: user.id,
    actorName: user.name,
    action: 'attachment.delete',
    summary: `Removed "${attachment.fileName}"`,
    entityType: 'Attachment',
    entityId: attachment.id,
  });

  res.status(204).end();
}));

// ─────────────────────────────────────────────────────────────────────────────
// Step 10 — Custom Instructions
// ─────────────────────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  'COORDINATOR', 'FACTORY_MANAGER', 'PRODUCTION_MANAGER', 'CUTTING_MARKER',
  'WAREHOUSE', 'EXTERNAL_OPS', 'PACKING', 'QUALITY', 'FOLLOW_UP', 'FINANCE', 'ADMIN',
] as const;

const instructionSchema = z.object({
  title: z.string().trim().min(1, 'Give the instruction a title').max(200),
  body: z.string().trim().min(1, 'An empty instruction helps nobody').max(20_000),
  visibleTo: z.array(z.enum(DEPARTMENTS)).min(1, 'Say which department must read this'),
  position: z.number().int().min(0).optional(),
});

stepsRouter.get('/:id/instructions', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const rows = await prisma.customInstruction.findMany({
    where: { orderId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { attachments: true } } },
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id, title: r.title, body: r.body, visibleTo: r.visibleTo,
      position: r.position, attachmentCount: r._count.attachments,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    })),
  });
}));

stepsRouter.post('/:id/instructions', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const body = instructionSchema.parse(req.body);
  const user = currentUser(req);

  const created = await prisma.customInstruction.create({
    data: {
      orderId,
      title: body.title,
      body: sanitiseHtml(body.body),
      visibleTo: body.visibleTo,
      position: body.position ?? (await prisma.customInstruction.count({ where: { orderId } })),
    },
  });

  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: 'instruction.create',
    summary: `Added the instruction "${body.title}" for ${body.visibleTo.join(', ')}`,
    entityType: 'CustomInstruction', entityId: created.id,
  });

  res.status(201).json({ data: created });
}));

stepsRouter.patch('/:id/instructions/:instructionId', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const existing = await prisma.customInstruction.findFirst({
    where: { id: req.params.instructionId, orderId },
  });
  if (!existing) throw new NotFoundError('Instruction');

  const body = instructionSchema.partial().parse(req.body);
  const updated = await prisma.customInstruction.update({
    where: { id: existing.id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: sanitiseHtml(body.body) } : {}),
      ...(body.visibleTo !== undefined ? { visibleTo: body.visibleTo } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
    },
  });
  res.json({ data: updated });
}));

stepsRouter.delete('/:id/instructions/:instructionId', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const existing = await prisma.customInstruction.findFirst({
    where: { id: req.params.instructionId, orderId },
  });
  if (!existing) throw new NotFoundError('Instruction');
  const user = currentUser(req);

  await prisma.customInstruction.delete({ where: { id: existing.id } });
  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: 'instruction.delete',
    summary: `Removed the instruction "${existing.title}"`,
    entityType: 'CustomInstruction', entityId: existing.id,
  });
  res.status(204).end();
}));

// ─────────────────────────────────────────────────────────────────────────────
// Step 14 — Stock (finished goods already in the building)
//
// The workbook's Stock sheet is what reduces the cut order: 1,972 ordered minus
// what is already made is what has to be cut. This is per colour and size, so
// it is entered against the same axes as the order matrix.
// ─────────────────────────────────────────────────────────────────────────────

const stockSchema = z.object({
  colorName: z.string().trim().min(1),
  sizeName: z.string().trim().min(1),
  availableQty: z.number().int().min(0, 'Finished stock cannot be negative'),
  reservedQty: z.number().int().min(0).default(0),
  usedQty: z.number().int().min(0).default(0),
  location: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
}).refine((v) => v.reservedQty + v.usedQty <= v.availableQty + v.usedQty, {
  message: 'More is reserved than exists',
  path: ['reservedQty'],
});

stepsRouter.get('/:id/stock', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const rows = await prisma.stockRecord.findMany({
    where: { orderId },
    orderBy: [{ colorName: 'asc' }, { sizeName: 'asc' }],
  });
  res.json({
    data: rows.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() })),
    // Zero rows and zero stock are different answers. The UI says which.
    recorded: rows.length > 0,
    totalAvailable: rows.reduce((a, r) => a + r.availableQty, 0),
  });
}));

stepsRouter.post('/:id/stock', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const body = stockSchema.parse(req.body);
  const user = currentUser(req);

  const existing = await prisma.stockRecord.findFirst({
    where: { orderId, colorName: body.colorName, sizeName: body.sizeName },
  });

  const row = existing
    ? await prisma.stockRecord.update({ where: { id: existing.id }, data: { ...body, recordedAt: new Date() } })
    : await prisma.stockRecord.create({ data: { orderId, ...body } });

  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: 'stock.record',
    summary:
      `Recorded ${body.availableQty} finished pieces in stock for ${body.colorName} / ${body.sizeName}` +
      ` — the cut order will be reduced by them`,
    entityType: 'StockRecord', entityId: row.id,
  });

  res.status(existing ? 200 : 201).json({ data: row });
}));

stepsRouter.delete('/:id/stock/:recordId', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const existing = await prisma.stockRecord.findFirst({ where: { id: req.params.recordId, orderId } });
  if (!existing) throw new NotFoundError('Stock record');
  await prisma.stockRecord.delete({ where: { id: existing.id } });
  res.status(204).end();
}));

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Proforma Invoice
// ─────────────────────────────────────────────────────────────────────────────

const proformaLineSchema = z.object({
  description: z.string().trim().min(1, 'Every line needs a description').max(400),
  quantity: z.number().min(0).nullable().optional(),
  unit: z.string().trim().max(20).default('PCS'),
  unitPrice: z.number().min(0).nullable().optional(),
});

const proformaSchema = z.object({
  number: z.string().trim().max(60).nullable().optional(),
  date: z.coerce.date().optional(),
  consignee: z.string().trim().max(300).nullable().optional(),
  billingAddress: z.string().trim().max(600).nullable().optional(),
  email: z.string().trim().email('That is not an email address').max(200).nullable().optional(),
  vesselVoyage: z.string().trim().max(200).nullable().optional(),
  containerSeal: z.string().trim().max(200).nullable().optional(),
  shippingDate: z.coerce.date().nullable().optional(),
  shipmentFrom: z.string().trim().max(200).nullable().optional(),
  shipmentTo: z.string().trim().max(200).nullable().optional(),
  consolidatingVendor: z.string().trim().max(200).nullable().optional(),
  currency: z.string().trim().length(3).default('USD'),
  terms: z.string().trim().max(5000).nullable().optional(),
  lines: z.array(proformaLineSchema).max(200).optional(),
});

/** The totals the sheet computes in H15:H31 — derived here, never stored. */
function withTotals(inv: {
  currency: string;
  lines: Array<{ id: string; description: string; quantity: unknown; unit: string; unitPrice: unknown; position: number }>;
} & Record<string, unknown>) {
  const num = (v: unknown) => (v == null ? null : Number(v.toString()));
  const lines = inv.lines.map((l) => {
    const qty = num(l.quantity);
    const price = num(l.unitPrice);
    return {
      id: l.id, description: l.description, unit: l.unit, position: l.position,
      quantity: qty, unitPrice: price,
      // Null, not zero. A line with no price yet has no total — saying "0.00"
      // would put a number on the customer's document that nobody agreed.
      lineTotal: qty != null && price != null ? qty * price : null,
    };
  });
  const priced = lines.filter((l) => l.lineTotal != null);
  return {
    ...inv,
    lines,
    grandTotal: priced.length > 0 ? priced.reduce((a, l) => a + (l.lineTotal ?? 0), 0) : null,
    /** True when at least one line is still missing a quantity or a price. */
    incomplete: lines.some((l) => l.lineTotal == null),
  };
}

stepsRouter.get('/:id/proforma', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const invoice = await prisma.proformaInvoice.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    include: {
      lines: { orderBy: { position: 'asc' } },
      preparedBy: { select: { name: true } },
    },
  });
  res.json({ data: invoice ? withTotals(invoice) : null });
}));

stepsRouter.put('/:id/proforma', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const body = proformaSchema.parse(req.body);
  const user = currentUser(req);

  const existing = await prisma.proformaInvoice.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, sentAt: true },
  });

  if (existing?.sentAt) {
    throw new ConflictError(
      'This proforma invoice has already been sent to the customer. ' +
      'Editing the copy they hold is not possible — create a revision instead.',
    );
  }

  const scalars = {
    number: body.number ?? null,
    ...(body.date ? { date: body.date } : {}),
    consignee: body.consignee ?? null,
    billingAddress: body.billingAddress ?? null,
    email: body.email ?? null,
    vesselVoyage: body.vesselVoyage ?? null,
    containerSeal: body.containerSeal ?? null,
    shippingDate: body.shippingDate ?? null,
    shipmentFrom: body.shipmentFrom ?? null,
    shipmentTo: body.shipmentTo ?? null,
    consolidatingVendor: body.consolidatingVendor ?? null,
    currency: body.currency,
    terms: body.terms ?? null,
  };

  // The lines are replaced wholesale inside a transaction. A proforma is one
  // document; a half-written one is worse than the previous version.
  const invoice = await prisma.$transaction(async (tx) => {
    const inv = existing
      ? await tx.proformaInvoice.update({ where: { id: existing.id }, data: scalars })
      : await tx.proformaInvoice.create({ data: { orderId, preparedById: user.id, ...scalars } });

    if (body.lines) {
      await tx.proformaInvoiceLine.deleteMany({ where: { invoiceId: inv.id } });
      if (body.lines.length > 0) {
        await tx.proformaInvoiceLine.createMany({
          data: body.lines.map((l, i) => ({
            invoiceId: inv.id,
            description: l.description,
            quantity: l.quantity ?? null,
            unit: l.unit,
            unitPrice: l.unitPrice ?? null,
            position: i,
          })),
        });
      }
    }

    return tx.proformaInvoice.findUniqueOrThrow({
      where: { id: inv.id },
      include: { lines: { orderBy: { position: 'asc' } }, preparedBy: { select: { name: true } } },
    });
  });

  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: existing ? 'proforma.update' : 'proforma.create',
    summary: existing
      ? `Updated the proforma invoice${body.number ? ` ${body.number}` : ''}`
      : `Created the proforma invoice${body.number ? ` ${body.number}` : ''}`,
    entityType: 'ProformaInvoice', entityId: invoice.id,
  });

  res.json({ data: withTotals(invoice) });
}));

stepsRouter.post('/:id/proforma/send', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const invoice = await prisma.proformaInvoice.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    include: { lines: true },
  });
  if (!invoice) throw new NotFoundError('Proforma invoice');
  if (invoice.sentAt) throw new ConflictError('This proforma invoice has already been sent.');
  if (invoice.lines.length === 0) {
    throw new ValidationError('A proforma invoice with no lines has nothing to quote. Add at least one line.');
  }

  const user = currentUser(req);
  const updated = await prisma.proformaInvoice.update({
    where: { id: invoice.id },
    data: { sentAt: new Date() },
    include: { lines: { orderBy: { position: 'asc' } }, preparedBy: { select: { name: true } } },
  });

  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: 'proforma.send',
    summary: `Sent the proforma invoice${invoice.number ? ` ${invoice.number}` : ''} to the customer`,
    entityType: 'ProformaInvoice', entityId: invoice.id,
  });

  res.json({ data: withTotals(updated) });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Step 17 — Database
//
// The workbook's own `Data-Base` sheet is the factory's reference lists. In
// OpsFlow those are reference tables every order reads, so this section answers
// the question a coordinator or administrator actually has when they open it:
// where did this order come from, and what is it made of.
//
// Deliberately not "the raw row". No password hashes, no internal foreign keys
// to other people's records, no storage keys. Identifiers you would quote in a
// support conversation, provenance you would use to check the import, and
// counts you would use to see whether something is missing.
// ─────────────────────────────────────────────────────────────────────────────

stepsRouter.get('/:id/provenance', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: req.params.id }, { poNumber: req.params.id }] },
    select: {
      id: true, poNumber: true, orderName: true, season: true,
      createdAt: true, updatedAt: true,
      cachedStatus: true, cachedProgressPct: true, cachedStageKey: true,
      client: { select: { id: true, name: true } },
      coordinator: { select: { id: true, name: true, email: true } },
      _count: {
        select: {
          colors: true, sizes: true, quantities: true, bomItems: true,
          tasks: true, stages: true, attachments: true, productionRecords: true,
          markers: true, externalOperations: true, qualityAudits: true,
          packingLists: true, shipments: true, changeEvents: true,
          materialMovements: true, materialReservations: true,
          customInstructions: true, approvals: true, notes: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('Order');

  // The import that created it, if it came from a spreadsheet at all.
  const importJob = await prisma.importJob.findFirst({
    where: { createdOrderId: order.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, fileName: true, profile: true, profileConfidence: true,
      detectedSheets: true, mappings: true, issues: true,
      createdAt: true, committedAt: true,
      uploadedBy: { select: { name: true, email: true } },
    },
  });

  res.json({
    order: {
      id: order.id,
      poNumber: order.poNumber,
      orderName: order.orderName,
      season: order.season,
      clientId: order.client.id,
      clientName: order.client.name,
      coordinator: order.coordinator,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      // Advisory only — every read path recomputes the truth. Shown here
      // because "the list says 36% and the order says 41%" is a real support
      // question, and the answer is that one of them is a cache.
      cachedStatus: order.cachedStatus,
      cachedProgressPct: order.cachedProgressPct,
      cachedStageKey: order.cachedStageKey,
    },
    counts: order._count,
    source: importJob
      ? {
          importId: importJob.id,
          fileName: importJob.fileName,
          profile: importJob.profile,
          confidence: importJob.profileConfidence == null
            ? null
            : Number(importJob.profileConfidence.toString()),
          importedAt: (importJob.committedAt ?? importJob.createdAt).toISOString(),
          importedBy: importJob.uploadedBy,
          sheets: importJob.detectedSheets,
          // Where every imported field came from: sheet and cell.
          mappings: importJob.mappings,
          issues: importJob.issues,
        }
      : null,
  });
}));
