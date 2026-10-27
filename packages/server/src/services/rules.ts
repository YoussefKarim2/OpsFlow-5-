/**
 * Business rules — the brief's section 39.
 *
 * Everything here was a sentence in the workbook that nobody was bound by, and
 * Excel has no way to stop you. These functions do.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  QuantityRuleError, TaskPrerequisiteError,
  OverrideRequiredError, ValidationError,
} from '../errors.js';

/** Quantity sanity — negative, absurd, or out-of-order values are refused. */
/**
 * The largest quantity the quantity columns can hold.
 *
 * They are 32-bit integers, so anything past 2,147,483,647 is refused by
 * Postgres itself — and arrived as a 500, telling the caller the server had
 * broken when they had typed too many digits. Ten million pieces is far beyond
 * any real garment order and comfortably inside the column, so the refusal
 * happens here, in a sentence, rather than there, in a stack trace.
 */
const MAX_QUANTITY = 10_000_000;

export function assertValidQuantity(qty: number, label = 'Quantity'): void {
  if (!Number.isFinite(qty)) throw new ValidationError(`${label} must be a number.`);
  if (qty < 0) throw new QuantityRuleError(`${label} cannot be negative.`);
  if (!Number.isInteger(qty)) throw new ValidationError(`${label} must be a whole number of pieces.`);
  if (qty > MAX_QUANTITY) {
    throw new ValidationError(
      `${label} of ${qty.toLocaleString()} is larger than this system records. `
      + `Check for an extra digit — the limit is ${MAX_QUANTITY.toLocaleString()} pieces.`,
    );
  }
}

/**
 * Produced quantity may exceed the order (the cut allowance exists precisely
 * so it can), but not by an implausible margin — a fat-fingered 45000 instead
 * of 450 should be caught at entry, not discovered at packing.
 */
const PRODUCTION_SANITY_MULTIPLE = 1.5;

export function assertProductionWithinReason(
  newTotalProduced: number,
  orderQty: number,
  cutQty: number,
): void {
  const ceiling = Math.max(cutQty, orderQty) * PRODUCTION_SANITY_MULTIPLE;
  if (orderQty > 0 && newTotalProduced > ceiling) {
    throw new QuantityRuleError(
      `Recorded production of ${newTotalProduced.toLocaleString()} exceeds ${Math.round(ceiling).toLocaleString()} — ` +
        `${PRODUCTION_SANITY_MULTIPLE}× the cut quantity. Check the figure, or record it in smaller entries if it is correct.`,
      { newTotalProduced, orderQty, cutQty, ceiling },
    );
  }
}

/**
 * Packed quantity, held to the same ceiling as production.
 *
 * Cartons had no limit at all, so a carton of 2400 typed for 240 went onto the
 * PACKED ledger and the funnel showed the order packed ten times over. The
 * ceiling is the production one — the larger of the order and the cut, times
 * the same multiple — because a factory cannot pack what it could not have made.
 */
export function assertPackingWithinReason(
  newTotalPacked: number,
  orderQty: number,
  cutQty: number,
): void {
  const ceiling = Math.max(cutQty, orderQty) * PRODUCTION_SANITY_MULTIPLE;
  if (orderQty > 0 && newTotalPacked > ceiling) {
    throw new QuantityRuleError(
      `This would make ${newTotalPacked.toLocaleString()} pieces packed on the order, more than ` +
        `${Math.round(ceiling).toLocaleString()} — ${PRODUCTION_SANITY_MULTIPLE}× the larger of the order and cut quantities. ` +
        'Check the carton quantities for an extra digit.',
      { newTotalPacked, orderQty, cutQty, ceiling },
    );
  }
}

/**
 * Produced as the order counts it after one sewing entry changes.
 *
 * The order's produced figure is the IN_LINE ledger or the sewing records,
 * whichever is further along (see deriveOrder), so taking an entry out only
 * lowers it when sewing was the larger of the two. `removedSewing` is what the
 * entry counted towards sewing before, `addedSewing` what it counts after.
 */
export function producedAfterChange(opts: {
  inLineQty: number;
  sewingQty: number;
  removedSewing: number;
  addedSewing: number;
}): number {
  return Math.max(opts.inLineQty, opts.sewingQty - opts.removedSewing + opts.addedSewing);
}

