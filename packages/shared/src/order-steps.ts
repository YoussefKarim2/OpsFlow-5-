/**
 * The factory's order routine, as the workbook itself declares it.
 *
 * Cells A4:A21 of every sheet in `PO No. 85 – 13506 Florida T Shirt` are a
 * hyperlink menu, and that menu *is* the factory's standard operating
 * procedure — written by the factory, in the order the factory works. It is
 * reproduced here verbatim rather than replaced with a workflow of our own
 * invention.
 *
 *      1 🖼 Customer Reference      7 ✂ Cut Order              13 📈 Follow-up
 *      2 📋 Order Details           8 📐 Laying Fabric          14 🏭 Production Follow-up
 *      3 🧾 Main Order              9 🧵 Bill of Material       15 ✅ Audit
 *      4 🧾 Proforma Invoice       10 ✍ Custom Instructions    16 💰 Actual Costing
 *      5 🌐 External Order         11 📦 Packing               17 🗄 Database
 *      6 🕒 Progress Status        12 📦 Stock                 18 🧾 Invoice
 *
 * CORRECTION, and worth recording. The first version of this file claimed to
 * reproduce that menu verbatim and did not: it put Production and Audit at 11
 * and 12, ahead of Packing, Stock and Follow-up, and it replaced the
 * workbook's own `🗄 Database` at A20 with an invented "Complete" step. The
 * test passed because it asserted the transcription rather than the workbook.
 * The order above is the file's, re-read from A4:A21 cell by cell.
 *
 * Two things this module exists to enforce.
 *
 * **A step is a place to do work, not a tab.** Each carries who does it, what
 * they type, and how the system knows it is finished. A coordinator opening an
 * order should never have to work out which of sixteen equal doors is theirs.
 *
 * **Not every order needs every step.** An order with no printing has no
 * external operation, and marching it through that step teaches people to tick
 * boxes that mean nothing. Each step declares when it *applies*; the ones that
 * do not are marked "Not required" and stay out of the way.
 */

import { StageKey, StageStatus, Department } from './enums.js';

// ─────────────────────────────────────────────────────────────────────────────
// What the system knows about an order, for deciding step state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assembled once per order on the server. Deliberately flat and primitive:
 * a step definition should be readable by someone who knows the factory but
 * not the codebase.
 */
