import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  normaliseHeader, toSavedMapping, ChangeCategory, NotificationPriority,
  toIsoDayOrNull, CONCEPT_META,
  type ImportConcept,
} from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, BadRequestError } from '../errors.js';
import { extractWorkbook, applyFieldOverrides, type ExtractionResult } from '../services/import/extractor.js';
import { extractTabular, type TabularAnalysis } from '../services/import/tabular-extractor.js';
import { commitImport, mergeMatrixAxes } from '../services/import/committer.js';
import { normalisePoNumber } from '../services/rules.js';
import { announceChange } from '../services/change-service.js';
import { PROFILES } from '../services/import/profiles.js';
import { storage } from '../services/storage/index.js';
import { refreshOrderCache } from '../services/order-service.js';
import { orderDetailFor } from './orders.js';
import { reserveOrderMaterials } from '../services/inventory-service.js';
import { workbookUpload as upload } from '../services/import/upload-guard.js';
import { detectFileKind } from '../services/import/file-kind.js';
import { logActivity } from '../services/activity-service.js';
import { extractFromPdf } from '../services/import/pdf-extractor.js';

export const importRouter = Router();
importRouter.use(authenticate);

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
type ExtractionOptions = {
  forceTabular?: boolean;
  sheetName?: string;
  overrides?: Record<number, ImportConcept>;
  fieldOverrides?: Record<string, string | number | null>;
  /** The import job, which names a PDF's stand-in PO number the same on every read. */
  job?: { id: string; createdAt: Date; fileName?: string };
};

export async function runExtraction(
  buffer: Buffer,
  options: ExtractionOptions = {},
): Promise<ExtractionResult & { analysis?: TabularAnalysis }> {
  const result = await readDocument(buffer, options);
  warnFractionalQuantities(result);
  return result;
}

/**
 * Say so when a quantity in the grid is not a whole number.
 *
 * The commit rounds each cell — a garment is not cut in tenths — and a 0.4
 * became 0, which is no cell at all, without a word on the review screen.
 * A fraction in a quantity column is nearly always a misread (a price, a
 * length) or a typing slip, either of which a person should see first.
 */
export function warnFractionalQuantities(extraction: ExtractionResult): void {
  const m = extraction.matrices.find((x) => x.ledger === 'ORDER');
  if (!m) return;
  const odd = m.rows.flatMap((r) => Object.entries(r.cells)
    .filter(([, q]) => q > 0 && !Number.isInteger(q))
    .map(([size, q]) => `${r.color} / ${size}: ${q} (imported as ${Math.round(q)})`));
  if (odd.length === 0) return;
  extraction.issues.push({
    level: 'WARNING', field: null, sheet: null, cell: null,
    message:
      `${odd.length === 1 ? 'A quantity is' : `${odd.length} quantities are`} not a whole number of pieces — `
      + `${odd.slice(0, 3).join('; ')}${odd.length > 3 ? `; and ${odd.length - 3} more` : ''}. `
      + 'Each is rounded when the order is created, and one that rounds to 0 is left out. Correct them in the grid if that is not right.',
  });
}

/**
 * Say so at the preview when the order's PO number is already in the system.
 *
 * The commit refuses a duplicate, and that was the first anyone heard of it —
 * after the review, the mapping and the corrections were all done. The PO is
 * looked up as the commit will write it, and the existing order is named.
 */
export async function warnIfPoExists(
  extraction: ExtractionResult,
  find: (poNumber: string) => Promise<{ id: string; poNumber: string; clientName: string | null } | null> = findOrderByPo,
): Promise<void> {
  const raw = extraction.fields.poNumber;
  if (raw == null || String(raw).trim() === '') return;
  let poNumber: string;
  try { poNumber = normalisePoNumber(String(raw)); } catch { return; } // the commit explains an unusable one
  const existing = await find(poNumber);
  if (!existing) return;
  extraction.issues.push({
    level: 'WARNING', field: 'poNumber', sheet: null, cell: null,
    message:
      `PO ${existing.poNumber} is already in the system${existing.clientName ? ` (${existing.clientName})` : ''}, `
      + 'so confirming will be refused — an order cannot be created twice under one number. Open the existing '
      + 'order instead; or, if this is a different order, correct the PO number in the file and upload it again.',
  });
}

async function findOrderByPo(poNumber: string) {
  const o = await prisma.order.findUnique({ where: { poNumber }, select: { id: true, poNumber: true, client: { select: { name: true } } } });
  return o ? { id: o.id, poNumber: o.poNumber, clientName: o.client.name } : null;
}