/**
 * Correcting production may not leave the order having shipped more than it
 * made — the shipped-versus-produced rule seen from the other side. Before this,
 * a production entry could be removed after its pieces had shipped, and the
 * order then showed 1,000 shipped against 600 produced with no override on
 * record. The same override as shipping applies: the permission and a reason.
 *
 * Only a change that lowers produced is judged. An order that was already
 * shipped past produced under an override is not blocked from an unrelated edit.
 */
export function assertProducedCoversShipped(opts: {
  producedBefore: number;
  producedAfter: number;
  shippedQty: number;
  hasOverridePermission: boolean;
  overrideReason?: string | null;
}): void {
  const { producedBefore, producedAfter, shippedQty, hasOverridePermission, overrideReason } = opts;
  if (producedAfter >= producedBefore || producedAfter >= shippedQty) return;

  if (!hasOverridePermission) {
    throw new OverrideRequiredError(
      `This would leave ${producedAfter.toLocaleString()} pieces produced when ${shippedQty.toLocaleString()} ` +
        'are already on shipments. An administrator can override this.',
    );
  }
  if (!overrideReason?.trim()) {
    throw new ValidationError(
      'Taking produced below shipped requires a written reason. Send it in the X-Change-Reason header.',
    );
  }
}

/**
 * Shipped may not exceed produced — the brief's rule — unless an admin
 * overrides with a reason. The reason is mandatory and lands in the audit
 * trail, so the exception is visible rather than silent.
 */
export function assertShippableQuantity(opts: {
  shippedQty: number;
  producedQty: number;
  hasOverridePermission: boolean;
  overrideReason?: string | null;
}): void {
  const { shippedQty, producedQty, hasOverridePermission, overrideReason } = opts;
  if (shippedQty <= producedQty) return;

  if (!hasOverridePermission) {
    throw new OverrideRequiredError(
      `Cannot ship ${shippedQty.toLocaleString()} pieces when only ${producedQty.toLocaleString()} have been produced. ` +
        `An administrator can override this.`,
    );
  }
  if (!overrideReason?.trim()) {
    throw new ValidationError(
      'Shipping more than was produced requires a written reason. Send it in the X-Change-Reason header.',
    );
  }
}

/**
 * Pieces committed to consignments once a shipment is recorded or changed.
 *
 * The shipped-versus-produced rule is about the order, not one consignment:
 * checking each new row on its own let five shipments of 900 go out against
 * 1,000 produced. So the check is made against the running total — every other
 * consignment plus this one. When a row is being edited it is left out of the
 * others, or its old quantity would be counted alongside its new one.
 */
export function shipmentTotalAfter(
  shipments: readonly { id: string; qty: number }[],
  qty: number,
  editingId?: string | null,
): number {
  return shipments.reduce((a, s) => (s.id === editingId ? a : a + s.qty), 0) + qty;
}

/**
 * A task cannot be completed without the information the process says it
 * produces. Progress Status column H lists that information for every step; the
 * checks below encode the ones a machine can verify.
 */
