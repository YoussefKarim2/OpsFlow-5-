/**
 * The lay plan's fabric, kept on the bill of materials.
 *
 * Laying & Marking says how many metres of each fabric and colour the cut
 * needs. That is the fabric line of the bill of materials, and it used to be
 * typed in a second time. Every change to the lay plan — an import, the lay
 * editor, a lay added or removed, the plan cleared — now runs this in the same
 * transaction, so the two cannot drift apart.
 *
 * The rules, kept conservative because the bill is also the warehouse's:
 *
 *   - One Fabric line per fabric and colour, matched with case and spacing
 *     ignored. A line already on the bill for that fabric and colour — typed
 *     by hand or from the buy sheet — is taken over rather than duplicated:
 *     its quantity becomes the plan's, everything else on it stays.
 *   - A line with a size breakdown, or in a unit metres cannot convert to,
 *     is left as it is and reported: its quantity is somebody's own sum.
 *   - When a fabric leaves the plan, its line goes with it — unless material
 *     was issued or reserved against it, or somebody gave it a supplier,
 *     price, stock link or purchase order. Then it stays as an ordinary line.
 *   - Yoko lines are the Yoko department's, never touched.
 */

import type { Prisma } from '@prisma/client';
import { layPlanFabric, layFabricKey, convertQty, normaliseUnit, type LayInput } from '@opsflow/shared';

export interface LayPlanBomResult {
  added: number;
  updated: number;
  removed: number;
  /** Lines the plan could not update, in words, for the activity log and the screen. */
  kept: string[];
}

const num = (v: { toString(): string } | null | undefined): number | null => (v == null ? null : Number(v.toString()));
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const isYoko = (item: string) => /^yoko\b/i.test(item.trim());

