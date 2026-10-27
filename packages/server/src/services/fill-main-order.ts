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
import type { ExtractionResult } from './import/extractor.js';
import { writeCutOrderIn } from './cut-order.js';
import { ORDER_INCLUDE, refreshOrderCache } from './order-service.js';
import { logActivity } from './activity-service.js';

export type FillResult =
  | { filled: true; pieces: number; cut: number; fileName: string; warnings: string[] }
  | { filled: false; reason: 'HAS_QUANTITIES' | 'NO_DOCUMENT' | 'NOTHING_READ' | 'NOT_THIS_PO'; tried: number; otherPo?: string };

const PO_TYPES = ['CUSTOMER_PO', 'CUSTOMER_REFERENCE'] as const;
const READABLE = /\.(pdf|xlsx|xlsm|csv)$/i;

/** Reader warnings about the order's header, which a fill does not write. */
const ORDER_HEADER_FIELDS = new Set(['poNumber', 'clientName', 'orderName']);

/** No upload can be larger than this (the import and attachment limit), so a stored file that is is not read. */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * Documents that failed to read in this process, by storage key — not tried
 * again until the server restarts.
 */
const unreadable = new Set<string>();

/**
 * Two PO numbers that are the same number: case and spacing aside, and a
 * leading "PO" too — the document says "PO-178", the order was created as
 * "178". Nothing else is loosened: "17-8" and "1-78" stay different orders.
 */
export function samePo(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (s: string) => s.trim().toUpperCase().replace(/^P\.?O\.?\s*(?:NO\.?|#)?\s*[-#:.]?\s*(?=\w)/, '').replace(/\s+/g, '');
  return !!a && !!b && key(a) !== '' && key(a) === key(b);
}

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
 * order's. `importedFrom` marks the file the order was created from, the one
 * document whose PO number is not checked against the order's.
 */
async function sourcesFor(orderId: string): Promise<Array<{ storageKey: string; fileName: string; trusted: boolean; importedFrom: boolean }>> {
  const jobs = await prisma.importJob.findMany({
    where: { createdOrderId: orderId }, orderBy: { createdAt: 'desc' }, select: { storageKey: true, fileName: true },
  });
  const attachments = await prisma.attachment.findMany({
    where: { orderId, documentType: { in: [...PO_TYPES] } },
    orderBy: { createdAt: 'desc' }, select: { storageKey: true, fileName: true, documentType: true },
  });
  const rank = (t: string) => (t === 'CUSTOMER_PO' ? 0 : 1);
  const all = [
    ...jobs.map((j) => ({ ...j, trusted: true, importedFrom: true })),
    ...attachments.filter((a) => READABLE.test(a.fileName))
      .sort((a, b) => rank(a.documentType) - rank(b.documentType))
      .map((a) => ({ storageKey: a.storageKey, fileName: a.fileName, trusted: a.documentType === 'CUSTOMER_PO', importedFrom: false })),
  ];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.storageKey) ? false : (seen.add(s.storageKey), true)));
}

/**
 * Whether a document's quantities may fill this order, judged by its PO.
 *
 * A document that states another PO is another order's, however it was
 * filed: a "Customer PO" attached to the wrong order filled it with that
 * order's quantities. "States" means a labelled PO number — not one the reader
 * guessed or made up, which it flags with a warning. The file the order was
 * imported from is exempt: it is this order's by construction, even if the PO
 * was renamed since. Any other reference document must show this order's PO.
 */
export function documentPoVerdict(
  src: { trusted: boolean; importedFrom: boolean },
  extraction: Pick<ExtractionResult, 'fields' | 'issues'>,
  orderPo: string | null | undefined,
): 'USE' | 'OTHER_PO' | 'NOT_SHOWN' {
  const docPo = extraction.fields.poNumber == null ? null : String(extraction.fields.poNumber);
  const labelled = docPo != null && !extraction.issues.some((i) => i.level === 'WARNING' && i.field === 'poNumber');
  if (labelled && !src.importedFrom && !samePo(docPo, orderPo)) return 'OTHER_PO';
  if (!src.trusted && !samePo(docPo, orderPo)) return 'NOT_SHOWN';
  return 'USE';
}

