import { createHash } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  normaliseHeader, toSavedMapping, ChangeCategory, NotificationPriority,
  toIsoDayOrNull,
  type ImportConcept,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, BadRequestError } from '../errors.js';
import { extractWorkbook, type ExtractionResult } from '../services/import/extractor.js';
import { extractTabular, type TabularAnalysis } from '../services/import/tabular-extractor.js';
import { commitImport } from '../services/import/committer.js';
import { announceChange } from '../services/change-service.js';
import { PROFILES } from '../services/import/profiles.js';
import { storage } from '../services/storage/index.js';
import { getOrderDetail, refreshOrderCache } from '../services/order-service.js';
import { reserveOrderMaterials } from '../services/inventory-service.js';

export const importRouter = Router();
importRouter.use(authenticate);

/** MIME types a browser or Excel actually sends for a workbook. */
const WORKBOOK_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel',
  'application/octet-stream', // some clients send nothing more specific
  'application/zip',          // xlsx *is* a zip; a few clients say so
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // multer's callback is an overload pair: cb(error) to reject, or
    // cb(null, true) to accept. Passing both an error and a flag is invalid.

    // A filename is attacker-controlled: reject any path separator or traversal
    // before it can reach a storage key.
    if (/[/\\]|\.\./.test(file.originalname)) {
      cb(new BadRequestError('That file name is not allowed.'));
      return;
    }
    if (!/\.(xlsx|xlsm)$/i.test(file.originalname)) {
      cb(new BadRequestError('Only .xlsx and .xlsm files can be imported.'));
      return;
    }
    if (!WORKBOOK_MIME_TYPES.has(file.mimetype)) {
      cb(new BadRequestError(`"${file.mimetype}" is not a spreadsheet. Upload an .xlsx or .xlsm file.`));
      return;
    }
    cb(null, true);
  },
});

/**
 * The extension and the declared MIME type are both claims made by the client.
 * The first four bytes are not: every .xlsx and .xlsm is a zip archive, so it
 * begins `PK\x03\x04`. Anything else is something wearing a spreadsheet's name.
 */
function assertLooksLikeWorkbook(buffer: Buffer): void {
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b &&
    buffer[2] === 0x03 && buffer[3] === 0x04;
  if (!isZip) {
    throw new BadRequestError(
      'That file is not a valid .xlsx or .xlsm workbook — its contents do not match its name. ' +
      'If it is an older .xls file, open it in Excel and save it as .xlsx first.',
    );
  }
}

const GENERIC_PROFILE = 'generic-tabular';

/**
 * One extraction, two strategies.
 *
 * A workbook that matches a known profile is read by the profile extractor,
 * exactly as before — that path is untouched. Anything else falls through to
 * the generic tabular reader instead of being rejected, which is the whole
 * point of §3: the system should not depend on one Excel layout.
 *
 * Both return the same `ExtractionResult`, so everything downstream — the
 * preview, the validation, the transactional commit — is shared.
 */
