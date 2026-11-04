/**
 * Laying & Marking Excel import — a second import target alongside
 * routes/import.ts, scoped to one existing order instead of creating one.
 *
 * Same shape as the whole-order importer: upload → analyse → (remap) →
 * review → commit, the file re-read from storage at every step rather than
 * trusting client state, one ImportJob row as both the wizard's state
 * machine and the audit trail.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { normaliseHeader, toSavedMapping, ChangeCategory, NotificationPriority, CONCEPT_META, type ImportConcept } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, BadRequestError } from '../errors.js';
import { workbookUpload as upload, assertLooksLikeWorkbook } from '../services/import/upload-guard.js';
import { detectFileKind } from '../services/import/file-kind.js';
import { extractLayingMarking, type LayingExtractionResult, type LayingRow } from '../services/import/laying-extractor.js';
import { commitLayingImport, resolveLayingRows, type RowResolution } from '../services/import/laying-committer.js';
import { announceChange } from '../services/change-service.js';
import { storage } from '../services/storage/index.js';
import { refreshOrderCache } from '../services/order-service.js';
import { logActivity } from '../services/activity-service.js';

export const layingImportRouter = Router({ mergeParams: true });
layingImportRouter.use(authenticate);

function headerFingerprint(headers: readonly string[]): string {
  const normalised = headers.map(normaliseHeader).filter(Boolean).sort();
  return createHash('sha1').update(normalised.join('|')).digest('hex').slice(0, 32);
}

async function resolveOrder(orderId: string) {
  const order = await prisma.order.findFirst({ where: { OR: [{ id: orderId }, { poNumber: orderId }] } });
  if (!order) throw new NotFoundError('Order');
  return order;
}

/** One existing Marker this row would collide with, if any, for the review screen's diff. */
interface RowConflict {
  key: string;
  existing: {
    id: string; markerNumber: string | null; fabricName: string; fabricColor: string | null;
    layers: number; markerLengthM: string; totalLengthM: string | null;
  };
}

async function findConflicts(orderId: string, rows: LayingRow[]): Promise<RowConflict[]> {
  if (rows.length === 0) return [];
  const existing = await prisma.marker.findMany({
    where: { orderId },
    select: { id: true, markerNumber: true, fabricName: true, fabricColor: true, layers: true, markerLengthM: true, totalLengthM: true, position: true },
  });
  // The same pairing the commit uses, so a choice made against a key here is
  // applied to the same row and the same existing lay there.
  const conflicts: RowConflict[] = [];
  for (const { key, existing: ref } of resolveLayingRows(rows, existing)) {
    const match = ref ? existing.find((m) => m.id === ref.id) : undefined;
    if (!match) continue;
    conflicts.push({
      key,
      existing: {
        id: match.id, markerNumber: match.markerNumber, fabricName: match.fabricName, fabricColor: match.fabricColor,
        layers: match.layers, markerLengthM: match.markerLengthM.toString(), totalLengthM: match.totalLengthM?.toString() ?? null,
      },
    });
  }
  return conflicts;
}

async function buildResponse(jobId: string, fileName: string, orderId: string, extraction: LayingExtractionResult) {
  const conflicts = await findConflicts(orderId, extraction.rows);
  const priorCommitted = await prisma.importJob.count({
    where: { targetOrderId: orderId, target: 'LAYING_MARKING', status: 'COMMITTED', id: { not: jobId } },
  });
  return {
    jobId, fileName,
    sheetName: extraction.analysis.sheetName,
    candidateSheets: extraction.analysis.candidateSheets,
    columns: extraction.analysis.columns,
    rows: extraction.rows,
    conflicts,
    issues: extraction.issues,
    detectedPoNumbers: extraction.detectedPoNumbers,
    extras: extraction.extras ?? null,
    priorImportExists: priorCommitted > 0,
    /**
     * Always true. No two factories draw a laying sheet the same way, so the
     * reader failing to recognise one is not grounds to refuse the file: the
     * review screen shows what was read, the columns can be assigned by hand,
     * and anything still missing is defaulted rather than fatal.
     */
    canCommit: true,
  };
}

/**
 * How the file is being read: which sheet, the columns assigned by hand, and
 * any saved layout applied at upload. Kept on the job with the preview so the
 * commit — which re-reads the file from storage — reads it exactly the way the
 * approved preview did. Without it the commit re-read the default sheet with
 * the automatic mapping, and a column assigned by hand previewed as 140
 * layers and was stored as 0.
 */
interface ReadOptions {
  sheetName?: string;
  overrides?: Record<number, ImportConcept>;
  savedMapping?: Record<string, ImportConcept>;
}

