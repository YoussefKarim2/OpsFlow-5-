/**
 * What a change *means* — the catalogue that turns a database diff into a
 * sentence a person in the factory can act on.
 *
 * The audit middleware knows that `orders.promisedShippingDate` went from
 * `2026-09-03T00:00:00.000Z` to `2026-09-05T00:00:00.000Z`. That is the right
 * thing to keep forever and the wrong thing to put in front of a coordinator.
 * This module is the translation: a column name becomes "Promised shipping
 * date", an ISO timestamp becomes "5 September 2026", and the fact that a
 * delivery date moved becomes HIGH priority rather than one row among forty.
 *
 * It lives in `@opsflow/shared` for the reason everything else does: the API
 * writes the notification and the web client renders the timeline, and the two
 * must not label the same change differently.
 *
 * Nothing here reads the database or sends anything. It is a pure description
 * of meaning, so it can be tested by value.
 */

import { NotificationPriority, ChangeCategory } from './enums.js';

// ─────────────────────────────────────────────────────────────────────────────
// Which models produce a change event, and what to call them
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackedModel {
  /** Which part of the factory this belongs to, for filtering. */
  category: ChangeCategory;
  /** Singular, in the words the factory uses. "Production record", not "ProductionRecord". */
  label: string;
  /** Verb for a create, when creating the record *is* the event. */
  createdVerb?: string;
  /** Verb for a delete. */
  deletedVerb?: string;
  /**
   * True when the record being created is itself the news — a production
   * record, a stock movement, an uploaded document. False for models where
   * only later edits matter.
   */
  createIsAnEvent: boolean;
  /** Floor for this model's priority, before any per-field rule raises it. */
  basePriority: NotificationPriority;
}

/**
 * Every model whose changes are worth telling people about.
 *
 * A model absent from this table produces no change event, no notification and
 * no email. That is the whole of the "do not track read-only actions" rule
 * (§5): reads never reach the middleware in the first place, and writes to
 * anything not listed here are recorded in the audit trail and go no further.
 */