async function runExtraction(
  buffer: Buffer,
  options: {
    forceTabular?: boolean;
    sheetName?: string;
    overrides?: Record<number, ImportConcept>;
    fieldOverrides?: Record<string, string | number | null>;
  } = {},
): Promise<ExtractionResult & { analysis?: TabularAnalysis }> {
  if (!options.forceTabular) {
    const profiled = await extractWorkbook(buffer);
    // A recognised profile wins: it reads the BOM, the lay plan and the costing
    // too, which the generic reader cannot infer from a flat table.
    if (profiled.profileKey) return profiled;
  }

  // Look for a mapping a coordinator has already corrected for this shape.
  const firstPass = await extractTabular(buffer, {
    sheetName: options.sheetName,
    overrides: options.overrides,
    fieldOverrides: options.fieldOverrides,
  });

  const fingerprint = headerFingerprint(firstPass.analysis.columns.map((c) => c.header));
  const saved = await prisma.savedColumnMapping.findFirst({
    where: { headerFingerprint: fingerprint },
    orderBy: { useCount: 'desc' },
  });

  if (!saved) return firstPass;

  await prisma.savedColumnMapping.update({
    where: { id: saved.id },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  const replayed = await extractTabular(buffer, {
    sheetName: options.sheetName,
    savedMapping: saved.mapping as Record<string, ImportConcept>,
    // An explicit correction in this session still beats the saved one.
    overrides: options.overrides,
    fieldOverrides: options.fieldOverrides,
  });
  replayed.issues.unshift({
    level: 'INFO', field: null, sheet: null, cell: null,
    message: `Applied the saved column mapping “${saved.label}”, used ${saved.useCount + 1} time${saved.useCount === 0 ? '' : 's'}.`,
  });
  return replayed;
}

/**
 * A stable key for "a file shaped like this".
 *
 * Sorted, so a customer who reorders their columns still matches; normalised,
 * so capitalisation and punctuation do not create a second entry.
 */
function headerFingerprint(headers: readonly string[]): string {
  const normalised = headers.map(normaliseHeader).filter(Boolean).sort();
  return createHash('sha1').update(normalised.join('|')).digest('hex').slice(0, 32);
}

function buildPreview(extraction: ExtractionResult) {
  const orderMatrix = extraction.matrices.find((m) => m.ledger === 'ORDER');
  return {
    order: Object.fromEntries(
      Object.entries(extraction.fields).map(([k, v]) => [
        k, v instanceof Date ? toIsoDayOrNull(v) : (v as string | number | null),
      ]),
    ),
    colors: orderMatrix?.rows.map((r) => r.color) ?? [],
    sizes: orderMatrix?.sizes ?? [],
    matrixTotal: orderMatrix?.computedTotal ?? 0,
    matrixRows: orderMatrix?.rows ?? [],
    bomLines: extraction.bom.length,
    externalOps: extraction.externalColors.length,
    lays: extraction.lays.length,
  };
}

async function persistJob(jobId: string, result: ExtractionResult & { analysis?: TabularAnalysis }): Promise<void> {
  const hasErrors = result.issues.some((i) => i.level === 'ERROR');
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      status: hasErrors ? 'FAILED' : 'VALIDATED',
      profile: result.profileKey,
      profileConfidence: result.confidence,
      detectedSheets: result.sheets as never,
      mappings: (result.analysis?.columns ?? result.mappings) as never,
      issues: result.issues as never,
      preview: { ...buildPreview(result), analysis: result.analysis ?? null } as never,
      errorMessage: hasErrors ? 'Validation errors must be resolved before importing.' : null,
    },
  });
}

function toResponse(result: ExtractionResult & { analysis?: TabularAnalysis }) {
  return {
    profile: result.profileKey,
    profileConfidence: result.confidence,
    sheets: result.sheets,
    mappings: result.mappings,
    issues: result.issues,
    preview: buildPreview(result),
    /** Present only for the generic path — the mapping screen renders from it. */
    analysis: result.analysis ?? null,
    canCommit: !result.issues.some((i) => i.level === 'ERROR'),
  };
}

importRouter.get('/profiles', requirePermission('import:run'), asyncHandler(async (_req, res) => {
  res.json({
    data: PROFILES.map((p) => ({
      key: p.key, label: p.label, description: p.description,
      sheetCount: p.signature.names.length, fieldCount: p.fields.length,
    })),
  });
}));

/**
 * Steps 1–4: upload, detect, extract, validate — then return a preview.
 * Nothing is written to the order tables. The job row exists so the commit can
 * refer back to the same parsed file without a re-upload.
 */
importRouter.post('/upload', requirePermission('import:run'), upload.single('file'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  if (!req.file) throw new BadRequestError('No file was uploaded.');
  assertLooksLikeWorkbook(req.file.buffer);

  const key = await storage.put(req.file.buffer, {
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    prefix: 'imports',
  });

  const job = await prisma.importJob.create({
    data: { fileName: req.file.originalname, storageKey: key, uploadedById: actor.id, status: 'UPLOADED' },
  });

  const result = await runExtraction(req.file.buffer);
  await persistJob(job.id, result);

  res.json({ jobId: job.id, fileName: job.fileName, ...toResponse(result) });
}));

/**
 * Re-run the analysis with the coordinator's corrections.
 *
 * The file is re-read from storage rather than trusting a client-supplied
 * payload, so what is previewed is always what is in the file plus the mapping
 * that was explicitly chosen — never a body someone could have edited.
 */
const remapSchema = z.object({
  sheetName: z.string().optional(),
  /** Column index → concept, from the mapping screen. */
  columnMapping: z.record(z.string(), z.string()).optional(),
  /** Values typed on the review screen for fields the file does not carry. */
  fieldOverrides: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
});

