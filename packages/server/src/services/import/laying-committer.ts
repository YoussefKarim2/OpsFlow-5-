/**
 * Laying & Marking import commit.
 *
 * Unlike `committer.ts` this never creates an order — it writes into one that
 * already exists, so the questions are different: does this row belong to
 * the order that's open, does it collide with a lay that's already there,
 * and if so what does the coordinator want to do about it.
 *
 * Validate everything before the first write, then write every lay and log
 * row in one transaction: a failure part-way used to leave half a lay plan
 * behind, with the job marked failed and nothing saying which half. The job
 * is claimed inside that transaction too, so two people pressing Confirm on
 * the same file cannot both import it. `suppressChangeEvents()` first — one
 * file is one piece of news, not one per row.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import { ValidationError, NotFoundError, ConflictError } from '../../errors.js';
import { suppressChangeEvents } from '../../request-context.js';
import { logActivity } from '../../services/activity-service.js';
import type { LayingRow, LayingExtras } from './laying-extractor.js';

export type RowResolution = 'KEEP' | 'REPLACE' | 'ADD_NEW';

export interface CommitLayingImportInput {
  jobId: string;
  orderId: string;
  rows: LayingRow[];
  /** Keyed by the same row key `previewLayingConflicts` reports — markerNumber, or `row:<n>`. */
  resolutions: Record<string, RowResolution>;
  actorId: string;
  actorName: string;
  /** The factory sheet's sign-off lines, spread notes and fabric summary, when it was one. */
  extras?: LayingExtras;
  /**
   * Remove the order's existing lay plan first, then import every row as new.
   * The coordinator's way of starting again from a fresh sheet, instead of
   * deciding Keep / Replace lay by lay.
   */
  replaceAll?: boolean;
}

export interface ClearedLayPlan { markers: number; cuttingRecords: number; fabricRecords: number }

/**
 * Remove an order's lay plan: every marker, and the cutting and fabric
 * records an import wrote. Records entered by hand (no import job behind
 * them) are kept — a cut quantity somebody typed is a fact, not a plan.
 */
export async function clearLayPlan(tx: Prisma.TransactionClient, orderId: string): Promise<ClearedLayPlan> {
  const markers = await tx.marker.deleteMany({ where: { orderId } });
  const cuttingRecords = await tx.cuttingRecord.deleteMany({ where: { orderId, importJobId: { not: null } } });
  const fabricRecords = await tx.fabricRecord.deleteMany({ where: { orderId, importJobId: { not: null } } });
  return { markers: markers.count, cuttingRecords: cuttingRecords.count, fabricRecords: fabricRecords.count };
}

export interface CommitLayingImportResult {
  markersCreated: number;
  markersUpdated: number;
  markersSkipped: number;
  /** Of the markers created or replaced, how many were the factory sheet's panel rows rather than lays. */
  panelRows: number;
  /** Lays removed first, when the import replaced the whole plan. */
  cleared: number;
  cuttingRecordsCreated: number;
  fabricRecordsCreated: number;
}

/**
 * The same key a conflict is reported under in the preview step — see
 * laying-import.ts.
 *
 * `occurrence` is which appearance of this marker number in the sheet the row
 * is (1 for the first). A sheet may reuse a marker number — the same marker
 * laid twice — and one shared key meant one Keep/Replace choice for both rows,
 * with Replace landing on the same existing lay each time. The first keeps
 * the plain key, so a sheet without repeats reads as it always did.
 */
export function layingRowKey(row: Pick<LayingRow, 'markerNumber' | 'rowNumber'>, occurrence = 1): string {
  if (!row.markerNumber) return `row:${row.rowNumber}`;
  return occurrence > 1 ? `marker:${row.markerNumber}#${occurrence}` : `marker:${row.markerNumber}`;
}

export interface ExistingMarkerRef {
  id: string;
  markerNumber: string | null;
  position: number;
}

/**
 * Pair every imported row with its key and the existing lay it collides with.
 *
 * The one place both the preview and the commit get this from, so the key a
 * coordinator chose Keep or Replace against is the key the commit looks up.
 * A marker number used several times pairs its n-th row in the sheet with the
 * n-th existing lay of that number (in lay order); a row beyond the existing
 * ones collides with nothing and is added. A row with no marker number is
 * matched by position, as before.
 */
export function resolveLayingRows<R extends Pick<LayingRow, 'markerNumber' | 'rowNumber'>>(
  rows: readonly R[],
  existing: readonly ExistingMarkerRef[],
): Array<{ row: R; key: string; existing: ExistingMarkerRef | undefined }> {
  const byMarkerNumber = new Map<string, ExistingMarkerRef[]>();
  for (const m of [...existing].sort((a, b) => a.position - b.position)) {
    if (!m.markerNumber) continue;
    byMarkerNumber.set(m.markerNumber, [...(byMarkerNumber.get(m.markerNumber) ?? []), m]);
  }
  const byPosition = new Map(existing.map((m) => [m.position, m]));
  const seen = new Map<string, number>();

  return rows.map((row) => {
    if (!row.markerNumber) {
      return { row, key: layingRowKey(row), existing: byPosition.get(row.rowNumber - 1) };
    }
    const occurrence = (seen.get(row.markerNumber) ?? 0) + 1;
    seen.set(row.markerNumber, occurrence);
    return {
      row,
      key: layingRowKey(row, occurrence),
      existing: byMarkerNumber.get(row.markerNumber)?.[occurrence - 1],
    };
  });
}