async function readDocument(
  buffer: Buffer,
  options: ExtractionOptions,
): Promise<ExtractionResult & { analysis?: TabularAnalysis }> {
  // A PDF has no sheets and no profile, so neither Excel reader applies. It
  // produces the same ExtractionResult, which is what lets everything after
  // this point — preview, review, commit — stay exactly as it is.
  //
  // The review screen's values are applied on every path, not only the generic
  // one: "Apply changes" on a PDF or a recognised workbook used to change
  // nothing on the preview, while the commit applied them anyway — so what was
  // approved and what was written were not the same order.
  const kind = detectFileKind(buffer);
  if (kind === 'pdf') {
    const pdf = await extractFromPdf(buffer, {
      placeholderPoNumber: options.job ? placeholderPoFor(options.job) : undefined,
    });
    applyFieldOverrides(pdf, options.fieldOverrides);
    return pdf;
  }

  // A CSV has no named sheets and no profile to match, so the anchor-based
  // reader cannot apply — it goes straight to the generic one.
  if (!options.forceTabular && kind !== 'csv') {
    const profiled = await extractWorkbook(buffer);
    // A recognised profile wins: it reads the BOM, the lay plan and the costing
    // too, which the generic reader cannot infer from a flat table.
    if (profiled.profileKey) {
      applyFieldOverrides(profiled, options.fieldOverrides);
      return profiled;
    }
  }

  // Look for a mapping a coordinator has already corrected for this shape.
  const firstPass = await extractTabular(buffer, {
    sheetName: options.sheetName,
    overrides: options.overrides,
    fieldOverrides: options.fieldOverrides,
    fileName: options.job?.fileName,
  });

  const fingerprint = headerFingerprint(firstPass.analysis.columns.map((c) => c.header));
  const saved = await prisma.savedColumnMapping.findFirst({
    where: { headerFingerprint: fingerprint },
    orderBy: { useCount: 'desc' },
  });

  if (!saved) return placeholderIfUnnumbered(firstPass, options.job);

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
    fileName: options.job?.fileName,
  });
  replayed.issues.unshift({
    level: 'INFO', field: null, sheet: null, cell: null,
    message: `Applied the saved column mapping “${saved.label}”, used ${saved.useCount + 1} time${saved.useCount === 0 ? '' : 's'}.`,
  });
  return placeholderIfUnnumbered(replayed, options.job);
}

/**
 * A workbook or CSV that states no PO number gets the same stand-in a PDF
 * does — derived from the job, so the review and the commit name the order
 * alike — and the warning names it. Before this the review showed "—", told
 * the coordinator to type a number the screen no longer takes, and the order
 * arrived under a number nobody had seen.
 */
function placeholderIfUnnumbered<T extends ExtractionResult>(result: T, job?: { id: string; createdAt: Date }): T {
  if (!job || (result.fields.poNumber != null && String(result.fields.poNumber).trim() !== '')) return result;
  const placeholder = placeholderPoFor(job);
  result.fields.poNumber = placeholder;
  const warning = result.issues.find((i) => i.level === 'WARNING' && i.field === 'poNumber');
  const message = `No PO number was found in the file, so the order will be created as "${placeholder}". Rename it on Order Details once the customer's number is known.`;
  if (warning) warning.message = message;
  else result.issues.push({ level: 'WARNING', field: 'poNumber', sheet: null, cell: null, message });
  return result;
}

/**
 * The stand-in PO number for a document that states none.
 *
 * Derived from the job rather than drawn at random, because the preview and
 * the commit each read the file afresh: a random one meant the order was
 * created under a different number from the one on the screen the coordinator
 * approved.
 */
function placeholderPoFor(job: { id: string; createdAt: Date }): string {
  const day = job.createdAt.toISOString().slice(0, 10);
  const tag = createHash('sha1').update(job.id).digest('hex').slice(0, 6).toUpperCase();
  return `IMPORT-${day}-${tag}`;
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

export function buildPreview(extraction: ExtractionResult) {
  const found = extraction.matrices.find((m) => m.ledger === 'ORDER');
  // Shown as the commit will create it: "Navy" and "navy" are one colour there,
  // so they are one row here. The total is the merged rows' own sum, not the
  // reader's figure: when the two differed (a size heading written twice),
  // the preview promised pieces the grid beside it did not have.
  const merged = found ? mergeMatrixAxes(found) : undefined;
  const orderMatrix = found && merged
    ? { ...found, ...merged, computedTotal: merged.rows.reduce((a, r) => a + r.total, 0) }
    : undefined;
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
  // A file the readers could only partly interpret is VALIDATED, not FAILED.
  // Nothing has failed: some of it was read, the rest gets typed in. Marking it
  // FAILED told the coordinator the import was dead when it was one click from
  // finishing. Only an issue the readers raise as an outright ERROR — which the
  // order-import path no longer does for missing data — counts as a failure.
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
    /**
     * Always true, deliberately.
     *
     * Confirming is the user's decision, not the reader's. Every issue the
     * extractors raise is "this could not be found in the document", the review
     * screen shows exactly what was and was not read, and anything missing is
     * editable on the order afterwards. There is no state in which the right
     * answer is to refuse the button and leave a real purchase order stranded.
     */
    canCommit: true,
  };
}

