/**
 * Business rules — the brief's section 39.
 *
 * Everything here was a sentence in the workbook that nobody was bound by.
 * `External Order!M15` literally says "برجاء عدم البدء ف طباعه الاوردر الا بعد
 * موافقه العميل" — do not start printing before customer approval — and Excel
 * has no way to stop you. These functions do.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ApprovalRequiredError, QuantityRuleError, TaskPrerequisiteError,
  OverrideRequiredError, ValidationError,
} from '../errors.js';

/** Quantity sanity — negative, absurd, or out-of-order values are refused. */
export function assertValidQuantity(qty: number, label = 'Quantity'): void {
  if (!Number.isFinite(qty)) throw new ValidationError(`${label} must be a number.`);
  if (qty < 0) throw new QuantityRuleError(`${label} cannot be negative.`);
  if (!Number.isInteger(qty)) throw new ValidationError(`${label} must be a whole number of pieces.`);
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
 * The approval gate. An external operation that requires customer approval
 * cannot leave NOT_SENT until an APPROVED approval exists.
 */
const STARTED_STATES = new Set(['SENT', 'IN_PROGRESS', 'RETURNED']);

export function assertExternalOpMayStart(op: {
  operationType: string;
  requiresApproval: boolean;
  approvalStatus: string | null | undefined;
  targetStatus: string;
}): void {
  if (!STARTED_STATES.has(op.targetStatus)) return;
  if (!op.requiresApproval) return;
  if (op.approvalStatus === 'APPROVED') return;
  throw new ApprovalRequiredError(op.operationType);
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

    case 'EX_SEND_ORDER': {
      const ops = await prisma.externalOperation.findMany({
        where: { orderId: task.orderId, requiresApproval: true },
        include: { approval: true },
      });
      const blocked = ops.filter((o) => o.approval?.status !== 'APPROVED');
      if (blocked.length > 0) {
        throw new ApprovalRequiredError(blocked[0]!.operationType);
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
      `${label} of ${(value * 100).toFixed(1)}% looks wrong (maximum ${(max * 100).toFixed(0)}%). Enter it as a fraction, e.g. 0.05 for 5%.`,
    );
  }
}
