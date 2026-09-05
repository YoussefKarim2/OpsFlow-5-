/**
 * Laying & Marking import commit.
 *
 * Unlike `committer.ts` this never creates an order — it writes into one that
 * already exists, so the questions are different: does this row belong to
 * the order that's open, does it collide with a lay that's already there,
 * and if so what does the coordinator want to do about it.
 *
 * Same non-transactional shape as `commitImport`: validate everything before
 * the first write, then write sequentially. `suppressChangeEvents()` first,
 * for the same reason — one file is one piece of news, not one per row.
 */

import type { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError } from '../../errors.js';
import { suppressChangeEvents } from '../../request-context.js';
import { logActivity } from '../../services/activity-service.js';
import type { LayingRow } from './laying-extractor.js';

export type RowResolution = 'KEEP' | 'REPLACE' | 'ADD_NEW';

export interface CommitLayingImportInput {
  jobId: string;
  orderId: string;
  rows: LayingRow[];
  /** Keyed by the same row key `previewLayingConflicts` reports — markerNumber, or `row:<n>`. */
  resolutions: Record<string, RowResolution>;
  actorId: string;
  actorName: string;
}

export interface CommitLayingImportResult {
  markersCreated: number;
  markersUpdated: number;
  markersSkipped: number;
  cuttingRecordsCreated: number;
  fabricRecordsCreated: number;
}

/** The same key a conflict is reported under in the preview step — see laying-import.ts. */
export function layingRowKey(row: Pick<LayingRow, 'markerNumber' | 'rowNumber'>): string {
  return row.markerNumber ? `marker:${row.markerNumber}` : `row:${row.rowNumber}`;
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

  const existingMarkers = await prisma.marker.findMany({
    where: { orderId: order.id },
    select: { id: true, markerNumber: true, position: true },
  });
  const byMarkerNumber = new Map(existingMarkers.filter((m) => m.markerNumber).map((m) => [m.markerNumber, m]));
  const byPosition = new Map(existingMarkers.map((m) => [m.position, m]));
  let nextPosition = existingMarkers.length > 0 ? Math.max(...existingMarkers.map((m) => m.position)) + 1 : 0;

  let markersCreated = 0, markersUpdated = 0, markersSkipped = 0;
  let cuttingRecordsCreated = 0, fabricRecordsCreated = 0;

  for (const row of input.rows) {
    const key = layingRowKey(row);
    const existing = row.markerNumber ? byMarkerNumber.get(row.markerNumber) : byPosition.get(row.rowNumber - 1);

    const markerData = {
      markerNumber: row.markerNumber,
      fabricName: row.fabricName ?? 'Unspecified',
      fabricColor: row.fabricColor,
      panel: row.panel ?? 'ALL',
      sizeRatio: row.sizeRatio ?? '',
      layers: row.layers ?? 0,
      markerLengthM: row.markerLengthM ?? 0,
      markerWidthM: row.markerWidthM,
      totalLengthM: row.totalLengthM,
      nestPcs: row.nestPcs,
      efficiencyPct: row.efficiencyPct,
      wastagePct: row.wastagePct,
      importJobId: input.jobId,
    };

    const plan = planMarkerAction(existing, input.resolutions[key]);
    if (plan.kind === 'CREATE') {
      await prisma.marker.create({ data: { ...markerData, orderId: order.id, position: nextPosition++ } });
      markersCreated++;
    } else if (plan.kind === 'UPDATE') {
      await prisma.marker.update({ where: { id: plan.existingId }, data: markerData });
      markersUpdated++;
    } else {
      markersSkipped++;
    }

    // Cutting and fabric rows are additive logs, not a plan to reconcile row
    // by row the way markers are — a re-import naturally adds another
    // recorded observation rather than overwriting the last one. Only
    // written when the row actually carries that data, so a lay-only file
    // does not create empty log rows.
    if (row.cutDate || row.cutByName) {
      await prisma.cuttingRecord.create({
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
      await prisma.fabricRecord.create({
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

  await logActivity({
    orderId: order.id, actorId: input.actorId, actorName: input.actorName,
    action: 'LAYING_MARKING_IMPORTED',
    summary:
      `imported Laying & Marking data — ${markersCreated} lay${markersCreated === 1 ? '' : 's'} added` +
      (markersUpdated > 0 ? `, ${markersUpdated} replaced` : '') +
      (markersSkipped > 0 ? `, ${markersSkipped} kept as-is` : ''),
    entityType: 'ImportJob', entityId: input.jobId,
  });

  return { markersCreated, markersUpdated, markersSkipped, cuttingRecordsCreated, fabricRecordsCreated };
}