importRouter.post('/:jobId/remap', requirePermission('import:run'), asyncHandler(async (req, res) => {
  const input = remapSchema.parse(req.body ?? {});
  const job = await prisma.importJob.findUnique({ where: { id: req.params.jobId } });
  if (!job) throw new NotFoundError('Import job');
  if (job.status === 'COMMITTED') {
    throw new BadRequestError(`This file has already been imported as order ${job.createdOrderId}.`);
  }

  const buffer = await storage.get(job.storageKey);
  const overrides: Record<number, ImportConcept> = {};
  for (const [index, concept] of Object.entries(input.columnMapping ?? {})) {
    overrides[Number(index)] = concept as ImportConcept;
  }

  const result = await runExtraction(buffer, {
    forceTabular: job.profile === GENERIC_PROFILE,
    sheetName: input.sheetName,
    overrides,
    fieldOverrides: input.fieldOverrides,
  });

  await persistJob(job.id, result);
  res.json({ jobId: job.id, fileName: job.fileName, ...toResponse(result) });
}));

/**
 * Remember this mapping for next time.
 *
 * Saved against the client, keyed by a fingerprint of the header row, so a
 * customer who sends both an order sheet and a packing sheet gets the right
 * mapping offered for each. This is why the importer stops asking the same
 * question every month.
 */
const saveMappingSchema = z.object({
  clientId: z.string().nullable().optional(),
  label: z.string().trim().min(2).optional(),
});

importRouter.post('/:jobId/save-mapping', requirePermission('import:run'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = saveMappingSchema.parse(req.body ?? {});

  const job = await prisma.importJob.findUnique({ where: { id: req.params.jobId } });
  if (!job) throw new NotFoundError('Import job');

  const buffer = await storage.get(job.storageKey);
  const result = await runExtraction(buffer, { forceTabular: true });
  if (!result.analysis) throw new BadRequestError('This file was read with a fixed profile, so there is no column mapping to save.');

  const mapping = toSavedMapping(result.analysis.columns);
  if (Object.keys(mapping).length === 0) throw new BadRequestError('There is nothing to save — no columns were mapped.');

  const fingerprint = headerFingerprint(result.analysis.columns.map((c) => c.header));
  const label = input.label ?? `${job.fileName} layout`;

  const saved = await prisma.savedColumnMapping.upsert({
    where: { clientId_headerFingerprint: { clientId: input.clientId ?? null, headerFingerprint: fingerprint } },
    create: {
      clientId: input.clientId ?? null,
      label,
      headerFingerprint: fingerprint,
      mapping: mapping as never,
      createdById: actor.id,
    },
    update: { mapping: mapping as never, label },
  });

  res.status(201).json({ id: saved.id, label: saved.label, columns: Object.keys(mapping).length });
}));

importRouter.get('/mappings', requirePermission('import:run'), asyncHandler(async (req, res) => {
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const mappings = await prisma.savedColumnMapping.findMany({
    where: clientId ? { clientId } : {},
    include: { client: { select: { name: true } } },
    orderBy: [{ useCount: 'desc' }, { updatedAt: 'desc' }],
    take: 50,
  });
  res.json({
    data: mappings.map((m) => ({
      id: m.id,
      label: m.label,
      clientId: m.clientId,
      clientName: m.client?.name ?? null,
      columns: Object.keys(m.mapping as Record<string, unknown>).length,
      useCount: m.useCount,
      lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
    })),
  });
}));

importRouter.delete('/mappings/:id', requirePermission('import:run'), asyncHandler(async (req, res) => {
  await prisma.savedColumnMapping.delete({ where: { id: req.params.id } });
  res.status(204).end();
}));

importRouter.get('/:jobId', requirePermission('import:run'), asyncHandler(async (req, res) => {
  const job = await prisma.importJob.findUnique({ where: { id: req.params.jobId } });
  if (!job) throw new NotFoundError('Import job');
  res.json({
    jobId: job.id, fileName: job.fileName, status: job.status,
    profile: job.profile, profileConfidence: job.profileConfidence ? Number(job.profileConfidence.toString()) : 0,
    sheets: job.detectedSheets, mappings: job.mappings, issues: job.issues, preview: job.preview,
    createdOrderId: job.createdOrderId,
    canCommit: job.status === 'VALIDATED',
  });
}));