/**
 * A layer count as the Marker table can hold it — a whole number.
 *
 * A sheet can say 139.5 (a half layer noted by hand, or a formula), and the
 * column is an integer; the database used to drop the fraction without a
 * word. It is rounded to the nearest whole layer here, on purpose, and the
 * extractor warns about the row so the review screen says so.
 */
export function wholeLayers(layers: number | null | undefined): number {
  if (layers == null || !Number.isFinite(layers)) return 0;
  return Math.max(0, Math.round(layers));
}

export type MarkerAction =
  | { kind: 'CREATE' }
  | { kind: 'UPDATE'; existingId: string }
  | { kind: 'SKIP'; existingId: string };

/**
 * What to do with one imported row, given what (if anything) it collides
 * with — pulled out of `commitLayingImport` so the Keep/Replace/Add-new rule
 * is a plain function, testable without a database.
 *
 * A missing resolution defaults to SKIP (Keep), never REPLACE: a coordinator
 * who never saw the conflict screen must not have their existing data
 * silently overwritten.
 */
export function planMarkerAction(
  existing: { id: string } | undefined,
  resolution: RowResolution | undefined,
): MarkerAction {
  if (!existing) return { kind: 'CREATE' };
  const r = resolution ?? 'KEEP';
  if (r === 'REPLACE') return { kind: 'UPDATE', existingId: existing.id };
  if (r === 'ADD_NEW') return { kind: 'CREATE' };
  return { kind: 'SKIP', existingId: existing.id };
}

