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
  | { filled: false; reason: 'HAS_QUANTITIES' | 'NO_DOCUMENT' | 'NOTHING_READ' | 'NOT_THIS_PO'; tried: number; otherPo?: string };

const PO_TYPES = ['CUSTOMER_PO', 'CUSTOMER_REFERENCE'] as const;
const READABLE = /\.(pdf|xlsx|xlsm|csv)$/i;

async function orderPieces(orderId: string): Promise<number> {
  const agg = await prisma.stageQuantity.aggregate({ where: { orderId, ledger: 'ORDER' }, _sum: { qty: true } });
  return agg._sum.qty ?? 0;
}

/**
 * The documents an order's quantities can come from, best first.
 *
 * `trusted` says the document is this order's PO by construction: the file
 * the order was imported from, or one a person filed as "Customer PO". Any
 * other reference document (a tech pack, say, whose measurement chart reads
 * like a size grid) is used only when the PO number it carries is this
 * order's.
 */
async function sourcesFor(orderId: string): Promise<Array<{ storageKey: string; fileName: string; trusted: boolean }>> {
  const jobs = await prisma.importJob.findMany({
    where: { createdOrderId: orderId }, orderBy: { createdAt: 'desc' }, select: { storageKey: true, fileName: true },
  });
  const attachments = await prisma.attachment.findMany({
    where: { orderId, documentType: { in: [...PO_TYPES] } },
    orderBy: { createdAt: 'desc' }, select: { storageKey: true, fileName: true, documentType: true },
  });
  const rank = (t: string) => (t === 'CUSTOMER_PO' ? 0 : 1);
  const all = [
    ...jobs.map((j) => ({ ...j, trusted: true })),
    ...attachments.filter((a) => READABLE.test(a.fileName))
      .sort((a, b) => rank(a.documentType) - rank(b.documentType))
      .map((a) => ({ storageKey: a.storageKey, fileName: a.fileName, trusted: a.documentType === 'CUSTOMER_PO' })),
  ];
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
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { poNumber: true } });
  const samePo = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
  let otherPo: string | undefined;

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
    const docPo = extraction.fields.poNumber == null ? null : String(extraction.fields.poNumber);
    if (!src.trusted && !samePo(docPo, order?.poNumber)) {
      otherPo = docPo ?? otherPo;
      continue; // not this order's PO
    }

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
  if (otherPo !== undefined) return { filled: false, reason: 'NOT_THIS_PO', tried: sources.length, otherPo };
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
