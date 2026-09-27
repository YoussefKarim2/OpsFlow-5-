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
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { StageKey, StageStatus, STEP_BY_KEY, deriveCostLines, sanitiseOverrides, visibleDerivedLines } from '@opsflow/shared';
import { detectFileKind, FILE_KIND_LABEL } from '../services/import/file-kind.js';
import { extractFromPdf } from '../services/import/pdf-extractor.js';
import { extractTabular } from '../services/import/tabular-extractor.js';
import { buildProformaDraft } from '../services/import/proforma-target.js';
import { decodeUploadName } from '../util/upload-name.js';
import { signedFileUrl } from '../services/file-links.js';

/** Same limits as the order importer; a proforma is not a bigger document. */
const proformaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    file.originalname = decodeUploadName(file.originalname);
    cb(null, true);
  },
});
import { prisma } from '../db.js';
import { requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, BadRequestError, ValidationError, ConflictError } from '../errors.js';
import { storage } from '../services/storage/index.js';
import { logActivity } from '../services/activity-service.js';
import { sanitiseHtml } from '../util/sanitise-html.js';
import { getOrderSteps, setStepStatus, markStepStarted } from '../services/step-service.js';
import { refreshCutOrder } from '../services/cut-order.js';
import { refreshOrderCache } from '../services/order-service.js';
import { applyStockRecordsToLedger, findStockRecordsForCell, orderAxisNames, resolveStockCell } from '../services/stock-sync.js';

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
    file.originalname = decodeUploadName(file.originalname);
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
    // `application/octet-stream` means the browser did not recognise the file,
    // not that the file is wrong — Safari and several Windows configurations
    // send it for perfectly ordinary spreadsheets. Refusing it turned "attach
    // this PO" into "re-save it and try again" for no reason the user could
    // see. The extension is already checked above, and the magic-byte test in
    // `assertContentMatchesName` checks the contents themselves, which is the
    // claim worth verifying.
    const unknownToTheBrowser = file.mimetype === 'application/octet-stream'
      || file.mimetype === '';
    const expected = ALLOWED_UPLOADS[file.mimetype];
    if (!unknownToTheBrowser && (!expected || !expected.includes(ext))) {
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
        // Signed the same way as the attachment list, so the link opens in a
        // browser tab that cannot send the session token.
        downloadUrl: storage.name === 's3'
          ? await storage.url(attachment.storageKey)
          : signedFileUrl(attachment.storageKey, user.id),
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

/**
 * One row of the name-and-number table beside an instruction's prose.
 *
 * Every field is optional except by implication: a printing list often has a
 * name and no number, or a number and no name, and refusing the row would mean
 * refusing the sheet the customer actually sent.
 */
const instructionLineSchema = z.object({
  name: z.string().trim().max(200).optional().nullable(),
  number: z.string().trim().max(50).optional().nullable(),
  sizeLabel: z.string().trim().max(50).optional().nullable(),
  qty: z.number().nonnegative().optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
});

const instructionSchema = z.object({
  title: z.string().trim().min(1, 'Give the instruction a title').max(200),
  body: z.string().trim().min(1, 'An empty instruction helps nobody').max(20_000),
  visibleTo: z.array(z.enum(DEPARTMENTS)).min(1, 'Say which department must read this'),
  position: z.number().int().min(0).optional(),
  /**
   * The structured rows, replaced wholesale when present and left alone when
   * the field is absent. Absent and empty must stay different: a caller editing
   * only the title should not silently wipe a two-hundred-name printing list.
   */
  lines: z.array(instructionLineSchema).optional(),
});

stepsRouter.get('/:id/instructions', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const rows = await prisma.customInstruction.findMany({
    where: { orderId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: {
      _count: { select: { attachments: true } },
      lines: { orderBy: { position: 'asc' } },
    },
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id, title: r.title, body: r.body, visibleTo: r.visibleTo,
      position: r.position, attachmentCount: r._count.attachments,
      lines: r.lines.map((l) => ({
        id: l.id, name: l.name, number: l.number, sizeLabel: l.sizeLabel,
        qty: l.qty == null ? null : Number(l.qty.toString()), note: l.note,
      })),
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
      lines: body.lines?.length
        ? { create: body.lines.map((l, i) => ({ ...l, position: i })) }
        : undefined,
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
      // Absent leaves the table alone; present replaces it. The distinction
      // matters — a caller editing only the title must not wipe a printing list.
      ...(body.lines !== undefined
        ? {
            lines: {
              deleteMany: {},
              create: body.lines.map((l, i) => ({ ...l, position: i })),
            },
          }
        : {}),
    },
    include: { lines: { orderBy: { position: 'asc' } } },
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

  // A colour or size that is not on this order names no cell of the matrix, so
  // the stock could never be subtracted from anything. Refusing it here is the
  // difference between a mistake somebody can see and a number that silently
  // does nothing — which is exactly how recorded stock came to have no effect.
  const cell = await resolveStockCell(orderId, body.colorName, body.sizeName);
  if (!cell) {
    const axes = await orderAxisNames(orderId);
    throw new ValidationError(
      `${body.colorName} / ${body.sizeName} is not a colour and size on this order, `
      + `so its stock cannot come off the cut order. `
      + `Colours: ${axes.colors.join(', ') || 'none yet'}. Sizes: ${axes.sizes.join(', ') || 'none yet'}.`,
    );
  }

  // The row already recorded for this cell, matched the way the ledger
  // matches it — "sky blue / 2yxs" is the same cell as "SKY BLUE / 2YXS", so
  // it replaces that row rather than adding a second one the ledger would sum.
  // Any duplicates left by the old exact-text lookup go at the same time.
  const [existing, ...duplicates] = await findStockRecordsForCell(orderId, cell);
  if (duplicates.length > 0) {
    await prisma.stockRecord.deleteMany({ where: { id: { in: duplicates.map((d) => d.id) } } });
  }
  const row = existing
    ? await prisma.stockRecord.update({ where: { id: existing.id }, data: { ...body, recordedAt: new Date() } })
    : await prisma.stockRecord.create({ data: { orderId, ...body } });

  // The row is what a storeman records; the ledger is what the cut order is
  // calculated from. They are the same fact, so they are written together.
  await applyStockRecordsToLedger(orderId);
  const cutTotal = await refreshCutOrder(orderId);
  await refreshOrderCache(orderId);

  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: 'stock.record',
    summary:
      `Recorded ${body.availableQty} finished pieces in stock for ${body.colorName} / ${body.sizeName}`
      + (cutTotal !== null
        ? ` — cut order now ${cutTotal.toLocaleString()} pieces`
        : ` — they will come off the cut order when it is generated`),
    entityType: 'StockRecord', entityId: row.id,
  });

  res.status(existing ? 200 : 201).json({ data: row, cutQty: cutTotal });
}));