export async function commitLayingImport(
  prisma: PrismaClient,
  input: CommitLayingImportInput,
): Promise<CommitLayingImportResult> {
  suppressChangeEvents();

  const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, poNumber: true } });
  if (!order) throw new NotFoundError('Order');

  // Defence in depth: the review screen already warned about this, but the
  // file is re-read from storage for the commit, so the check runs again
  // against whatever was actually approved.
  const wrongPo = [...new Set(input.rows.map((r) => r.poNumber).filter((p): p is string => !!p))]
    .find((p) => p.replace(/\s+/g, '').toUpperCase() !== order.poNumber.replace(/\s+/g, '').toUpperCase());
  if (wrongPo) {
    throw new ValidationError(
      `This file references PO ${wrongPo}, but the order open here is PO ${order.poNumber}. ` +
      `Check you have the right file before importing.`,
    );
  }

  const counts = await prisma.$transaction(async (tx) => {
    // Claim the job first. Two commits of one file both passed the route's
    // status check when they arrived together; only one of them can flip the
    // status here, and the other stops before writing anything.
    const claimed = await tx.importJob.updateMany({
      where: { id: input.jobId, status: { not: 'COMMITTED' } },
      data: { status: 'COMMITTED', committedAt: new Date(), errorMessage: null },
    });
    if (claimed.count === 0) throw new ConflictError('This file has already been imported.');

    // Starting again: the old plan goes before the new one is written, in the
    // same transaction, so a failure part-way leaves the old plan in place.
    const cleared = input.replaceAll ? (await clearLayPlan(tx, order.id)).markers : 0;

    const existingMarkers = input.replaceAll ? [] : await tx.marker.findMany({
      where: { orderId: order.id },
      select: { id: true, markerNumber: true, position: true },
    });
    let nextPosition = existingMarkers.length > 0 ? Math.max(...existingMarkers.map((m) => m.position)) + 1 : 0;

    let markersCreated = 0, markersUpdated = 0, markersSkipped = 0, panelRows = 0;
    let cuttingRecordsCreated = 0, fabricRecordsCreated = 0;

    for (const { row, key, existing } of resolveLayingRows(input.rows, existingMarkers)) {
      const markerData = {
        markerNumber: row.markerNumber,
        fabricName: row.fabricName ?? 'Unspecified',
        fabricColor: row.fabricColor,
        panel: row.panel ?? 'ALL',
        sizeRatio: row.sizeRatio ?? '',
        layers: wholeLayers(row.layers),
        markerLengthM: row.markerLengthM ?? 0,
        markerWidthM: row.markerWidthM,
        totalLengthM: row.totalLengthM,
        nestPcs: row.nestPcs,
        efficiencyPct: row.efficiencyPct,
        wastagePct: row.wastagePct,
        maxLayer: row.maxLayer,
        importJobId: input.jobId,
      };

      const plan = planMarkerAction(existing, input.resolutions[key]);
      if (plan.kind === 'CREATE') {
        await tx.marker.create({ data: { ...markerData, orderId: order.id, position: nextPosition++ } });
        markersCreated++;
        if (row.kind === 'PANEL') panelRows++;
      } else if (plan.kind === 'UPDATE') {
        await tx.marker.update({ where: { id: plan.existingId }, data: markerData });
        markersUpdated++;
        if (row.kind === 'PANEL') panelRows++;
      } else {
        markersSkipped++;
        // A lay the coordinator chose to keep as it was is not imported at
        // all — its cutting and consumption figures included. Writing them
        // anyway added a second copy of the same observation on every
        // re-import of the same sheet.
        continue;
      }

      // Cutting and fabric rows are additive logs, not a plan to reconcile row
      // by row the way markers are. Only written when the row actually
      // carries that data, so a lay-only file does not create empty log rows.
      if (row.cutDate || row.cutByName) {
        await tx.cuttingRecord.create({
          data: {
            orderId: order.id,
            cutDate: row.cutDate,
            cutByName: row.cutByName,
            importJobId: input.jobId,
          },
        });
        cuttingRecordsCreated++;
      }
      if (row.fabricConsumptionM != null) {
        await tx.fabricRecord.create({
          data: {
            orderId: order.id,
            fabricName: row.fabricName ?? 'Unspecified',
            colorName: row.fabricColor,
            actualConsumptionM: row.fabricConsumptionM,
            importJobId: input.jobId,
          },
        });
        fabricRecordsCreated++;
      }
    }

    // The factory sheet's own sign-off lines and spread notes are one cutting
    // record per sheet, and its FABRIC / COLOR / METER summary one fabric
    // record per fabric. Re-importing the sheet updates the ones its earlier
    // import wrote rather than adding a second set.
    if (input.extras) {
      const x = input.extras;
      const s = x.signatures;
      // The sheet's notes and its fabric date, kept on the cutting record;
      // the date also fills the order's "fabric to external" date when
      // nobody has entered one.
      const notes = [
        x.header.spreadNotes,
        x.header.cutNotes ? `Cut notes: ${x.header.cutNotes}` : null,
        x.header.fabricDateToExternal ? `Fabric date to external: ${x.header.fabricDateToExternal}` : null,
      ].filter((n): n is string => !!n).join('\n') || null;
      if (x.header.fabricDateToExternal) {
        await tx.order.updateMany({
          where: { id: order.id, fabricDeliveryToSupplier: null },
          data: { fabricDeliveryToSupplier: new Date(`${x.header.fabricDateToExternal}T00:00:00.000Z`) },
        });
      }
      if (Object.values(s).some(Boolean) || notes) {
        const data = {
          cutByName: s.cutBy, numberingByName: s.numberingBy, inspectedByName: s.inspectedBy,
          bundledByName: s.bundledBy, approvedByName: s.approvedBy, notes, importJobId: input.jobId,
        };
        const prior = await tx.cuttingRecord.findFirst({
          where: { orderId: order.id, importJobId: { not: null }, actualCutQty: null }, orderBy: { createdAt: 'desc' },
        });
        if (prior) await tx.cuttingRecord.update({ where: { id: prior.id }, data });
        else { await tx.cuttingRecord.create({ data: { ...data, orderId: order.id } }); cuttingRecordsCreated++; }
      }
      for (const f of x.fabricSummary) {
        if (!f.fabric) continue;
        const prior = await tx.fabricRecord.findFirst({
          where: {
            orderId: order.id,
            fabricName: { equals: f.fabric, mode: 'insensitive' },
            ...(f.color ? { colorName: { equals: f.color, mode: 'insensitive' } } : {}),
          },
        });
        // What the sheet's fabric table says was issued, when it says so;
        // a blank leaves whatever the warehouse recorded.
        const data = {
          fabricName: f.fabric, colorName: f.color, requiredM: f.meters, importJobId: input.jobId,
          ...(f.issuedM != null ? { issuedM: f.issuedM } : {}),
          ...(f.issuedTo ? { responsibleName: f.issuedTo } : {}),
        };
        if (prior) await tx.fabricRecord.update({ where: { id: prior.id }, data });
        else { await tx.fabricRecord.create({ data: { ...data, orderId: order.id } }); fabricRecordsCreated++; }
      }
    }

    return { markersCreated, markersUpdated, markersSkipped, panelRows, cleared, cuttingRecordsCreated, fabricRecordsCreated };
  }, { timeout: 60_000 });

  const { markersCreated, markersUpdated, markersSkipped, panelRows, cleared } = counts;
  const laysAdded = Math.max(0, markersCreated - Math.min(panelRows, markersCreated));
  await logActivity({
    orderId: order.id, actorId: input.actorId, actorName: input.actorName,
    action: 'LAYING_MARKING_IMPORTED',
    summary:
      `imported Laying & Marking data — ${cleared > 0 ? `removed the previous plan (${cleared} rows), ` : ''}${laysAdded} lay${laysAdded === 1 ? '' : 's'} added` +
      (panelRows > 0 ? `, ${panelRows} panel row${panelRows === 1 ? '' : 's'} by colour` : '') +
      (markersUpdated > 0 ? `, ${markersUpdated} replaced` : '') +
      (markersSkipped > 0 ? `, ${markersSkipped} kept as-is` : ''),
    entityType: 'ImportJob', entityId: input.jobId,
  });

  return counts;
}