function readOptionsOf(job: { preview: unknown }): ReadOptions {
  const p = (job.preview ?? {}) as { sheetName?: string; overrides?: Record<string, ImportConcept>; savedMapping?: Record<string, ImportConcept> };
  const overrides: Record<number, ImportConcept> = {};
  for (const [index, concept] of Object.entries(p.overrides ?? {})) overrides[Number(index)] = concept;
  return {
    sheetName: p.sheetName || undefined,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    savedMapping: p.savedMapping,
  };
}

/**
 * The same file already committed into this order. Added on every reading of
 * the job, not only the upload, so remapping a column does not drop it; and
 * it says so when the lay plan that import made has since been removed.
 */
async function addReimportWarning(extraction: LayingExtractionResult, orderId: string, checksum: string | null, jobId: string): Promise<void> {
  if (!checksum) return;
  const before = await prisma.importJob.findFirst({
    where: { targetOrderId: orderId, target: 'LAYING_MARKING', status: 'COMMITTED', checksum, id: { not: jobId } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  if (!before) return;
  const day = before.createdAt.toISOString().slice(0, 10);
  const markers = await prisma.marker.count({ where: { orderId } });
  extraction.issues.unshift({
    level: 'WARNING', field: null, sheet: null, cell: null,
    message: markers > 0
      ? `This exact laying sheet was already imported into this order on ${day}. Importing it again changes nothing unless the lays were edited since — check the plan first.`
      : `This exact laying sheet was already imported into this order on ${day}, but that lay plan has since been removed. Importing it again puts it back.`,
  });
}

async function persistJob(jobId: string, extraction: LayingExtractionResult, read: ReadOptions = {}): Promise<void> {
  const hasErrors = extraction.issues.some((i) => i.level === 'ERROR');
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      status: hasErrors ? 'FAILED' : 'VALIDATED',
      detectedSheets: extraction.analysis.candidateSheets as never,
      mappings: extraction.analysis.columns as never,
      issues: extraction.issues as never,
      preview: {
        rows: extraction.rows, sheetName: extraction.analysis.sheetName,
        overrides: read.overrides ?? {}, savedMapping: read.savedMapping ?? null,
      } as never,
      errorMessage: hasErrors ? 'Validation errors must be resolved before importing.' : null,
    },
  });
}