/**
 * MIME type for an imported document, from what the sniffer already decided.
 *
 * `ImportJob` never stored one — it had no need, since the extractor works from
 * the bytes. The attachment does need it: it is what tells the browser to open
 * a PDF in its viewer rather than download it.
 */
export function mimeForImport(buffer: Buffer, fileName: string): string {
  switch (detectFileKind(buffer, fileName)) {
    case 'pdf': return 'application/pdf';
    case 'csv': return 'text/csv';
    default: return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
}

/**
 * File the imported document against the order it just created.
 *
 * The document the order was read from is the single most useful thing to be
 * able to look at later — it is the customer's own paperwork, and the answer to
 * "is that really what they asked for". It was already being stored, to let the
 * commit re-read it, and then left where nothing could ever reach it: the
 * Customer Reference screen showed nothing, and the file existed only as a row
 * in an import log.
 *
 * The bytes are copied rather than shared. Pointing two rows at one key means
 * removing either one deletes the other's file, and an order's documents should
 * not be able to disappear because an import record was tidied up.
 *
 * Never fatal: the order exists by this point, and failing the whole import
 * over a filing step would undo something that genuinely worked.
 */
async function attachImportedDocument(
  orderId: string, job: { fileName: string }, buffer: Buffer, actor: { id: string; name: string },
): Promise<void> {
  try {
    const mimeType = mimeForImport(buffer, job.fileName);
    const storageKey = await storage.put(buffer, {
      fileName: job.fileName, mimeType, prefix: `orders/${orderId}`,
    });
    const stage = await prisma.orderStage.findUnique({
      where: { orderId_stageKey: { orderId, stageKey: 'CUSTOMER_ORDER_REF' } },
      select: { id: true },
    });
    await prisma.attachment.create({
      data: {
        orderId,
        orderStageId: stage?.id ?? null,
        stageKey: 'CUSTOMER_ORDER_REF',
        fileName: job.fileName,
        documentType: 'CUSTOMER_PO',
        mimeType,
        sizeBytes: buffer.byteLength,
        storageKey,
        storageDriver: storage.name,
        checksum: createHash('sha256').update(buffer).digest('hex'),
        uploadedById: actor.id,
      },
    });
    await logActivity({
      orderId, actorId: actor.id, actorName: actor.name,
      action: 'attachment.upload',
      summary: `Filed "${job.fileName}" — the document this order was imported from`,
      entityType: 'Attachment', entityId: orderId,
    });
  } catch (err) {
    console.error('[import] could not file the imported document:', err);
  }
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
  // Accepts a workbook, a CSV or a PDF, and explains anything else.
  detectFileKind(req.file.buffer, req.file.originalname);

  const key = await storage.put(req.file.buffer, {
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    prefix: 'imports',
  });

  const job = await prisma.importJob.create({
    data: { fileName: req.file.originalname, storageKey: key, uploadedById: actor.id, status: 'UPLOADED' },
  });

  const result = await runExtraction(req.file.buffer, { job });
  await warnIfPoExists(result);
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
/**
 * The mapping screen's column → concept choices, checked.
 *
 * They arrive as plain strings, and one that is not a concept reached the
 * reader and failed there as "Cannot read properties of undefined" — a 500
 * for what is a bad request. Refused here by name, on every path, including
 * a recognised workbook whose reader would have ignored it.
 */
export function columnOverridesFrom(mapping: Record<string, string> | undefined): Record<number, ImportConcept> {
  const overrides: Record<number, ImportConcept> = {};
  for (const [index, concept] of Object.entries(mapping ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(CONCEPT_META, concept)) {
      throw new BadRequestError(`"${concept}" is not a column type the importer knows. Pick the column's meaning from the list.`);
    }
    if (!/^\d+$/.test(index)) throw new BadRequestError(`"${index}" is not a column number.`);
    overrides[Number(index)] = concept as ImportConcept;
  }
  return overrides;
}

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

  const overrides = columnOverridesFrom(input.columnMapping);
  const buffer = await storage.get(job.storageKey);

  const result = await runExtraction(buffer, {
    forceTabular: job.profile === GENERIC_PROFILE,
    sheetName: input.sheetName,
    overrides,
    fieldOverrides: input.fieldOverrides,
    job,
  });

  await warnIfPoExists(result);
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

  // Saved from the analysis the job last showed — the one every remap writes
  // back — not from a fresh read. Re-reading the file here, with none of the
  // coordinator's corrections and on the default sheet, saved the automatic
  // guess they had just finished fixing, for whichever sheet happened to rank
  // first, and offered it back to them next month.
  const analysis = (job.preview as { analysis?: TabularAnalysis | null } | null)?.analysis ?? null;
  if (!analysis) throw new BadRequestError('This file was read with a fixed profile, so there is no column mapping to save.');

  const mapping = toSavedMapping(analysis.columns);
  if (Object.keys(mapping).length === 0) throw new BadRequestError('There is nothing to save — no columns were mapped.');

  const fingerprint = headerFingerprint(analysis.columns.map((c) => c.header));
  const label = input.label ?? `${job.fileName} layout`;

  // Not a plain `upsert`: `clientId` is nullable, and Prisma's compound-unique
  // lookup can't take null for a key field — SQL NULL is never equal to NULL,
  // so the generated `where` type requires a non-null clientId there. Two
  // steps instead, which also does the right thing for a mapping that applies
  // to "any customer" (clientId: null).
  const existing = await prisma.savedColumnMapping.findFirst({
    where: { clientId: input.clientId ?? null, headerFingerprint: fingerprint },
  });
  const saved = existing
    ? await prisma.savedColumnMapping.update({
        where: { id: existing.id },
        data: { mapping: mapping as never, label },
      })
    : await prisma.savedColumnMapping.create({
        data: {
          clientId: input.clientId ?? null,
          label,
          headerFingerprint: fingerprint,
          mapping: mapping as never,
          createdById: actor.id,
        },
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
  /**
   * The Main Order grid as the coordinator corrected or entered it on the
   * review screen. Replaces the grid read from the file.
   */
  matrix: z.object({
    sizes: z.array(z.string().trim().min(1).max(40)).max(60),
    rows: z.array(z.object({
      color: z.string().trim().min(1).max(120),
      cells: z.record(z.string(), z.number().int().min(0).max(10_000_000)),
    })).max(500),
  }).optional(),
});

/**
 * The Main Order grid the review screen sent, in place of the one read from
 * the file. Cells under a size that is not a column are ignored.
 */
export function applyReviewedMatrix(
  extraction: ExtractionResult,
  matrix: { sizes: string[]; rows: Array<{ color: string; cells: Record<string, number> }> } | undefined,
): void {
  if (!matrix) return;
  const sizes = matrix.sizes;
  const rows = matrix.rows.map((r) => {
    const cells = Object.fromEntries(Object.entries(r.cells).filter(([s, q]) => sizes.includes(s) && q > 0));
    return { color: r.color, cells, total: Object.values(cells).reduce((a, b) => a + b, 0) };
  });
  const others = extraction.matrices.filter((m) => m.ledger !== 'ORDER');
  extraction.matrices = [
    { ledger: 'ORDER', sizes, rows, sheetTotal: null, computedTotal: rows.reduce((a, r) => a + r.total, 0) },
    ...others,
  ];
}

/**
 * The grid, before it becomes an order: a cell of 20,000,000 pieces or a
 * colour name two hundred characters long is a misread, not an order, and
 * the review screen's own grid refuses both. The file path did not, and a
 * workbook with a stray digit became an order of twenty million pieces.
 */
export const MAX_CELL_PIECES = 1_000_000;
export function refuseUnbelievable(extraction: ExtractionResult): void {
  const m = extraction.matrices.find((x) => x.ledger === 'ORDER');
  if (!m) return;
  for (const size of m.sizes) {
    if (size.length > 40) throw new BadRequestError(`A size read from the file is ${size.length} characters long ("${size.slice(0, 30)}…"). That is not a size — check the file's columns before importing.`);
  }
  for (const row of m.rows) {
    if (row.color.length > 120) throw new BadRequestError(`A colour read from the file is ${row.color.length} characters long ("${row.color.slice(0, 40)}…"). That is not a colour — check the file's columns before importing.`);
    for (const [size, qty] of Object.entries(row.cells)) {
      if (qty > MAX_CELL_PIECES) throw new BadRequestError(`${row.color} / ${size} reads as ${qty.toLocaleString('en-US')} pieces. No order has a million pieces of one size — check the file before importing.`);
    }
  }
}

/** Pieces in the Main Order grid an import is about to create. */
export function orderPieces(extraction: ExtractionResult): number {
  const m = extraction.matrices.find((x) => x.ledger === 'ORDER');
  return m ? m.rows.reduce((a, r) => a + Object.values(r.cells).reduce((b, q) => b + (q > 0 ? q : 0), 0), 0) : 0;
}

/**
 * How long a commit may hold its claim on a job before another attempt may
 * take over. Far longer than the commit's own 30-second transaction, so it only
 * ever frees a job whose server died mid-commit — never one still running.
 */
const COMMIT_CLAIM_MS = 5 * 60_000;

/**
 * Run one of the steps after the order exists, without letting it undo that.
 *
 * Everything after the commit is follow-up — reserving stock, refreshing a
 * cache, announcing it. None of it can make the order not exist, so none of it
 * may mark the job FAILED: that told the coordinator to try again, and trying
 * again created the order a second time.
 */
async function afterCommit<T>(what: string, step: () => Promise<T>): Promise<T | null> {
  try {
    return await step();
  } catch (err) {
    console.error(`[import] the order was created, but ${what} failed:`, err);
    return null;
  }
}

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

  const columnOverrides = columnOverridesFrom(input.columnMapping);

  // The review screen's values are applied inside, by the same reader the
  // preview used — a value that cannot be read is refused here, by name,
  // before anything is claimed or written.
  const extraction = await runExtraction(buffer, {
    forceTabular: job.profile === GENERIC_PROFILE,
    sheetName: input.sheetName,
    overrides: columnOverrides,
    fieldOverrides: input.overrides,
    job,
  });
  applyReviewedMatrix(extraction, input.matrix);

  // An order is never created without its quantities: an empty Main Order
  // leaves the Cut Order, production and costing with nothing to work from.
  // The review screen shows the grid and lets it be filled, so this is where
  // that is enforced for every file type and every client.
  if (orderPieces(extraction) === 0) {
    throw new BadRequestError(
      'No quantities were read from this file. Enter the colours, sizes and pieces in the Main Order grid on the review screen, then confirm again.',
    );
  }
  refuseUnbelievable(extraction);

  // Claim the job before creating anything. The status check above is a read,
  // and two clicks — or two tabs — both pass it; each then created its own
  // order from the same file. A conditional update lets exactly one through.
  // `committedAt` doubles as the claim, since it is only ever set here.
  const claim = await prisma.importJob.updateMany({
    where: {
      id: job.id,
      status: { not: 'COMMITTED' },
      OR: [{ committedAt: null }, { committedAt: { lt: new Date(Date.now() - COMMIT_CLAIM_MS) } }],
    },
    data: { committedAt: new Date() },
  });
  if (claim.count === 0) {
    throw new BadRequestError('This file is already being imported. Refresh in a moment to see the order.');
  }

  let result: Awaited<ReturnType<typeof commitImport>>;
  try {
    result = await commitImport(prisma, extraction, {
      actorId: actor.id, actorName: actor.name, generateCutOrder: input.generateCutOrder,
    });
  } catch (err) {
    // Nothing was written — the commit is one transaction — so the claim is
    // released and the job can be corrected and tried again.
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED', committedAt: null,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      },
    });
    throw err;
  }

  // From here on the order exists. Nothing below may mark the job FAILED.
  await afterCommit('recording the import as done', () => prisma.importJob.update({
    where: { id: job.id },
    data: { status: 'COMMITTED', createdOrderId: result.orderId, committedAt: new Date(), errorMessage: null },
  }));

  // The customer's own paperwork, filed against the order it produced, so it
  // can be opened from Customer Reference for as long as the order exists.
  await attachImportedDocument(result.orderId, job, buffer, actor);

  // §10: reserving on confirmation is what turns a BOM into a stock
  // commitment. Partial by design — securing what exists and reporting the
  // rest is more useful than refusing because one trim is missing.
  const reservation = input.reserveMaterials
    ? await afterCommit('reserving materials', () => reserveOrderMaterials(actor, result.orderId))
    : null;

  await afterCommit('refreshing the order summary', () => refreshOrderCache(result.orderId));

  // One announcement for the whole file. `commitImport` suppressed the
  // per-row events, so this is the only thing the factory hears — which is
  // the right amount of news for "an order arrived".
  await afterCommit('announcing the new order', () => announceChange({
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
  }));

  res.status(201).json({
    ...result,
    reservation,
    // Through the same gate as GET /orders/:id, so the import response does not
    // hand costing to a role that cannot read it anywhere else.
    order: await afterCommit('loading the new order', () => orderDetailFor(req, result.orderId)),
  });
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
