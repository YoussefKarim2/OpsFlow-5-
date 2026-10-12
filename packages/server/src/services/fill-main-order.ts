/**
 * Filling an empty Main Order from the order's own purchase order.
 *
 * An order can end up with no quantities although its PO is in the system:
 * imported before the reader could handle that layout, or created by hand
 * with the PO attached afterwards. The file is read again with the current
 * importer and, when it yields quantities, the grid and the Cut Order are
 * written — automatically on start-up and when a PO is attached, or on demand
 * from the order's Main Order screen.
 *
 * Never touches an order that already has Main Order quantities, so nothing a
 * person entered can be replaced.
 */

import { prisma } from '../db.js';
import { storage } from './storage/index.js';
import { writeOrderMatrix } from './import/committer.js';
import { writeCutOrder } from './cut-order.js';
import { ORDER_INCLUDE, refreshOrderCache } from './order-service.js';
import { logActivity } from './activity-service.js';

export type FillResult =
  | { filled: true; pieces: number; cut: number; fileName: string; warnings: string[] }
  | { filled: false; reason: 'HAS_QUANTITIES' | 'NO_DOCUMENT' | 'NOTHING_READ'; tried: number };

const PO_TYPES = ['CUSTOMER_PO', 'CUSTOMER_REFERENCE'] as const;
const READABLE = /\.(pdf|xlsx|xlsm|csv)$/i;

async function orderPieces(orderId: string): Promise<number> {
  const agg = await prisma.stageQuantity.aggregate({ where: { orderId, ledger: 'ORDER' }, _sum: { qty: true } });
  return agg._sum.qty ?? 0;
}

/** The documents an order's quantities can come from, best first. */
async function sourcesFor(orderId: string): Promise<Array<{ storageKey: string; fileName: string }>> {
  const jobs = await prisma.importJob.findMany({
    where: { createdOrderId: orderId }, orderBy: { createdAt: 'desc' }, select: { storageKey: true, fileName: true },
  });
  const attachments = await prisma.attachment.findMany({
    where: { orderId, documentType: { in: [...PO_TYPES] } },
    orderBy: { createdAt: 'desc' }, select: { storageKey: true, fileName: true, documentType: true },
  });
  const rank = (t: string) => (t === 'CUSTOMER_PO' ? 0 : 1);
  const all = [...jobs, ...attachments.filter((a) => READABLE.test(a.fileName)).sort((a, b) => rank(a.documentType) - rank(b.documentType))];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.storageKey) ? false : (seen.add(s.storageKey), true)));
}

export async function fillMainOrderFromDocuments(
  orderId: string,
  actor: { id: string | null; name: string },
): Promise<FillResult> {
  if (await orderPieces(orderId) > 0) return { filled: false, reason: 'HAS_QUANTITIES', tried: 0 };
  const sources = await sourcesFor(orderId);
  if (sources.length === 0) return { filled: false, reason: 'NO_DOCUMENT', tried: 0 };

  // Loaded here rather than at the top: the import route imports the orders
  // route, which imports this module.
  const { runExtraction } = await import('../routes/import.js');
  for (const src of sources) {
    let extraction: Awaited<ReturnType<typeof runExtraction>>;
    try {
      extraction = await runExtraction(await storage.get(src.storageKey), {});
    } catch {
      continue; // unreadable or missing; try the next document
    }
    const matrix = extraction.matrices.find((m) => m.ledger === 'ORDER');
    const pieces = matrix ? matrix.rows.reduce((a, r) => a + Object.values(r.cells).reduce((b, q) => b + (q > 0 ? q : 0), 0), 0) : 0;
    if (!matrix || pieces === 0) continue;

    // Checked again inside the write: someone may have typed a grid meanwhile.
    const written = await prisma.$transaction(async (tx) => {
      const agg = await tx.stageQuantity.aggregate({ where: { orderId, ledger: 'ORDER' }, _sum: { qty: true } });
      if ((agg._sum.qty ?? 0) > 0) return 0;
      return writeOrderMatrix(tx, orderId, matrix);
    });
    if (written === 0) return { filled: false, reason: 'HAS_QUANTITIES', tried: 0 };

    const full = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    const { total: cut } = await writeCutOrder(full!);
    await logActivity({
      orderId, actorId: actor.id, actorName: actor.name,
      action: 'QUANTITIES_UPDATED',
      summary: `filled the Main Order from "${src.fileName}": ${written.toLocaleString()} pieces; cut order ${cut.toLocaleString()}`,
      entityType: 'StageQuantity', entityId: orderId, meta: { ledger: 'ORDER', source: src.fileName, pieces: written, cut },
    });
    await refreshOrderCache(orderId);
    return {
      filled: true, pieces: written, cut, fileName: src.fileName,
      warnings: extraction.issues.filter((i) => i.level !== 'INFO').map((i) => i.message),
    };
  }
  return { filled: false, reason: 'NOTHING_READ', tried: sources.length };
}

/**
 * Every open order with an empty Main Order and a PO in the system, filled.
 * Run once at start-up; each order is independent, so one bad file cannot
 * stop the rest.
 */
export async function fillAllEmptyMainOrders(): Promise<{ checked: number; filled: number; pieces: number }> {
  const candidates = await prisma.order.findMany({
    where: {
      cancelled: false,
      quantities: { none: { ledger: 'ORDER', qty: { gt: 0 } } },
      AND: [
        // Open orders only. A null status is a new order that was never cached.
        { OR: [{ cachedStatus: null }, { cachedStatus: { notIn: ['CANCELLED', 'COMPLETED', 'SHIPPED'] as never[] } }] },
        {
          OR: [
            { attachments: { some: { documentType: { in: [...PO_TYPES] } } } },
            { id: { in: (await prisma.importJob.findMany({ where: { createdOrderId: { not: null } }, select: { createdOrderId: true } })).map((j) => j.createdOrderId!) } },
          ],
        },
      ],
    },
    select: { id: true, poNumber: true },
  });
  let filled = 0, pieces = 0;
  for (const o of candidates) {
    try {
      const r = await fillMainOrderFromDocuments(o.id, { id: null, name: 'OpsFlow (automatic)' });
      if (r.filled) { filled++; pieces += r.pieces; console.log(`  orders   → PO ${o.poNumber}: Main Order filled from "${r.fileName}" (${r.pieces} pcs, cut ${r.cut})`); }
    } catch (err) {
      console.error(`[fill] PO ${o.poNumber}:`, err);
    }
  }
  return { checked: candidates.length, filled, pieces };
}