export async function fillMainOrderFromDocuments(
  orderId: string,
  actor: { id: string | null; name: string },
): Promise<FillResult> {
  if (await orderPieces(orderId) > 0) return { filled: false, reason: 'HAS_QUANTITIES', tried: 0 };
  const sources = await sourcesFor(orderId);
  if (sources.length === 0) return { filled: false, reason: 'NO_DOCUMENT', tried: 0 };
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { poNumber: true } });
  let otherPo: string | undefined;

  // Loaded here rather than at the top: the import route imports the orders
  // route, which imports this module.
  const { runExtraction } = await import('../routes/import.js');
  for (const src of sources) {
    // A document that has already failed to read in this process is not read
    // again, and nor is one larger than any upload could be: the start-up fill
    // runs on every boot, and one bad file must not cost every boot.
    if (unreadable.has(src.storageKey)) continue;
    let extraction: Awaited<ReturnType<typeof runExtraction>>;
    try {
      const buffer = await storage.get(src.storageKey);
      if (buffer.length > MAX_DOCUMENT_BYTES) { unreadable.add(src.storageKey); continue; }
      extraction = await runExtraction(buffer, {});
    } catch {
      unreadable.add(src.storageKey);
      continue; // unreadable or missing; try the next document
    }
    const matrix = extraction.matrices.find((m) => m.ledger === 'ORDER');
    const pieces = matrix ? matrix.rows.reduce((a, r) => a + Object.values(r.cells).reduce((b, q) => b + (q > 0 ? q : 0), 0), 0) : 0;
    if (!matrix || pieces === 0) continue;
    // A tech pack or a laying sheet reads as a grid of numbers too. The
    // readers say when a file is not a purchase order; filed as one by
    // mistake, it must not become 370 "pieces" called Chest and Sleeve.
    if (extraction.issues.some((i) => i.field === 'documentKind')) continue;
    const verdict = documentPoVerdict(src, extraction, order?.poNumber);
    if (verdict !== 'USE') {
      otherPo = (extraction.fields.poNumber == null ? null : String(extraction.fields.poNumber)) ?? otherPo;
      continue;
    }

    // One transaction for the Main Order and the Cut Order calculated from
    // it: written apart, a failure between them left a Main Order with no Cut
    // Order, and nothing would ever fill it again — the order no longer
    // looked empty. Checked again inside: someone may have typed a grid
    // meanwhile.
    const done = await prisma.$transaction(async (tx) => {
      const agg = await tx.stageQuantity.aggregate({ where: { orderId, ledger: 'ORDER' }, _sum: { qty: true } });
      if ((agg._sum.qty ?? 0) > 0) return null;
      const written = await writeOrderMatrix(tx, orderId, matrix);
      if (written === 0) return null;
      const full = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      const { total: cut } = await writeCutOrderIn(tx, full!);
      return { written, cut };
    }, { timeout: 30_000 });
    if (!done) return { filled: false, reason: 'HAS_QUANTITIES', tried: 0 };
    const { written, cut } = done;

    await logActivity({
      orderId, actorId: actor.id, actorName: actor.name,
      action: 'QUANTITIES_UPDATED',
      summary: `filled the Main Order from "${src.fileName}": ${written.toLocaleString()} pieces; cut order ${cut.toLocaleString()}`,
      entityType: 'StageQuantity', entityId: orderId, meta: { ledger: 'ORDER', source: src.fileName, pieces: written, cut },
    });
    await refreshOrderCache(orderId);
    return {
      filled: true, pieces: written, cut, fileName: src.fileName,
      // About the quantities only: "no customer was found" is about creating
      // an order, and this one already exists.
      warnings: extraction.issues
        .filter((i) => i.level !== 'INFO' && !ORDER_HEADER_FIELDS.has(i.field ?? ''))
        .map((i) => i.message),
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