export interface StepContext {
  /** Files attached to the order, by document type. */
  referenceFileCount: number;
  /** Order Details: the coordinator's own typing. */
  hasClient: boolean;
  hasPoNumber: boolean;
  hasOrderName: boolean;
  hasStyleNumber: boolean;
  hasItemType: boolean;
  hasRequiredDate: boolean;
  hasPrice: boolean;
  hasFabric: boolean;
  /** Main Order: the colour × size matrix. */
  orderQty: number;
  quantityCellCount: number;
  colorCount: number;
  sizeCount: number;
  /** Cut Order — derived from Main Order and Stock, never typed. */
  cutQty: number;
  /** Finished-goods stock deducted before cutting. */
  stockQty: number;
  stockRecorded: boolean;
  /** Laying / marker plan. */
  markerCount: number;
  markerCoversRequirement: boolean;
  /** Bill of material and its link to real inventory. */
  bomLineCount: number;
  bomFullyIssued: boolean;
  materialShortCount: number;
  /** Custom instructions written for this order. */
  customInstructionCount: number;
  /** External work. */
  externalWorkDeclared: boolean;
  externalOpCount: number;
  externalOpsReturned: number;
  externalOpsBlocked: number;
  /** Production. */
  producedQty: number;
  productionRecordCount: number;
  /** Quality. */
  auditCount: number;
  auditPassed: boolean;
  openQualityFailure: boolean;
  /** Packing. */
  cartonCount: number;
  packedQty: number;
  packingApproved: boolean;
  /** Costing. */
  hasCosting: boolean;
  costLineCount: number;
  /** Proforma invoice / invoice. */
  hasProformaInvoice: boolean;
  proformaLineCount: number;
  /** Shipping. */
  shippedQty: number;
  shipmentBooked: boolean;
  /** Workflow tasks belonging to this step, from Progress Status. */
  taskCounts: Partial<Record<StageKey, { total: number; completed: number; overdue: number }>>;
  /** What a person has explicitly recorded about the step. */
  overrides: Partial<Record<StageKey, {
    status: StageStatus | null;
    completedAt: Date | string | null;
    startedAt: Date | string | null;
    notRequiredReason: string | null;
    notes: string | null;
  }>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The step definition
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderStepDef {
  key: StageKey;
  /** Position in the factory's own sequence, 1-based. */
  order: number;
  /** The workbook's own name for the sheet. */
  sheetName: string;
  /** What to call it on screen — plain words, no factory jargon. */
  label: string;
  /** One sentence: what this step is for. Shown under the heading. */
  purpose: string;
  /** Who normally does it. */
  department: Department;
  /** What the person actually types here. Bullet points, in plain language. */
  whatYouEnter: readonly string[];
  /** Which workspace screen holds the detail. Checked against ORDER_TAB_KEYS. */
  tab: OrderTabKey;
  /**
   * Whether this step applies to this order at all. Steps with no rule always
   * apply. A step that does not apply shows as "Not required" rather than as
   * an unfinished obligation.
   */
  appliesWhen?: (c: StepContext) => boolean;
  /** Why it does not apply, said plainly. */
  notApplicableBecause?: string;
  /**
   * How the system can tell the step is done without anybody ticking a box.
   * Steps with no rule are completed by hand — some work has no trace in the
   * data, and pretending otherwise is worse than asking.
   */
  isDoneWhen?: (c: StepContext) => boolean;
  /** What is still missing, for the "what do I need to enter" line. */
  missing?: (c: StepContext) => string | null;
  /**
   * Whether anyone has recorded anything against this step yet.
   *
   * This is what separates "nobody has touched this" from "somebody is part
   * way through", and the two are very different things to a coordinator
   * scanning the rail. Without it a step with a thousand of two thousand
   * pieces produced reads as "Not started", which is simply untrue.
   */
  hasStarted?: (c: StepContext) => boolean;
  /** True when the step cannot be completed by the system on its own. */
  manualCompletion?: boolean;
  /**
   * True for a step that is a reference rather than a task.
   *
   * It is shown in the rail, it can be opened and read, and it is left out of
   * the progress denominator and never made the current step — because an
   * order is not further along for somebody having looked at it.
   */
  informational?: boolean;
}

const has = (n: number) => n > 0;

/**
 * Every screen the order workspace can show.
 *
 * Declared here, next to the steps, because a step whose `tab` is not one of
 * these navigates to a blank page — and it does so silently, since a string is
 * a string. That happened: the proforma invoice step pointed at `invoice`,
 * which the workspace does not render. `order-steps.test.ts` now asserts every
 * step's tab against this list, and the workspace derives its own tab type
 * from it, so the two cannot drift apart again.
 */
export const ORDER_TAB_KEYS = [
  'overview', 'reference', 'details', 'quantity', 'proforma', 'tasks',
  'cutting', 'materials', 'bom', 'instructions', 'external', 'approvals',
  'production', 'quality', 'packing', 'stock', 'followup',
  'shipping', 'costing', 'documents', 'activity',
  'database', 'progress', 'audit', 'invoice',
] as const;
export type OrderTabKey = (typeof ORDER_TAB_KEYS)[number];

/**
 * The eighteen steps, in the workbook's order.
 *
 * `Data-Base` is deliberately absent: it is the factory's reference lists —
 * fabrics, colours, sizes — not a step in an order. In OpsFlow those are
 * reference tables that every order reads.
 */
export const ORDER_STEPS: readonly OrderStepDef[] = [
  {
    key: StageKey.CUSTOMER_ORDER_REF,
    order: 1,
    sheetName: 'Customer Order Ref_Coordinator',
    label: 'Customer Reference',
    purpose: 'Attach what the customer actually sent, so everyone works from the same document.',
    department: Department.FACTORY_MANAGER,
    whatYouEnter: [
      'The customer’s order document or purchase order',
      'Any artwork, photos or size charts they sent',
      'Notes about anything unusual in the order',
    ],
    tab: 'reference',
    isDoneWhen: (c) => has(c.referenceFileCount),
    missing: (c) => (has(c.referenceFileCount) ? null : 'Attach the customer’s order document'),
    hasStarted: (c) => has(c.referenceFileCount),
  },
  {
    key: StageKey.ORDER_DETAILS,
    order: 2,
    sheetName: 'Order Details_Coordinator',
    label: 'Order Details',
    purpose:
      'The facts of the order. Everything typed here appears automatically on every later step — ' +
      'this is the only place it is entered.',
    department: Department.COORDINATOR,
    whatYouEnter: [
      'Customer, PO number, order name and season',
      'Item type, style number, gender and fabric',
      'Prices, dates and shipping method',
      'Cut percentage and any notes for cutting, spreading or packing',
    ],
    tab: 'details',
    isDoneWhen: (c) =>
      c.hasClient && c.hasPoNumber && c.hasOrderName && c.hasItemType && c.hasRequiredDate,
    missing: (c) => {
      const gaps: string[] = [];
      if (!c.hasClient) gaps.push('customer');
      if (!c.hasPoNumber) gaps.push('PO number');
      if (!c.hasOrderName) gaps.push('order name');
      if (!c.hasItemType) gaps.push('item type');
      if (!c.hasRequiredDate) gaps.push('required delivery date');
      return gaps.length === 0 ? null : `Still needed: ${gaps.join(', ')}`;
    },
    hasStarted: (c) => c.hasClient || c.hasPoNumber || c.hasOrderName,
  },
  {
    key: StageKey.MAIN_ORDER,
    order: 3,
    sheetName: 'Main Order_Factory.Manger',
    label: 'Main Order',
    purpose: 'How many pieces of each colour and size. This is the order the factory works to.',
    department: Department.FACTORY_MANAGER,
    whatYouEnter: [
      'The colours the order is made in',
      'The sizes it is made in',
      'How many pieces of each colour and size',
    ],
    tab: 'quantity',
    isDoneWhen: (c) => has(c.orderQty) && has(c.quantityCellCount),
    missing: (c) =>
      has(c.orderQty) ? null : 'Enter the quantity for each colour and size',
    hasStarted: (c) => has(c.quantityCellCount) || has(c.colorCount),
  },
  {
    key: StageKey.PROFORMA_INVOICE,
    order: 4,
    sheetName: 'Proforma Invoice_Factory.Manger',
    label: 'Proforma Invoice',
    purpose: 'The priced document sent to the customer before shipment.',
    department: Department.FACTORY_MANAGER,
    whatYouEnter: [
      'Invoice number and date',
      'What is being invoiced, the quantity and the unit price',
      'Shipping details, once they are known',
    ],
    tab: 'proforma',
    isDoneWhen: (c) => c.hasProformaInvoice && has(c.proformaLineCount),
    missing: (c) =>
      c.hasProformaInvoice ? (has(c.proformaLineCount) ? null : 'Add at least one invoice line')
        : 'Create the proforma invoice',
    hasStarted: (c) => c.hasProformaInvoice,
  },
  {
    key: StageKey.EXTERNAL_ORDER,
    order: 5,
    sheetName: 'External Order_Ex.Op',
    label: 'External Work',
    purpose: 'Printing, embroidery or anything else done outside the factory.',
    department: Department.EXTERNAL_OPS,
    whatYouEnter: [
      'What kind of external work, and which supplier',
      'How many pieces were sent, and when',
      'How many came back, and when',
      'Customer approval, where the work needs it',
    ],
    tab: 'external',
    // The order sheet says whether the order has external work at all. When it
    // says none, this step is not an unfinished obligation — it does not exist.
    appliesWhen: (c) => c.externalWorkDeclared || has(c.externalOpCount),
    notApplicableBecause: 'This order has no printing or embroidery.',
    isDoneWhen: (c) =>
      has(c.externalOpCount) && c.externalOpsReturned >= c.externalOpCount && c.externalOpsBlocked === 0,
    missing: (c) => {
      if (!has(c.externalOpCount)) return 'Record the external operation and send it';
      if (c.externalOpsBlocked > 0) return 'Customer approval is outstanding';
      const outstanding = c.externalOpCount - c.externalOpsReturned;
      return outstanding > 0 ? `${outstanding} operation${outstanding === 1 ? '' : 's'} not back yet` : null;
    },
    hasStarted: (c) => has(c.externalOpCount),
  },
  {
    key: StageKey.PROGRESS_STATUS,
    order: 6,
    sheetName: 'Progress Status',
    label: 'Progress Checklist',
    purpose:
      'The factory’s own task list for this order — twenty-seven jobs, each with a department ' +
      'and the information it needs.',
    department: Department.COORDINATOR,
    whatYouEnter: [
      'Tick each job as your department finishes it',
      'The time it actually took',
    ],
    tab: 'progress',
    isDoneWhen: (c) => {
      const t = c.taskCounts[StageKey.PROGRESS_STATUS];
      return !!t && t.total > 0 && t.completed >= t.total;
    },
    missing: (c) => {
      const t = c.taskCounts[StageKey.PROGRESS_STATUS];
      if (!t || t.total === 0) return 'The task list has not been created for this order yet';
      const left = t.total - t.completed;
      return left > 0 ? `${left} job${left === 1 ? '' : 's'} still open` : null;
    },
    hasStarted: (c) => (c.taskCounts[StageKey.PROGRESS_STATUS]?.completed ?? 0) > 0,
  },
  {
    key: StageKey.CUT_ORDER,
    order: 7,
    sheetName: 'Cut Order',
    label: 'Cut Order',
    purpose:
      'How many pieces to cut. Worked out for you: the order quantity, less any finished stock, ' +
      'plus the cutting allowance.',
    department: Department.CUTTING_MARKER,
    whatYouEnter: [
      'Nothing — this is calculated',
      'Record the pieces actually cut once cutting is done',
    ],
    tab: 'quantity',
    isDoneWhen: (c) => has(c.cutQty),
    missing: (c) =>
      has(c.cutQty) ? null : 'Enter the order quantities first — the cut order is calculated from them',
    hasStarted: (c) => has(c.cutQty),
  },
  {
    key: StageKey.LAYING_FABRIC,
    order: 8,
    sheetName: 'Laying fabric instructions_Patr',
    label: 'Laying & Marker',
    purpose: 'How the fabric is spread and cut: the lays, the layers and the marker for each.',
    department: Department.CUTTING_MARKER,
    whatYouEnter: [
      'Each lay: fabric, colour and which panel',
      'The size ratio and the number of layers',
      'Marker length, and the metres the lay actually used',
    ],
    tab: 'cutting',
    isDoneWhen: (c) => has(c.markerCount) && c.markerCoversRequirement,
    missing: (c) => {
      if (!has(c.markerCount)) return 'Add the lays for this order';
      return c.markerCoversRequirement ? null : 'The lay plan does not yet cover the cut quantity';
    },
    hasStarted: (c) => has(c.markerCount),
  },
  {
    key: StageKey.BILL_OF_MATERIAL,
    order: 9,
    sheetName: 'Bill Of Matrial_Coord_Warehouse',
    label: 'Bill of Materials',
    purpose: 'Everything the order needs from the store — fabric, thread, labels, packaging.',
    department: Department.WAREHOUSE,
    whatYouEnter: [
      'Each material, how much is needed, and in what unit',
      'Which material in the store it comes from',
      'What the warehouse actually issued, and to whom',
    ],
    tab: 'bom',
    isDoneWhen: (c) => has(c.bomLineCount) && c.bomFullyIssued,
    missing: (c) => {
      if (!has(c.bomLineCount)) return 'List the materials this order needs';
      if (c.materialShortCount > 0) {
        return `${c.materialShortCount} material${c.materialShortCount === 1 ? '' : 's'} short of stock`;
      }
      return c.bomFullyIssued ? null : 'Some materials have not been issued yet';
    },
    hasStarted: (c) => has(c.bomLineCount),
  },
  {
    key: StageKey.CUSTOM_INSTRUCTIONS,
    order: 10,
    sheetName: 'Custom Instructions_Coordinator',
    label: 'Special Instructions',
    purpose: 'Anything unusual about this order that a department needs to know.',
    department: Department.COORDINATOR,
    whatYouEnter: [
      'Special sewing, printing or packing instructions',
      'Customer requirements and anything to watch for',
      'Which departments need to see each instruction',
    ],
    tab: 'instructions',
    // Most orders have none, and that is a real answer rather than an omission.
    manualCompletion: true,
    isDoneWhen: (c) => has(c.customInstructionCount),
    missing: (c) =>
      has(c.customInstructionCount)
        ? null
        : 'Add any special instructions, or mark this step as not required',
    hasStarted: (c) => has(c.customInstructionCount),
  },
  {
    key: StageKey.PACKING,
    order: 11,
    sheetName: 'Packing_Coordinator',
    label: 'Packing',
    purpose: 'The packing list: which pieces went into which carton.',
    department: Department.PACKING,
    whatYouEnter: [
      'Each carton: number, colour, size and quantity',
      'Weights, where the customer needs them',
      'The coordinator’s approval of the finished list',
    ],
    tab: 'packing',
    isDoneWhen: (c) => has(c.cartonCount) && c.packingApproved,
    missing: (c) => {
      if (!has(c.cartonCount)) return 'Add the cartons';
      return c.packingApproved ? null : 'The packing list has not been approved';
    },
    hasStarted: (c) => has(c.cartonCount) || has(c.packedQty),
  },
  {
    key: StageKey.STOCK,
    order: 12,
    sheetName: 'Stock_Packing',
    label: 'Finished Stock',
    purpose:
      'Finished pieces already in the warehouse. These are deducted before cutting, so the ' +
      'factory does not make what it already has.',
    department: Department.PACKING,
    whatYouEnter: [
      'How many finished pieces are in stock, by colour and size',
    ],
    tab: 'stock',
    // Most orders start from nothing. Recording "none" is a decision, so this
    // step is completed by hand rather than assumed.
    manualCompletion: true,
    isDoneWhen: (c) => c.stockRecorded,
    missing: (c) =>
      c.stockRecorded ? null : 'Record any finished stock, or mark this step as not required',
    hasStarted: (c) => c.stockRecorded || has(c.stockQty),
  },
  {
    key: StageKey.FOLLOW_UP,
    order: 13,
    sheetName: 'Follow up',
    label: 'Follow-up',
    purpose: 'Where the order stands right now, and what is holding it up.',
    department: Department.FOLLOW_UP,
    whatYouEnter: [
      'Nothing — this is a summary',
      'Chase whatever it shows as blocked',
    ],
    tab: 'followup',
    isDoneWhen: (c) => has(c.orderQty) && c.shippedQty >= c.orderQty,
    missing: (c) => {
      // With no order quantity there is nothing to follow up against, and
      // "0 pieces not yet shipped" would read as though the order were done.
      if (!has(c.orderQty)) return 'The order quantity has not been entered yet';
      const left = Math.max(0, c.orderQty - c.shippedQty);
      return left > 0 ? `${left.toLocaleString()} pieces not yet shipped` : null;
    },
    hasStarted: (c) => has(c.producedQty),
  },
  {
    key: StageKey.PRODUCTION_FOLLOW_UP,
    order: 14,
    sheetName: 'Production Follow up',
    label: 'Production',
    purpose: 'What the line actually produced, day by day.',
    department: Department.PRODUCTION_MANAGER,
    whatYouEnter: [
      'The date, and the pieces finished that day',
      'The line or team, where it matters',
    ],
    tab: 'production',
    isDoneWhen: (c) => has(c.orderQty) && c.producedQty >= c.orderQty,
    missing: (c) => {
      if (!has(c.productionRecordCount)) return 'Record the first day’s production';
      const left = Math.max(0, c.orderQty - c.producedQty);
      return left > 0 ? `${left.toLocaleString()} pieces still to produce` : null;
    },
    hasStarted: (c) => has(c.productionRecordCount) || has(c.producedQty),
  },
  {
    key: StageKey.AUDIT,
    order: 15,
    sheetName: 'Audit_Quality Manger',
    label: 'Quality Audit',
    purpose: 'The final inspection, and what it found.',
    department: Department.QUALITY,
    whatYouEnter: [
      'Inspection date and the quantity available to inspect',
      'How many were checked, accepted and rejected',
      'The defects found, and the result',
    ],
    tab: 'audit',
    isDoneWhen: (c) => has(c.auditCount) && c.auditPassed && !c.openQualityFailure,
    missing: (c) => {
      if (!has(c.auditCount)) return 'Record the inspection';
      if (c.openQualityFailure) return 'An inspection failed and the corrective action is still open';
      return c.auditPassed ? null : 'No inspection has passed yet';
    },
    hasStarted: (c) => has(c.auditCount),
  },
  {
    key: StageKey.ACTUAL_COSTING,
    order: 16,
    sheetName: 'Actual Costing_Coordinator',
    label: 'Actual Costing',
    purpose: 'What the order really cost, once it is made.',
    department: Department.FINANCE,
    whatYouEnter: [
      'What the warehouse actually issued, and its price',
      'Machine days and days in line',
      'External operation costs',
    ],
    tab: 'costing',
    isDoneWhen: (c) => c.hasCosting && has(c.costLineCount),
    missing: (c) =>
      c.hasCosting ? (has(c.costLineCount) ? null : 'Add the cost lines') : 'Start the costing',
    hasStarted: (c) => c.hasCosting,
  },
  {
    key: StageKey.DATABASE,
    order: 17,
    sheetName: 'Data-Base',
    label: 'Database',
    purpose:
      'Where this order came from and how it is stored — the identifiers you need when ' +
      'something has to be traced, checked or reported.',
    department: Department.ADMIN,
    whatYouEnter: ['Nothing — this is reference information about the order itself'],
    tab: 'database',
    /**
     * Informational. It has no work in it, so it is never the current step and
     * never counts towards progress — an order is not 6% finished because
     * somebody opened its metadata page. The workbook's own `Data-Base` sheet
     * is the same: a reference the other sheets read, not a task.
     */
    informational: true,
    missing: () => null,
  },
  {
    key: StageKey.INVOICE,
    order: 18,
    sheetName: 'Invoice',
    label: 'Invoice & Shipment',
    purpose: 'Booking the shipment and invoicing the customer.',
    department: Department.COORDINATOR,
    whatYouEnter: [
      'Carrier, tracking or container details',
      'The date it actually shipped',
    ],
    tab: 'invoice',
    isDoneWhen: (c) => c.shipmentBooked && has(c.shippedQty),
    missing: (c) => (c.shipmentBooked ? null : 'Book the shipment'),
    hasStarted: (c) => c.shipmentBooked || has(c.shippedQty),
  },
];

export const STEP_BY_KEY: Partial<Record<StageKey, OrderStepDef>> = Object.fromEntries(
  ORDER_STEPS.map((s) => [s.key, s]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Deriving where an order stands
// ─────────────────────────────────────────────────────────────────────────────

/** The six states a step can be in — the brief's §6 list. */
export const StepState = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING: 'WAITING',
  COMPLETED: 'COMPLETED',
  NOT_REQUIRED: 'NOT_REQUIRED',
  BLOCKED: 'BLOCKED',
} as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

export const STEP_STATE_STYLE: Record<StepState, { label: string; icon: string; tone: string }> = {
  COMPLETED:    { label: 'Done',         icon: '✓', tone: 'emerald' },
  IN_PROGRESS:  { label: 'In progress',  icon: '→', tone: 'blue' },
  WAITING:      { label: 'Waiting',      icon: '⏳', tone: 'amber' },
  BLOCKED:      { label: 'Blocked',      icon: '!', tone: 'red' },
  NOT_REQUIRED: { label: 'Not required', icon: '–', tone: 'slate' },
  NOT_STARTED:  { label: 'Not started',  icon: '○', tone: 'slate' },
};

export interface OrderStepState {
  key: StageKey;
  order: number;
  label: string;
  purpose: string;
  sheetName: string;
  department: Department;
  whatYouEnter: readonly string[];
  tab: string;
  state: StepState;
  /** What is still needed here, in one sentence. Null when nothing is. */
  missing: string | null;
  /** Why the step does not apply. */
  notRequiredReason: string | null;
  /** Free text somebody recorded against the step. */
  notes: string | null;
  completedAt: string | null;
  /** True when this is the step the order is actually on. */
  isCurrent: boolean;
  /** True when the system cannot decide on its own and a person must tick it. */
  manualCompletion: boolean;
  /** True for a reference page: never current, never counted in progress. */
  informational: boolean;
  taskTotal: number;
  taskCompleted: number;
}

export interface OrderStepsResult {
  steps: OrderStepState[];
  current: OrderStepState | null;
  next: OrderStepState | null;
  completedCount: number;
  applicableCount: number;
  /** Share of applicable steps completed, 0–100. */
  percentComplete: number;
}

/**
 * Work out the state of every step.
 *
 * The rules, in order of authority:
 *
 *   1. A person said it is not required → NOT_REQUIRED.
 *   2. The step does not apply to this order → NOT_REQUIRED.
 *   3. A person marked it complete, or the data says it is done → COMPLETED.
 *   4. A person set an explicit state (waiting, blocked) → that state.
 *   5. Something has been entered but it is not finished → IN_PROGRESS.
 *   6. Otherwise → NOT_STARTED.
 *
 * A person's explicit decision always beats a derivation. The system can see
 * that no cartons exist; only the packing supervisor knows the packing list is
 * waiting on a customer answer.
 */
export function deriveOrderSteps(ctx: StepContext, blockedSteps: ReadonlySet<StageKey> = new Set()): OrderStepsResult {
  const steps: OrderStepState[] = ORDER_STEPS.map((def) => {
    const override = ctx.overrides[def.key];
    const tasks = ctx.taskCounts[def.key] ?? { total: 0, completed: 0, overdue: 0 };
    const applies = def.appliesWhen ? def.appliesWhen(ctx) : true;
    const done = def.isDoneWhen ? def.isDoneWhen(ctx) : false;
    const missing = def.missing ? def.missing(ctx) : null;

    let state: StepState;
    let notRequiredReason: string | null = null;

    if (override?.status === StageStatus.NOT_REQUIRED) {
      state = StepState.NOT_REQUIRED;
      notRequiredReason = override.notRequiredReason ?? 'Marked as not required';
    } else if (!applies) {
      state = StepState.NOT_REQUIRED;
      notRequiredReason = def.notApplicableBecause ?? 'Does not apply to this order';
    } else if (override?.completedAt || override?.status === StageStatus.COMPLETED) {
      state = StepState.COMPLETED;
    } else if (done && !def.manualCompletion) {
      state = StepState.COMPLETED;
    } else if (blockedSteps.has(def.key)) {
      state = StepState.BLOCKED;
    } else if (override?.status === StageStatus.WAITING) {
      state = StepState.WAITING;
    } else if (override?.status === StageStatus.BLOCKED) {
      state = StepState.BLOCKED;
    } else if (
      override?.startedAt ||
      tasks.completed > 0 ||
      (def.hasStarted ? def.hasStarted(ctx) : false) ||
      (done && def.manualCompletion)
    ) {
      state = StepState.IN_PROGRESS;
    } else {
      state = StepState.NOT_STARTED;
    }

    return {
      key: def.key,
      order: def.order,
      label: def.label,
      purpose: def.purpose,
      sheetName: def.sheetName,
      department: def.department,
      whatYouEnter: def.whatYouEnter,
      tab: def.tab,
      state,
      missing: state === StepState.COMPLETED || state === StepState.NOT_REQUIRED ? null : missing,
      notRequiredReason,
      notes: override?.notes ?? null,
      completedAt: toIso(override?.completedAt),
      isCurrent: false,
      manualCompletion: def.manualCompletion === true,
      informational: def.informational === true,
      taskTotal: tasks.total,
      taskCompleted: tasks.completed,
    };
  });

  // The current step is the first one still outstanding. A blocked step is
  // still the current step — it is what the order is stuck on, and hiding it
  // behind the next unblocked step is how a blockage goes unattended.
  // An informational step is never outstanding work. The Database step is a
  // reference page; making it "current" would send a coordinator to read
  // metadata instead of doing the next real thing.
  const outstanding = steps.filter(
    (s) => !s.informational
      && s.state !== StepState.COMPLETED
      && s.state !== StepState.NOT_REQUIRED,
  );
  const current = outstanding[0] ?? null;
  if (current) current.isCurrent = true;
  const next = outstanding[1] ?? null;

  const applicable = steps.filter(
    (s) => !s.informational && s.state !== StepState.NOT_REQUIRED,
  );
  const completed = applicable.filter((s) => s.state === StepState.COMPLETED);

  return {
    steps,
    current,
    next,
    completedCount: completed.length,
    applicableCount: applicable.length,
    percentComplete: applicable.length === 0 ? 0 : Math.round((completed.length / applicable.length) * 100),
  };
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