stepsRouter.delete('/:id/stock/:recordId', requirePermission('order:edit'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const existing = await prisma.stockRecord.findFirst({ where: { id: req.params.recordId, orderId } });
  if (!existing) throw new NotFoundError('Stock record');
  await prisma.stockRecord.delete({ where: { id: existing.id } });

  // Removing the row puts those pieces back into the cut order, which is what
  // the confirmation dialog told the user would happen.
  await applyStockRecordsToLedger(orderId);
  await refreshCutOrder(orderId);
  await refreshOrderCache(orderId);

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

/**
 * Read a proforma invoice out of an uploaded document.
 *
 * Extraction is shared with the order importer — the same readers, the same
 * synonym engine, the same `ExtractionResult` — and only the mapping onto
 * proforma fields is specific to this. Nothing is written: the draft comes back
 * for the review screen, and the existing `PUT /proforma` saves it once a person
 * has looked at it. That separation is the point. A proforma is a priced
 * document sent to a customer, and no extraction is confident enough to skip
 * somebody reading it.
 */
stepsRouter.post(
  '/:id/proforma/import',
  requirePermission('order:edit'),
  proformaUpload.single('file'),
  asyncHandler(async (req, res) => {
    await resolveOrderId(req.params.id);
    if (!req.file) throw new BadRequestError('No file was uploaded.');

    // Throws with an explanation for .xls, .ods and anything unreadable.
    const kind = detectFileKind(req.file.buffer, req.file.originalname);
    const extraction = kind === 'pdf'
      ? await extractFromPdf(req.file.buffer)
      : await extractTabular(req.file.buffer, {});

    const draft = buildProformaDraft(extraction);
    res.json({
      draft,
      fileName: req.file.originalname,
      fileKind: FILE_KIND_LABEL[kind],
      sheets: extraction.sheets,
    });
  }),
);

/**
 * The invoice as a workbook.
 *
 * ExcelJS is already a dependency for reading imports, so this needed no new
 * one. It is a laid-out document rather than a dump of rows: the header block
 * reads the way the on-screen invoice does, the line table carries its own
 * totals, and the columns are sized to be printed. An export somebody has to
 * reformat before sending is not an export.
 *
 * Works whether the invoice was imported or typed by hand — it reads what is
 * stored, and has no notion of where that came from.
 */
stepsRouter.get('/:id/proforma/export.xlsx', requirePermission('order:read'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const inv = await prisma.proformaInvoice.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    include: { lines: { orderBy: { position: 'asc' } }, order: { select: { poNumber: true, orderName: true } } },
  });
  if (!inv) throw new NotFoundError('Proforma invoice');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpsFlow';
  const ws = wb.addWorksheet('Proforma Invoice');
  ws.columns = [
    { width: 42 }, { width: 12 }, { width: 10 }, { width: 14 }, { width: 16 },
  ];

  const title = ws.addRow(['PROFORMA INVOICE']);
  title.font = { size: 16, bold: true };
  ws.mergeCells(title.number, 1, title.number, 5);
  ws.addRow([]);

  const header: Array<[string, string | null]> = [
    ['Invoice number', inv.number],
    ['Date', inv.date ? inv.date.toISOString().slice(0, 10) : null],
    ['Order', `PO ${inv.order.poNumber} — ${inv.order.orderName}`],
    ['Consignee', inv.consignee],
    ['Billing address', inv.billingAddress],
    ['Email', inv.email],
    ['Shipping date', inv.shippingDate ? inv.shippingDate.toISOString().slice(0, 10) : null],
    ['Ship from', inv.shipmentFrom],
    ['Ship to', inv.shipmentTo],
    ['Consolidator', inv.consolidatingVendor],
    ['Vessel / voyage', inv.vesselVoyage],
    ['Container / seal', inv.containerSeal],
    ['Terms', inv.terms],
    ['Currency', inv.currency],
  ];
  for (const [k, v] of header) {
    if (v == null || v === '') continue;   // an empty field is noise on a document
    const row = ws.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    ws.mergeCells(row.number, 2, row.number, 5);
  }

  ws.addRow([]);
  const head = ws.addRow(['Description', 'Quantity', 'Unit', 'Unit price', 'Amount']);
  head.font = { bold: true };
  head.eachCell((c) => {
    c.border = { bottom: { style: 'thin' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  });

  // Quantities are Decimal(14,4): metres of fabric are as common as pieces, and
  // a whole-number format showed 12.5 m as 13 beside an amount for 12.5.
  const qtyFormat = '#,##0.####';
  let total = 0;
  let totalQty = 0;
  let priced = 0;
  let unpriced = false;
  for (const l of inv.lines) {
    const qty = l.quantity == null ? null : Number(l.quantity.toString());
    const price = l.unitPrice == null ? null : Number(l.unitPrice.toString());
    const amount = qty != null && price != null ? qty * price : null;
    if (amount != null) { total += amount; priced += 1; } else unpriced = true;
    if (qty != null) totalQty += qty;
    const row = ws.addRow([l.description, qty, l.unit, price, amount]);
    row.getCell(4).numFmt = '#,##0.00';
    row.getCell(5).numFmt = '#,##0.00';
    row.getCell(2).numFmt = qtyFormat;
  }

  // Matches the printed proforma: a total quantity, no total at all when
  // nothing is priced, and a note whenever the total leaves a line out.
  const totalRow = ws.addRow([`Total (${inv.currency})`, totalQty, '', '', priced > 0 ? total : null]);
  totalRow.font = { bold: true };
  totalRow.getCell(2).numFmt = qtyFormat;
  totalRow.getCell(5).numFmt = '#,##0.00';
  for (const c of [1, 2, 3, 4, 5]) totalRow.getCell(c).border = { top: { style: 'thin' } };
  if (unpriced) {
    const note = ws.addRow(['One or more items have no price. The total above covers only the priced items.']);
    note.font = { italic: true };
    ws.mergeCells(note.number, 1, note.number, 5);
  }

  const safe = `PI-${(inv.number ?? inv.order.poNumber).replace(/[^A-Za-z0-9._-]+/g, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  res.end(Buffer.from(await wb.xlsx.writeBuffer()));
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

// ─────────────────────────────────────────────────────────────────────────────
// Actual costing
//
// Derived and manual lines live in one table, told apart by `source`. A save
// recomputes every DERIVED line from the production sections and leaves every
// MANUAL one exactly as it was typed. That split is the whole design: a
// recalculation that erased somebody's correction would make the screen
// untrustworthy, and one that quietly stopped updating would make it wrong.
// ─────────────────────────────────────────────────────────────────────────────

/** What the production sections currently support, as cost lines. */
async function deriveFor(orderId: string) {
  const [bom, external] = await Promise.all([
    prisma.bomItem.findMany({
      where: { orderId },
      select: { id: true, category: true, item: true, requiredQty: true, issuedQty: true, unit: true, unitPriceUsd: true },
    }),
    prisma.externalOperation.findMany({
      where: { orderId },
      select: { operationType: true, qty: true, unitPriceUsd: true },
    }),
  ]);

  return deriveCostLines({
    bom: bom.map((b) => ({
      id: b.id,
      category: b.category,
      item: b.item,
      // The issued quantity is a fact; the required quantity is a plan. An
      // actual costing may report the first and only display the second.
      issuedQty: Number(b.issuedQty.toString()),
      requiredQty: Number(b.requiredQty.toString()),
      unit: b.unit,
      unitPriceUsd: b.unitPriceUsd == null ? null : Number(b.unitPriceUsd.toString()),
    })),
    external: external.map((e) => ({
      operationType: e.operationType,
      qty: e.qty,
      unitPriceUsd: e.unitPriceUsd == null ? null : Number(e.unitPriceUsd.toString()),
    })),
  });
}

stepsRouter.get('/:id/costing', requirePermission('costing:read'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const record = await prisma.costingRecord.findUnique({
    where: { orderId },
    include: { lines: { orderBy: [{ source: 'asc' }, { position: 'asc' }] } },
  });

  res.json({
    data: record && {
      costingDate: record.costingDate?.toISOString() ?? null,
      // Null until somebody enters one, so the sheet can say it is waiting.
      dollarRate: record.dollarRate == null ? null : Number(record.dollarRate.toString()),
      dailyCostEgp: record.dailyCostEgp == null ? null : Number(record.dailyCostEgp.toString()),
      machineCount: record.machineCount,
      machineDaysUsed: record.machineDaysUsed,
      daysInLine: record.daysInLine,
      lineMachineQty: record.lineMachineQty,
      overrides: sanitiseOverrides(record.overrides),
      hiddenCostRefs: record.hiddenCostRefs,
      // Stored since the model was written and never reachable from the API,
      // so the sheet's Sublimation and Embroidery rows had nowhere to read
      // from and nowhere to be typed.
      sublimationCostUsd: record.sublimationCostUsd == null ? null : Number(record.sublimationCostUsd.toString()),
      embroideryCostUsd: record.embroideryCostUsd == null ? null : Number(record.embroideryCostUsd.toString()),
      externalOpCostUsd: record.externalOpCostUsd == null ? null : Number(record.externalOpCostUsd.toString()),
      notes: record.notes,
      lines: record.lines.map((l) => ({
        id: l.id, group: l.group, label: l.label,
        quantity: l.quantity == null ? null : Number(l.quantity.toString()),
        unit: l.unit,
        unitPriceUsd: l.unitPriceUsd == null ? null : Number(l.unitPriceUsd.toString()),
        source: l.source, sourceRef: l.sourceRef, note: l.note,
      })),
    },
    // Offered separately so the screen can show what the production data says
    // even before anybody has saved a costing — and so it builds its rows from
    // the live bill of materials rather than from the snapshot the last save
    // wrote. Rows somebody removed are left out here, as they are everywhere
    // else; rows claimed by an edited copy stay in, because the screen reads
    // the plan beside the edited row from them.
    derived: visibleDerivedLines(await deriveFor(orderId), [], record?.hiddenCostRefs ?? []),
  });
}));

const costLineSchema = z.object({
  group: z.enum(['FABRIC', 'ACCESSORY', 'EXTERNAL', 'LABOUR', 'OTHER']),
  label: z.string().trim().min(1, 'Give the cost a name'),
  quantity: z.number().nonnegative().max(1e12).optional().nullable(),
  unit: z.string().trim().min(1).max(40).default('LOT'),
  unitPriceUsd: z.number().min(-1e12).max(1e12).optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
  /**
   * Set when this row is an edited copy of a derived one. The derived line it
   * names is dropped, so editing a material's consumption on the costing sheet
   * changes that row rather than adding a second one beside it.
   */
  sourceRef: z.string().trim().max(200).optional().nullable(),
});

const costingSchema = z.object({
  /**
   * Optional, and zero is allowed.
   *
   * The screen sends `Number(rate) || 0`, so the very first save — before
   * anyone has typed a rate — arrived as 0 and was refused outright: a
   * coordinator could fill in a whole costing, press Save, and be told about a
   * field they had not reached yet, losing the rest.
   *
   * Nothing downstream is endangered by allowing it. Every conversion goes
   * through `safeDiv`, so an unset rate leaves those cells uncalculated rather
   * than wrong — and the upsert below leaves any rate already stored alone
   * rather than replacing it with the blank.
   */
  dollarRate: z.number().nonnegative().optional(),
  costingDate: z.string().optional().nullable(),
  dailyCostEgp: z.number().nonnegative().max(99_999_999).optional().nullable(),
  machineCount: z.number().int().nonnegative().max(100_000).optional().nullable(),
  machineDaysUsed: z.number().int().nonnegative().max(1_000_000).optional().nullable(),
  daysInLine: z.number().int().nonnegative().max(10_000).optional().nullable(),
  lineMachineQty: z.number().int().nonnegative().max(100_000).optional().nullable(),
  /**
   * Figures typed over the calculated cells. Sent whole — the screen holds the
   * complete set — so removing a key is how an override is cleared.
   *
   * Values are bounded and filtered to the known cells before storage: an
   * unbounded number would overflow the numeric columns it feeds, and an
   * unknown key would sit in the record forever overriding nothing.
   */
  overrides: z.record(z.union([
    z.number().finite().min(-1e12).max(1e12),
    z.string().max(200),
    z.null(),
  ])).optional(),
  sublimationCostUsd: z.number().nonnegative().max(99_999_999).optional().nullable(),
  embroideryCostUsd: z.number().nonnegative().max(99_999_999).optional().nullable(),
  externalOpCostUsd: z.number().nonnegative().max(99_999_999).optional().nullable(),
  notes: z.string().max(20_000).optional().nullable(),
  /**
   * Every row the screen holds that is not being left to the derivation:
   * hand-added costs, and derived rows somebody has edited. Sent whole, so a
   * row dropped from the list is a row deleted.
   */
  manualLines: z.array(costLineSchema).max(500).default([]),
  /** Derived rows removed from the sheet, by source reference. */
  hiddenCostRefs: z.array(z.string().trim().max(200)).max(500).optional(),
});

// Read as well as write. The save replaces the whole record — notes, figures,
// hand-added rows — with what the screen sends, so a caller who could not load
// the costing first would overwrite it with an empty draft.
stepsRouter.put('/:id/costing', requirePermission('costing:read'), requirePermission('costing:write'), asyncHandler(async (req, res) => {
  const orderId = await resolveOrderId(req.params.id);
  const body = costingSchema.parse(req.body);
  const user = currentUser(req);

  // A blank rate must not overwrite a good one: absent means "not answered",
  // not "set it to nothing". Omitted from the update entirely, and left unset
  // on create, so the sheet says it is waiting for one.
  const fields = stripLines(body);
  const { dollarRate, costingDate, overrides, ...rest } =
    fields as typeof fields & { dollarRate?: number };
  const overrideField = overrides === undefined
    ? {}
    : { overrides: sanitiseOverrides(overrides) as Prisma.InputJsonValue };
  const usableRate = typeof dollarRate === 'number' && dollarRate > 0 ? dollarRate : undefined;
  // Present-and-empty clears the date; absent leaves it alone. A field the
  // form did not send must not be wiped by the form not sending it.
  const dateField = costingDate === undefined
    ? {}
    : { costingDate: costingDate ? new Date(costingDate) : null };

  await prisma.costingRecord.upsert({
    where: { orderId },
    create: {
      orderId, ...rest, ...dateField, ...overrideField,
      ...(usableRate === undefined ? {} : { dollarRate: usableRate }),
    },
    update: {
      ...rest, ...dateField, ...overrideField,
      ...(usableRate === undefined ? {} : { dollarRate: usableRate }),
    },
  });

  // A derived row the coordinator has edited or deleted must not come back. An
  // edited one arrives as a manual line carrying the same `sourceRef` and
  // replaces it; a deleted one is named in `hiddenCostRefs`. Either way the
  // underlying bill of materials is untouched — this is the costing sheet's
  // view of it, not a rewrite of it. The matching is `visibleDerivedLines`, the
  // same rule the order detail and the screen apply, so one row's edit reaches
  // that row alone. Hidden references are read back from the record, so a save
  // that did not send them still honours the ones stored.
  const record = await prisma.costingRecord.findUniqueOrThrow({
    where: { orderId }, select: { id: true, hiddenCostRefs: true },
  });
  const derived = visibleDerivedLines(
    await deriveFor(orderId),
    body.manualLines.map((m) => m.sourceRef),
    record.hiddenCostRefs,
  );

  await prisma.$transaction(async (tx) => {
    /**
     * Two saves at once used to leave both sets of rows.
     *
     * The rewrite is delete-then-create, and two transactions interleave
     * happily: both delete, then both create, and the costing ends up with its
     * lines twice over and a total to match. Debounced auto-save makes that
     * likelier, not less — two people on the same costing, or one person on
     * two tabs. Serialised on the order, so the second save waits for the
     * first to finish rather than racing it.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;
    await tx.costLine.deleteMany({ where: { costingId: record.id } });
    await tx.costLine.createMany({
      data: [
        ...derived.map((d, i) => ({
          costingId: record.id, group: d.group as never, label: d.label,
          quantity: d.quantity, unit: d.unit, unitPriceUsd: d.unitPriceUsd,
          source: 'DERIVED' as never, sourceRef: d.sourceRef, position: i,
        })),
        ...body.manualLines.map((m, i) => ({
          costingId: record.id, group: m.group as never, label: m.label,
          quantity: m.quantity ?? null, unit: m.unit,
          unitPriceUsd: m.unitPriceUsd ?? null,
          source: 'MANUAL' as never, sourceRef: m.sourceRef ?? null, note: m.note ?? null,
          position: derived.length + i,
        })),
      ],
    });
  });

  await logActivity({
    orderId, actorId: user.id, actorName: user.name,
    action: 'COSTING_SAVED',
    summary: `saved the actual costing — ${derived.length} derived, ${body.manualLines.length} manual`,
    entityType: 'CostingRecord', entityId: record.id,
  });

  res.json({ ok: true, derived: derived.length, manual: body.manualLines.length });
}));

function stripLines(b: z.infer<typeof costingSchema>) {
  const { manualLines: _ignored, ...rest } = b;
  return rest;
}

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