export const TRACKED_MODELS: Readonly<Record<string, TrackedModel>> = {
  Order: {
    category: ChangeCategory.ORDER, label: 'Order',
    createdVerb: 'created', deletedVerb: 'deleted',
    createIsAnEvent: true, basePriority: NotificationPriority.NORMAL,
  },
  OrderStage: {
    category: ChangeCategory.ORDER, label: 'Order step',
    createIsAnEvent: false, basePriority: NotificationPriority.LOW,
  },
  // NOTE: `StageQuantity` is deliberately absent. The matrix is written cell by
  // cell with `upsert`, which the middleware does not intercept — and forty
  // cells is the wrong grain anyway. "Ordered quantity: 1,972 → 2,100" is the
  // change a person cares about, and the matrix route announces exactly that
  // with `announceChange`. `Order` below carries it.
  ProformaInvoice: {
    category: ChangeCategory.ORDER, label: 'Proforma invoice',
    createdVerb: 'created', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  CustomInstruction: {
    category: ChangeCategory.ORDER, label: 'Custom instruction',
    createdVerb: 'added', deletedVerb: 'removed',
    createIsAnEvent: true, basePriority: NotificationPriority.NORMAL,
  },

  BomItem: {
    category: ChangeCategory.MATERIALS, label: 'BOM line',
    createdVerb: 'added', deletedVerb: 'removed',
    createIsAnEvent: true, basePriority: NotificationPriority.NORMAL,
  },
  Material: {
    category: ChangeCategory.INVENTORY, label: 'Material',
    createdVerb: 'added', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  // NOTE: `MaterialStock` is deliberately absent too, for a different reason.
  // Its `physicalQty` is a running balance behind the MaterialMovement ledger,
  // and the movement is already announced with its type and quantity. Tracking
  // both would send two messages for one event — and would add a read to every
  // Serializable stock transaction, which is the last place to add contention.
  MaterialMovement: {
    category: ChangeCategory.INVENTORY, label: 'Stock movement',
    createdVerb: 'recorded', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  MaterialReservation: {
    category: ChangeCategory.MATERIALS, label: 'Material reservation',
    createdVerb: 'made', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  MaterialIssue: {
    category: ChangeCategory.MATERIALS, label: 'Material issue',
    createdVerb: 'recorded', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  StockRecord: {
    category: ChangeCategory.INVENTORY, label: 'Finished stock',
    createdVerb: 'recorded', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },

  ProductionRecord: {
    category: ChangeCategory.PRODUCTION, label: 'Production',
    createdVerb: 'recorded', deletedVerb: 'removed',
    createIsAnEvent: true, basePriority: NotificationPriority.NORMAL,
  },
  CuttingRecord: {
    category: ChangeCategory.PRODUCTION, label: 'Cutting',
    createdVerb: 'recorded', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  Marker: {
    category: ChangeCategory.PRODUCTION, label: 'Marker / lay',
    createdVerb: 'added', createIsAnEvent: true,
    basePriority: NotificationPriority.LOW,
  },
  ExternalOperation: {
    category: ChangeCategory.PRODUCTION, label: 'External operation',
    createdVerb: 'created', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },

  Task: {
    category: ChangeCategory.TASKS, label: 'Task',
    createdVerb: 'created', createIsAnEvent: false,
    basePriority: NotificationPriority.LOW,
  },
  TaskComment: {
    category: ChangeCategory.TASKS, label: 'Task comment',
    createdVerb: 'added', createIsAnEvent: true,
    basePriority: NotificationPriority.LOW,
  },

  QualityAudit: {
    category: ChangeCategory.QUALITY, label: 'Quality audit',
    createdVerb: 'recorded', createIsAnEvent: true,
    basePriority: NotificationPriority.HIGH,
  },
  QualityDefect: {
    category: ChangeCategory.QUALITY, label: 'Quality defect',
    createdVerb: 'recorded', createIsAnEvent: true,
    basePriority: NotificationPriority.HIGH,
  },

  PackingList: {
    category: ChangeCategory.SHIPMENT, label: 'Packing list',
    createdVerb: 'created', createIsAnEvent: true,
    basePriority: NotificationPriority.NORMAL,
  },
  Carton: {
    category: ChangeCategory.SHIPMENT, label: 'Carton',
    createIsAnEvent: false, basePriority: NotificationPriority.LOW,
  },
  Shipment: {
    category: ChangeCategory.SHIPMENT, label: 'Shipment',
    createdVerb: 'booked', createIsAnEvent: true,
    basePriority: NotificationPriority.HIGH,
  },

  Approval: {
    category: ChangeCategory.APPROVALS, label: 'Approval',
    createdVerb: 'requested', createIsAnEvent: true,
    basePriority: NotificationPriority.HIGH,
  },

  Attachment: {
    category: ChangeCategory.DOCUMENTS, label: 'Document',
    createdVerb: 'uploaded', deletedVerb: 'removed',
    createIsAnEvent: true, basePriority: NotificationPriority.LOW,
  },

  CostingRecord: {
    category: ChangeCategory.ORDER, label: 'Costing',
    createIsAnEvent: false, basePriority: NotificationPriority.LOW,
  },

  User: {
    category: ChangeCategory.ADMIN, label: 'User account',
    createdVerb: 'created', deletedVerb: 'deleted',
    createIsAnEvent: true, basePriority: NotificationPriority.HIGH,
  },
  Role: {
    category: ChangeCategory.ADMIN, label: 'Role',
    createIsAnEvent: false, basePriority: NotificationPriority.HIGH,
  },
};

export function trackedModel(model: string): TrackedModel | null {
  return TRACKED_MODELS[model] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field labels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column name → what the factory calls it.
 *
 * Anything not listed falls back to a de-camel-cased version, which is right
 * often enough ("orderName" → "Order name") that listing every column would be
 * more maintenance than value. The ones here are the ones where the automatic
 * answer would be wrong or unhelpful.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  poNumber: 'PO number',
  clientId: 'Client',
  coordinatorId: 'Coordinator',
  outsideWorkManagerId: 'Outside-work manager',
  factoryId: 'Factory',
  externalFactoryId: 'External factory',
  pricePerPieceUsd: 'Price per piece (USD)',
  cutPercentage: 'Cut allowance',
  accessoryPercentage: 'Accessory allowance',
  promisedShippingDate: 'Promised shipping date',
  requiredDeliveryDate: 'Required delivery date',
  actualShippingDate: 'Actual shipping date',
  fabricDeliveryToSupplier: 'Fabric delivery to supplier',
  supplierDeliveryDate: 'Supplier delivery date',
  qty: 'Quantity',
  requiredQty: 'Required quantity',
  issuedQty: 'Issued quantity',
  availableQty: 'Available quantity',
  physicalQty: 'Physical stock',
  consumedQty: 'Consumed quantity',
  minimumQty: 'Minimum stock',
  statusOverride: 'Step status',
  notRequiredReason: 'Reason not required',
  roleId: 'Role',
  isSuperAdmin: 'Super administrator',
  active: 'Account active',
  mustChangePassword: 'Must change password',
  passwordHash: 'Password',
  markerLengthM: 'Marker length (m)',
  totalLengthM: 'Total length (m)',
  grossWeightKg: 'Gross weight (kg)',
  netWeightKg: 'Net weight (kg)',
  externalWorkSort: 'External work type',
  externalWorkType: 'External work description',
  correctiveActionClosed: 'Corrective action closed',
  sizeRatio: 'Size ratio',
  cartonNumber: 'Carton number',
  awbNumber: 'AWB number',
  containerSeal: 'Container / seal',
  vesselVoyage: 'Vessel / voyage',
  trackingNumber: 'Tracking number',
  sentAt: 'Sent to customer',
  bomItemId: 'BOM line',
  materialId: 'Material',
  orderId: 'Order',
  storageKey: 'Stored file',
};

/** Columns nobody wants to read about, even when they genuinely changed. */
export const NOISE_FIELDS: ReadonlySet<string> = new Set([
  'updatedAt', 'createdAt', 'cachedProgressPct', 'cachedStatus', 'cachedStageKey',
  'lastLoginAt', 'failedLoginCount', 'lockedUntil', 'position', 'position_',
  'sequence', 'storageDriver', 'checksum', 'requestId',
]);

export function fieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  // orderName → "Order name"; poDate → "Po date" (rare enough to accept).
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Value formatting
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Turn a stored value into something readable, without ever inventing one.
 *
 * `null` stays null all the way to the screen, where it renders as "not set".
 * The workbook this system replaces was full of cells that showed `0` when they
 * meant "nobody entered anything", and that ambiguity is exactly what a change
 * log must not reproduce.
 */
export function formatValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (v === '') return null;

  if (ISO_DATE.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
  }

  if (v === 'true') return 'Yes';
  if (v === 'false') return 'No';

  // A stored decimal such as "1194.0000" reads better as 1,194.
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return Number.isInteger(n)
        ? n.toLocaleString('en-GB')
        : n.toLocaleString('en-GB', { maximumFractionDigits: 4 });
    }
  }

  // SCREAMING_SNAKE enums read as words: PRODUCTION_DELAYED → "Production delayed".
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(v)) {
    const words = v.replace(/_/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // A cuid is an id, not information. Say so rather than showing it.
  if (/^c[a-z0-9]{24,}$/.test(v)) return null;

  return v.length > 200 ? `${v.slice(0, 197)}…` : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<NotificationPriority, number> = {
  LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3,
};

export function highestPriority(
  priorities: readonly NotificationPriority[],
): NotificationPriority {
  return priorities.reduce<NotificationPriority>(
    (best, p) => (PRIORITY_RANK[p] > PRIORITY_RANK[best] ? p : best),
    NotificationPriority.LOW,
  );
}

export function priorityRank(p: NotificationPriority): number {
  return PRIORITY_RANK[p];
}

/**
 * Fields whose movement is news regardless of which model they sit on.
 *
 * A delivery date is the single most consequential thing on an order — the
 * whole factory plans against it — so it is HIGH wherever it appears. The
 * others follow the same test: would somebody want to be interrupted?
 */
const FIELD_PRIORITY: Readonly<Record<string, NotificationPriority>> = {
  requiredDeliveryDate: NotificationPriority.HIGH,
  promisedShippingDate: NotificationPriority.HIGH,
  actualShippingDate: NotificationPriority.HIGH,
  cancelled: NotificationPriority.URGENT,
  cancelledReason: NotificationPriority.URGENT,
  result: NotificationPriority.HIGH,
  status: NotificationPriority.NORMAL,
  priority: NotificationPriority.NORMAL,
  active: NotificationPriority.HIGH,
  isSuperAdmin: NotificationPriority.URGENT,
  permissions: NotificationPriority.URGENT,
  roleId: NotificationPriority.HIGH,
  passwordHash: NotificationPriority.HIGH,
  overrideApproved: NotificationPriority.HIGH,
  coordinatorId: NotificationPriority.NORMAL,
};

/**
 * Values that mean something has gone wrong, whatever field they arrive in.
 * A quality audit changing its result to FAIL is not a normal status change.
 */
const URGENT_VALUES: ReadonlySet<string> = new Set([
  'FAIL', 'QUALITY_BLOCKED', 'CANCELLED', 'PRODUCTION_DELAYED', 'REJECTED',
]);

export interface FieldChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * How loudly to announce one change set.
 *
 * The model's floor, raised by any field rule, raised again by a value that
 * means trouble. Never lowered — a batch that contains one urgent change is an
 * urgent batch, because the person reading it needs to see the urgent part.
 */
export function derivePriority(
  model: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  fields: readonly FieldChange[],
): NotificationPriority {
  const tracked = trackedModel(model);
  const candidates: NotificationPriority[] = [
    tracked?.basePriority ?? NotificationPriority.NORMAL,
  ];

  // Deleting a record is always at least as serious as editing one.
  if (action === 'DELETE') candidates.push(NotificationPriority.HIGH);

  for (const f of fields) {
    const byField = FIELD_PRIORITY[f.field];
    if (byField) candidates.push(byField);
    if (f.newValue && URGENT_VALUES.has(f.newValue.toUpperCase())) {
      candidates.push(NotificationPriority.URGENT);
    }
  }

  return highestPriority(candidates);
}

// ─────────────────────────────────────────────────────────────────────────────
// The sentence
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeSummaryInput {
  model: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  /** "PO 13506", "Rosetta Jersey — White". What the change happened *to*. */
  subject: string | null;
  fields: readonly FieldChange[];
}

/**
 * One line describing the whole change set.
 *
 * Deliberately short — it is a notification title and an email subject, and
 * both are read in a list. The detail goes in the field rows underneath.
 */
export function summariseChange(input: ChangeSummaryInput): string {
  const tracked = trackedModel(input.model);
  const label = tracked?.label ?? input.model;
  const subject = input.subject ? ` ${input.subject}` : '';

  if (input.action === 'CREATE') {
    return `${label}${subject} ${tracked?.createdVerb ?? 'created'}`;
  }
  if (input.action === 'DELETE') {
    return `${label}${subject} ${tracked?.deletedVerb ?? 'deleted'}`;
  }

  const named = input.fields.filter((f) => !NOISE_FIELDS.has(f.field));
  const [first, second] = named;
  if (!first) return `${label}${subject} updated`;
  if (!second) return `${label}${subject}: ${first.label.toLowerCase()} changed`;
  if (named.length === 2) {
    return `${label}${subject}: ${first.label.toLowerCase()} and ` +
           `${second.label.toLowerCase()} changed`;
  }
  return `${label}${subject}: ${named.length} fields changed`;
}

/** "300 → 350", or a plain statement when only one side is known. */
export function describeFieldChange(f: FieldChange): string {
  const before = formatValue(f.oldValue);
  const after = formatValue(f.newValue);

  if (before != null && after != null) return `${f.label}: ${before} → ${after}`;
  if (after != null) return `${f.label} set to ${after}`;
  if (before != null) return `${f.label} cleared (was ${before})`;
  return `${f.label} changed`;
}

export const PRIORITY_STYLE: Record<NotificationPriority, {
  label: string; dot: string; tone: string; emailColor: string;
}> = {
  URGENT: { label: 'Urgent', dot: '🔴', tone: 'red',     emailColor: '#dc2626' },
  HIGH:   { label: 'High',   dot: '🟠', tone: 'orange',  emailColor: '#ea580c' },
  NORMAL: { label: 'Normal', dot: '🟡', tone: 'amber',   emailColor: '#ca8a04' },
  LOW:    { label: 'Low',    dot: '🟢', tone: 'emerald', emailColor: '#16a34a' },
};

export const CATEGORY_LABEL: Record<ChangeCategory, string> = {
  ORDER: 'Orders',
  PRODUCTION: 'Production',
  INVENTORY: 'Inventory',
  MATERIALS: 'Materials',
  TASKS: 'Tasks',
  QUALITY: 'Quality',
  SHIPMENT: 'Shipment',
  APPROVALS: 'Approvals',
  DOCUMENTS: 'Documents',
  ADMIN: 'Administration',
};