const commitSchema = z.object({
  generateCutOrder: z.boolean().default(true),
  /** Field overrides applied on top of the extraction, from the mapping screen. */
  overrides: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  /** Column mapping corrections, for a generically-read file. */
  columnMapping: z.record(z.string(), z.string()).optional(),
  sheetName: z.string().optional(),
  /** Reserve stock for the new order's materials as soon as it exists. */
  reserveMaterials: z.boolean().default(false),
});

/** Step 5: commit. One transaction, all or nothing. */
importRouter.post('/:jobId/commit', requirePermission('import:run'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = commitSchema.parse(req.body ?? {});

  const job = await prisma.importJob.findUnique({ where: { id: req.params.jobId } });
  if (!job) throw new NotFoundError('Import job');
  if (job.status === 'COMMITTED') {
    throw new BadRequestError(`This file has already been imported as order ${job.createdOrderId}.`);
  }

  // Re-read the stored file rather than trusting a client-supplied payload —
  // the preview the user approved must be the data that gets written.
  const buffer = await storage.get(job.storageKey);

  const columnOverrides: Record<number, ImportConcept> = {};
  for (const [index, concept] of Object.entries(input.columnMapping ?? {})) {
    columnOverrides[Number(index)] = concept as ImportConcept;
  }

  const extraction = await runExtraction(buffer, {
    forceTabular: job.profile === GENERIC_PROFILE,
    sheetName: input.sheetName,
    overrides: columnOverrides,
    fieldOverrides: input.overrides,
  });

  if (input.overrides) {
    for (const [field, value] of Object.entries(input.overrides)) {
      if (value === null) { extraction.fields[field] = null; continue; }
      const spec = PROFILES.flatMap((p) => p.fields).find((s) => s.field === field);
      extraction.fields[field] =
        spec?.type === 'date' ? new Date(String(value))
        : spec?.type === 'number' || spec?.type === 'percent' ? Number(value)
        : String(value);
    }
    // Overrides can satisfy a previously-failing required field.
    extraction.issues = extraction.issues.filter(
      (i) => !(i.level === 'ERROR' && i.field != null && i.field in input.overrides!),
    );
  }

  try {
    const result = await commitImport(prisma, extraction, {
      actorId: actor.id, actorName: actor.name, generateCutOrder: input.generateCutOrder,
    });

    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: 'COMMITTED', createdOrderId: result.orderId, committedAt: new Date() },
    });

    // §10: reserving on confirmation is what turns a BOM into a stock
    // commitment. Partial by design — securing what exists and reporting the
    // rest is more useful than refusing because one trim is missing.
    let reservation: Awaited<ReturnType<typeof reserveOrderMaterials>> | null = null;
    if (input.reserveMaterials) {
      reservation = await reserveOrderMaterials(actor, result.orderId);
    }

    await refreshOrderCache(result.orderId);

    // One announcement for the whole file. `commitImport` suppressed the
    // per-row events, so this is the only thing the factory hears — which is
    // the right amount of news for "an order arrived".
    await announceChange({
      entityType: 'Order',
      entityId: result.orderId,
      action: 'CREATE',
      category: ChangeCategory.ORDER,
      summary: `Order PO ${result.poNumber} imported from a spreadsheet`,
      subject: `PO ${result.poNumber}`,
      priority: NotificationPriority.NORMAL,
      orderId: result.orderId,
      link: `/orders/${result.orderId}`,
      fields: [
        { label: 'Colours', oldValue: null, newValue: String(result.created.colors) },
        { label: 'Sizes', oldValue: null, newValue: String(result.created.sizes) },
        { label: 'Quantity cells', oldValue: null, newValue: String(result.created.quantityCells) },
        { label: 'BOM lines', oldValue: null, newValue: String(result.created.bomItems) },
      ],
      actorId: actor.id,
      actorName: actor.name,
    });

    res.status(201).json({
      ...result,
      reservation,
      order: await getOrderDetail(result.orderId),
    });
  } catch (err) {
    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', errorMessage: err instanceof Error ? err.message : 'Unknown error' },
    });
    throw err;
  }
}));

importRouter.get('/', requirePermission('import:run'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const jobs = await prisma.importJob.findMany({
    where: { uploadedById: actor.id },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true, fileName: true, status: true, profile: true,
      createdOrderId: true, errorMessage: true, createdAt: true, committedAt: true,
    },
  });
  res.json({ data: jobs });
}));