layingImportRouter.post('/upload', requirePermission('import:laying'), upload.single('file'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const order = await resolveOrder(req.params.orderId!);
  if (!req.file) throw new BadRequestError('No file was uploaded.');
  // A CSV is a legitimate laying sheet; anything else must really be a
  // workbook rather than something wearing the name.
  if (detectFileKind(req.file.buffer, req.file.originalname) !== 'csv') {
    assertLooksLikeWorkbook(req.file.buffer);
  }

  const key = await storage.put(req.file.buffer, {
    fileName: req.file.originalname, mimeType: req.file.mimetype, prefix: 'laying-imports',
  });

  const checksum = createHash('sha256').update(req.file.buffer).digest('hex');
  // The same sheet brought in again: said before it is committed, because a
  // "Replace" re-import is the usual way duplicate records came about.
  const job = await prisma.importJob.create({
    data: {
      fileName: req.file.originalname, storageKey: key, uploadedById: actor.id, status: 'UPLOADED',
      target: 'LAYING_MARKING', targetOrderId: order.id, checksum,
    },
  });

  const extraction = await extractLayingMarking(req.file.buffer);

  // A mapping a coordinator already corrected for this exact header shape —
  // same mechanism as the whole-order importer, same table, scoped by a
  // null clientId since this is per-sheet-shape, not per-customer.
  const fingerprint = headerFingerprint(extraction.analysis.columns.map((c) => c.header));
  const savedMapping = await prisma.savedColumnMapping.findFirst({
    where: { headerFingerprint: fingerprint }, orderBy: { useCount: 'desc' },
  });
  const finalExtraction = savedMapping
    ? await extractLayingMarking(req.file.buffer, { savedMapping: savedMapping.mapping as Record<string, ImportConcept> })
    : extraction;
  if (savedMapping) {
    await prisma.savedColumnMapping.update({
      where: { id: savedMapping.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  await addReimportWarning(finalExtraction, order.id, checksum, job.id);
  await persistJob(job.id, finalExtraction, {
    savedMapping: savedMapping ? savedMapping.mapping as Record<string, ImportConcept> : undefined,
  });
  res.json(await buildResponse(job.id, job.fileName, order.id, finalExtraction));
}));

const remapSchema = z.object({
  sheetName: z.string().optional(),
  columnMapping: z.record(z.string()).optional(),
});

layingImportRouter.post('/:jobId/remap', requirePermission('import:laying'), asyncHandler(async (req, res) => {
  const order = await resolveOrder(req.params.orderId!);
  const input = remapSchema.parse(req.body ?? {});
  const job = await prisma.importJob.findFirst({ where: { id: req.params.jobId, targetOrderId: order.id, target: 'LAYING_MARKING' } });
  if (!job) throw new NotFoundError('Import job');

  const buffer = await storage.get(job.storageKey);
  const previous = readOptionsOf(job);
  // Assignments made earlier carry forward — the wizard sends its whole set,
  // but a client that sends only the column just changed must not undo the
  // rest. A different sheet starts afresh: column 3 there is another column.
  const sheetName = input.sheetName ?? previous.sheetName;
  const sameSheet = sheetName === previous.sheetName;
  const overrides: Record<number, ImportConcept> = sameSheet ? { ...(previous.overrides ?? {}) } : {};
  // Checked as the order importer checks them: an unknown concept was stored,
  // saved as a layout, and later replayed into a reader that dereferenced it.
  for (const [index, concept] of Object.entries(input.columnMapping ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(CONCEPT_META, concept)) {
      throw new BadRequestError(`"${concept}" is not a column type the importer knows. Pick the column's meaning from the list.`);
    }
    if (!/^\d+$/.test(index)) throw new BadRequestError(`"${index}" is not a column number.`);
    overrides[Number(index)] = concept as ImportConcept;
  }

  const read: ReadOptions = { sheetName, overrides, savedMapping: previous.savedMapping };
  const extraction = await extractLayingMarking(buffer, read);
  await addReimportWarning(extraction, order.id, job.checksum, job.id);
  await persistJob(job.id, extraction, { ...read, sheetName: extraction.analysis.sheetName });
  res.json(await buildResponse(job.id, job.fileName, order.id, extraction));
}));

layingImportRouter.post('/:jobId/save-mapping', requirePermission('import:laying'), asyncHandler(async (req, res) => {
  const order = await resolveOrder(req.params.orderId!);
  const job = await prisma.importJob.findFirst({ where: { id: req.params.jobId, targetOrderId: order.id, target: 'LAYING_MARKING' } });
  if (!job) throw new NotFoundError('Import job');

  // The layout as the coordinator left it — their hand assignments included —
  // not the automatic reading of the file, which is what they were correcting.
  const buffer = await storage.get(job.storageKey);
  const extraction = await extractLayingMarking(buffer, readOptionsOf(job));
  const mapping = toSavedMapping(extraction.analysis.columns);
  if (Object.keys(mapping).length === 0) throw new BadRequestError('There is nothing to save — no columns were mapped.');

  const fingerprint = headerFingerprint(extraction.analysis.columns.map((c) => c.header));
  const label = z.object({ label: z.string().trim().min(1).max(120).optional() }).parse(req.body ?? {}).label ?? 'Laying & Marking layout';
  // Not a plain `upsert`: clientId is nullable, and Prisma's compound-unique
  // lookup can't take null for a key field — see the same fix in import.ts.
  const existing = await prisma.savedColumnMapping.findFirst({ where: { clientId: null, headerFingerprint: fingerprint } });
  const savedMapping = existing
    ? await prisma.savedColumnMapping.update({ where: { id: existing.id }, data: { mapping: mapping as never, label } })
    : await prisma.savedColumnMapping.create({
        data: { clientId: null, label, headerFingerprint: fingerprint, mapping: mapping as never, createdById: currentUser(req).id },
      });
  res.json({ id: savedMapping.id });
}));

const commitSchema = z.object({
  resolutions: z.record(z.enum(['KEEP', 'REPLACE', 'ADD_NEW'])).default({}),
  /** Remove the existing lay plan first and import this file as the whole plan. */
  replaceAll: z.boolean().default(false),
});

layingImportRouter.post('/:jobId/commit', requirePermission('import:laying'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const order = await resolveOrder(req.params.orderId!);
  const input = commitSchema.parse(req.body ?? {});

  const job = await prisma.importJob.findFirst({ where: { id: req.params.jobId, targetOrderId: order.id, target: 'LAYING_MARKING' } });
  if (!job) throw new NotFoundError('Import job');
  if (job.status === 'COMMITTED') throw new BadRequestError('This file has already been imported.');

  const buffer = await storage.get(job.storageKey);
  // Read exactly as the approved preview was: same sheet, same hand-assigned
  // columns, same saved layout.
  const extraction = await extractLayingMarking(buffer, readOptionsOf(job));
  // Deliberately no gate on extraction issues — see `canCommit` above.

  try {
    // Marks the job COMMITTED itself, in the same transaction as the lays.
    const result = await commitLayingImport(prisma, {
      jobId: job.id, orderId: order.id, rows: extraction.rows,
      resolutions: input.resolutions as Record<string, RowResolution>,
      actorId: actor.id, actorName: actor.name,
      extras: extraction.extras,
      replaceAll: input.replaceAll,
    });

    const laysAdded = Math.max(0, result.markersCreated - Math.min(result.panelRows, result.markersCreated));

    // The sheet itself, filed against the order so it can be opened later.
    await attachLayingSheet(order.id, job, buffer, actor);

    await refreshOrderCache(order.id);

    await announceChange({
      entityType: 'Order', entityId: order.id, action: 'UPDATE', category: ChangeCategory.PRODUCTION,
      summary: `Laying & Marking imported for PO ${order.poNumber} — ${result.cleared > 0 ? 'previous plan replaced, ' : ''}${laysAdded} lay${laysAdded === 1 ? '' : 's'} added`
        + (result.panelRows > 0 ? `, ${result.panelRows} panel row${result.panelRows === 1 ? '' : 's'} by colour` : ''),
      subject: `PO ${order.poNumber}`, priority: NotificationPriority.NORMAL,
      orderId: order.id, link: `/orders/${order.id}?tab=cutting`,
      fields: [
        { label: 'Lays added', oldValue: null, newValue: String(result.markersCreated) },
        { label: 'Lays replaced', oldValue: null, newValue: String(result.markersUpdated) },
      ],
      actorId: actor.id, actorName: actor.name,
    });

    res.status(201).json(result);
  } catch (err) {
    // Never over a job another request has just committed — losing the race
    // to import the same file is not the file failing.
    await prisma.importJob.updateMany({
      where: { id: job.id, status: { not: 'COMMITTED' } },
      data: { status: 'FAILED', errorMessage: err instanceof Error ? err.message : 'Unknown error' },
    });
    throw err;
  }
}));

/**
 * File the laying sheet against the order it was imported into.
 *
 * The sheet was already being stored so the commit could re-read it, and then
 * left where nothing could reach it — the lay plan appeared, but the document
 * it came from did not, and there was no way to check a row against the
 * original. It is filed as a marker file on Laying & Marker, where it opens
 * with one click for as long as the order exists.
 *
 * The bytes are copied rather than shared with the import job: two rows
 * pointing at one key means removing either deletes the other's file.
 *
 * Never fatal — the lays are already imported by the time this runs, and
 * failing the whole import over a filing step would undo work that succeeded.
 */
async function attachLayingSheet(
  orderId: string, job: { fileName: string; storageKey: string },
  buffer: Buffer, actor: { id: string; name: string },
): Promise<void> {
  try {
    const mimeType = job.fileName.toLowerCase().endsWith('.csv')
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const storageKey = await storage.put(buffer, {
      fileName: job.fileName, mimeType, prefix: `orders/${orderId}`,
    });
    const stage = await prisma.orderStage.findUnique({
      where: { orderId_stageKey: { orderId, stageKey: 'LAYING_FABRIC' } },
      select: { id: true },
    });
    await prisma.attachment.create({
      data: {
        orderId,
        orderStageId: stage?.id ?? null,
        stageKey: 'LAYING_FABRIC',
        fileName: job.fileName,
        documentType: 'MARKER_FILE',
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
      summary: `Filed "${job.fileName}" — the laying sheet this lay plan was read from`,
      entityType: 'Attachment', entityId: orderId,
    });
  } catch (err) {
    console.error('[laying-import] could not file the laying sheet:', err);
  }
}

layingImportRouter.get('/', requirePermission('cutting:read'), asyncHandler(async (req, res) => {
  const order = await resolveOrder(req.params.orderId!);
  const jobs = await prisma.importJob.findMany({
    where: { targetOrderId: order.id, target: 'LAYING_MARKING' },
    orderBy: { createdAt: 'desc' },
    include: { uploadedBy: { select: { name: true, email: true } } },
  });
  res.json({
    data: jobs.map((j) => ({
      id: j.id, fileName: j.fileName, status: j.status,
      createdAt: j.createdAt.toISOString(), committedAt: j.committedAt?.toISOString() ?? null,
      uploadedBy: j.uploadedBy, errorMessage: j.errorMessage,
      rowCount: (j.preview as { rows?: unknown[] } | null)?.rows?.length ?? 0,
    })),
  });
}));