export async function assertTaskCompletable(
  prisma: PrismaClient | Prisma.TransactionClient,
  task: { id: string; orderId: string; templateKey: string | null; title: string; blockedByTaskId: string | null },
): Promise<void> {
  if (task.blockedByTaskId) {
    const blocker = await prisma.task.findUnique({
      where: { id: task.blockedByTaskId },
      select: { title: true, status: true },
    });
    if (blocker && blocker.status !== 'COMPLETED') {
      throw new TaskPrerequisiteError(
        `"${task.title}" is waiting on "${blocker.title}", which is not complete.`,
      );
    }
  }

  switch (task.templateKey) {
    case 'FM_MAIN_ORDER': {
      const cells = await prisma.stageQuantity.count({
        where: { orderId: task.orderId, ledger: 'ORDER', qty: { gt: 0 } },
      });
      if (cells === 0) {
        throw new TaskPrerequisiteError(
          'The quantity matrix is empty. Enter the colour and size quantities before completing this task.',
        );
      }
      break;
    }

    case 'CO_SET_PARAMS': {
      const order = await prisma.order.findUnique({
        where: { id: task.orderId },
        select: { cutPercentage: true, shippingAddress: true, requiredDeliveryDate: true },
      });
      const missing: string[] = [];
      if (!order?.shippingAddress?.trim()) missing.push('shipping address');
      if (!order?.requiredDeliveryDate) missing.push('required delivery date');
      if (missing.length > 0) {
        throw new TaskPrerequisiteError(`Set the ${missing.join(' and ')} before completing this task.`);
      }
      break;
    }

    case 'CM_CUT_RATIOS':
    case 'CM_REAL_MARKERS': {
      const markers = await prisma.marker.count({ where: { orderId: task.orderId } });
      if (markers === 0) {
        throw new TaskPrerequisiteError('No markers have been recorded. Add the lay plan before completing this task.');
      }
      break;
    }

    case 'CO_BOM_ACCESSORIES':
    case 'CM_BOM_FABRIC': {
      const items = await prisma.bomItem.count({ where: { orderId: task.orderId } });
      if (items === 0) {
        throw new TaskPrerequisiteError('The bill of materials is empty. Add the required items before completing this task.');
      }
      break;
    }

    case 'WH_ISSUE_MATERIALS': {
      const outstanding = await prisma.bomItem.findMany({
        where: { orderId: task.orderId },
        select: { item: true, requiredQty: true, issuedQty: true },
      });
      const short = outstanding.filter((b) => Number(b.issuedQty) < Number(b.requiredQty));
      if (short.length > 0) {
        throw new TaskPrerequisiteError(
          `${short.length} material${short.length === 1 ? ' is' : 's are'} still outstanding ` +
            `(e.g. ${short[0]!.item}). Issue them, or record a purchase order, before completing this task.`,
          { shortItems: short.map((s) => s.item) },
        );
      }
      break;
    }

    case 'PK_BUILD_LIST': {
      const cartons = await prisma.carton.count({
        where: { packingList: { orderId: task.orderId } },
      });
      if (cartons === 0) {
        throw new TaskPrerequisiteError('No cartons have been recorded. Build the packing list before completing this task.');
      }
      break;
    }

    case 'CO_REVIEW_PACKING': {
      const list = await prisma.packingList.findFirst({
        where: { orderId: task.orderId },
        orderBy: { createdAt: 'desc' },
      });
      if (!list) throw new TaskPrerequisiteError('There is no packing list to review.');
      if (!list.approved) {
        throw new TaskPrerequisiteError('Approve the packing list before completing this task.');
      }
      break;
    }

    case 'QA_FINAL_AUDIT': {
      const audit = await prisma.qualityAudit.findFirst({
        where: { orderId: task.orderId },
        orderBy: { createdAt: 'desc' },
      });
      if (!audit || audit.result === 'PENDING') {
        throw new TaskPrerequisiteError('Record the final inspection result before completing this task.');
      }
      break;
    }

    default:
      break;
  }
}

/** Dates must be real and in a sane relationship to each other. */
export function assertValidOrderDates(d: {
  poDate?: Date | string | null;
  promisedShippingDate?: Date | string | null;
  requiredDeliveryDate?: Date | string | null;
}): void {
  const parse = (v: Date | string | null | undefined, label: string): Date | null => {
    if (v == null) return null;
    const date = new Date(v);
    if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} is not a valid date.`);
    return date;
  };

  const po = parse(d.poDate, 'PO date');
  const ship = parse(d.promisedShippingDate, 'Promised shipping date');
  const deliver = parse(d.requiredDeliveryDate, 'Required delivery date');

  if (po && ship && ship < po) {
    throw new ValidationError('The promised shipping date cannot be before the PO date.');
  }
  if (po && deliver && deliver < po) {
    throw new ValidationError('The required delivery date cannot be before the PO date.');
  }
}

/** PO number: required, trimmed, uppercase, and unique. */
export function normalisePoNumber(po: string | null | undefined): string {
  const value = po?.trim().toUpperCase();
  if (!value) throw new ValidationError('PO number is required.');
  if (value.length > 64) throw new ValidationError('PO number is too long (max 64 characters).');
  return value;
}

/** Cut percentage sanity: 0–50%, since a 5% allowance is typical and 500% is a typo. */
export function assertValidPercentage(value: number, label: string, max = 0.5): void {
  if (!Number.isFinite(value)) throw new ValidationError(`${label} must be a number.`);
  if (value < 0) throw new ValidationError(`${label} cannot be negative.`);
  if (value > max) {
    throw new ValidationError(
      `${label} of ${(value * 100).toFixed(1)}% looks wrong (maximum ${(max * 100).toFixed(0)}%).`,
    );
  }
}