export async function syncLayPlanFabricToBom(tx: Prisma.TransactionClient, orderId: string): Promise<LayPlanBomResult> {
  const [markers, sheetRecords, lines] = await Promise.all([
    tx.marker.findMany({ where: { orderId }, orderBy: { position: 'asc' } }),
    // The sheet's own FABRIC / COLOR / METER figures, as its import recorded them.
    tx.fabricRecord.findMany({
      where: { orderId, importJobId: { not: null }, requiredM: { not: null } },
      select: { fabricName: true, colorName: true, requiredM: true },
    }),
    tx.bomItem.findMany({
      where: { orderId, category: 'FABRIC' },
      select: {
        id: true, item: true, unit: true, colorText: true, color: { select: { name: true } },
        fromLayPlan: true, requiredQty: true, consumptionPerPiece: true, issuedQty: true,
        materialId: true, supplier: true, unitPriceUsd: true, purchaseOrderRef: true, position_: true,
        _count: {
          select: {
            sizes: true, issues: true,
            reservations: { where: { status: { in: ['ACTIVE', 'PENDING'] } } },
          },
        },
      },
      orderBy: [{ position_: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const lays: LayInput[] = markers.map((m) => ({
    id: m.id, fabric: m.fabricName, color: m.fabricColor ?? '', panel: m.panel, ratio: m.sizeRatio,
    layers: m.layers, markerLengthM: Number(m.markerLengthM.toString()), totalLengthM: num(m.totalLengthM),
  }));
  const wanted = layPlanFabric(lays, sheetRecords.map((r) => ({ fabric: r.fabricName, color: r.colorName, metres: num(r.requiredM) })));

  const result: LayPlanBomResult = { added: 0, updated: 0, removed: 0, kept: [] };
  const candidates = lines.filter((l) => !isYoko(l.item));
  const keyOf = (l: (typeof lines)[number]) => layFabricKey(l.item, l.color?.name ?? l.colorText);
  const claimed = new Set<string>();
  let nextPosition = (await tx.bomItem.aggregate({ where: { orderId }, _max: { position_: true } }))._max.position_ ?? -1;

  for (const f of wanted) {
    const key = layFabricKey(f.fabric, f.color);
    const label = f.color ? `${f.fabric} ${f.color}` : f.fabric;
    const matches = candidates.filter((l) => !claimed.has(l.id) && keyOf(l) === key);
    const line = matches.find((l) => l.fromLayPlan) ?? matches[0];

    if (!line) {
      await tx.bomItem.create({
        data: {
          orderId, category: 'FABRIC', item: f.fabric, colorText: f.color, unit: 'm',
          requiredQty: round(f.metres, 4),
          consumptionPerPiece: f.consumptionPerPiece,
          fromLayPlan: true, position_: ++nextPosition,
        },
      });
      result.added++;
      continue;
    }
    claimed.add(line.id);

    if (line._count.sizes > 0) {
      result.kept.push(`${label}: the line has a size breakdown, so its quantity was left as it is (the lay plan needs ${f.metres} m)`);
      continue;
    }
    // A metre line takes the figures as they are; another length unit
    // (yards) is converted. The per-piece figure is scaled by the same ratio
    // rather than converted on its own: the conversion rounds to four places,
    // which would turn 0.031674 m into 0.0317.
    const inMetres = normaliseUnit(line.unit) === normaliseUnit('m');
    const qty = inMetres ? f.metres : convertQty(f.metres, 'm', line.unit);
    if (qty == null) {
      result.kept.push(`${label}: the line is in ${line.unit}, which metres cannot convert to (the lay plan needs ${f.metres} m)`);
      continue;
    }
    const perPiece = f.consumptionPerPiece == null || !(f.metres > 0) ? null : f.consumptionPerPiece * (qty / f.metres);
    const data = {
      requiredQty: round(qty, 4),
      consumptionPerPiece: perPiece == null ? null : round(perPiece, 6),
      fromLayPlan: true,
    };
    const same = line.fromLayPlan
      && num(line.requiredQty) === data.requiredQty
      && num(line.consumptionPerPiece) === data.consumptionPerPiece;
    if (same) continue;
    await tx.bomItem.update({ where: { id: line.id }, data });
    result.updated++;
  }

  // Fabric the plan no longer uses.
  for (const line of candidates) {
    if (!line.fromLayPlan || claimed.has(line.id)) continue;
    const label = [line.item, line.color?.name ?? line.colorText].filter(Boolean).join(' ');
    const history = line._count.issues > 0 || line._count.reservations > 0 || Number(line.issuedQty.toString()) !== 0;
    const ownDetails = !!(line.materialId || line.supplier || line.unitPriceUsd != null || line.purchaseOrderRef);
    if (!history && !ownDetails) {
      // Deleted only while that is still true: an issue recorded since the
      // read above keeps the line.
      const { count } = await tx.bomItem.deleteMany({
        where: {
          id: line.id, issuedQty: 0, issues: { none: {} },
          reservations: { none: { status: { in: ['ACTIVE', 'PENDING'] } } },
        },
      });
      if (count > 0) { result.removed++; continue; }
    }
    await tx.bomItem.update({ where: { id: line.id }, data: { fromLayPlan: false } });
    result.kept.push(`${label}: no longer in the lay plan, but kept on the bill because ${history ? 'material was issued or reserved against it' : 'it has its own supplier, price or stock link'}`);
  }

  return result;
}

/** The sync's outcome as a clause for an activity summary, or '' when nothing changed. */
export function describeLayPlanBom(r: LayPlanBomResult): string {
  const parts = [
    r.added > 0 ? `${r.added} fabric line${r.added === 1 ? '' : 's'} added to the bill of materials` : null,
    r.updated > 0 ? `${r.updated} fabric line${r.updated === 1 ? '' : 's'} updated` : null,
    r.removed > 0 ? `${r.removed} fabric line${r.removed === 1 ? '' : 's'} removed` : null,
  ].filter(Boolean);
  return parts.join(', ');
}
