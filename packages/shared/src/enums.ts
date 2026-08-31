/**
 * Domain enums. Mirrored 1:1 in prisma/schema.prisma.
 * Kept as const objects (not TS `enum`) so they are plain values at runtime and
 * safe to import into the browser bundle.
 */

export const QtyLedger = {
  /** Main Order sheet — what the customer bought. */
  ORDER: 'ORDER',
  /** Stock_Packing sheet — usable finished goods deducted before cutting. */
  STOCK: 'STOCK',
  /** Cut Order sheet — planned/actual cut including the cut %. */
  CUT: 'CUT',
  /** Follow up → "Control ( In Line )" — sewn and inline-inspected. */
  IN_LINE: 'IN_LINE',
  /** Follow up → "Control ( Out Line )" — finished and endline-inspected. */
  OUT_LINE: 'OUT_LINE',
  /** Follow up → "Packing". */
  PACKED: 'PACKED',
  /** Shipment confirmed. */
  SHIPPED: 'SHIPPED',
  /** Follow up → "Second Degree" — B-grade / rejected. */
  SECOND_DEGREE: 'SECOND_DEGREE',
} as const;
export type QtyLedger = (typeof QtyLedger)[keyof typeof QtyLedger];

/** Ordered for funnel display: each stage is a subset of the one before it. */
export const LEDGER_FUNNEL: QtyLedger[] = [
  QtyLedger.ORDER,
  QtyLedger.CUT,
  QtyLedger.IN_LINE,
  QtyLedger.OUT_LINE,
  QtyLedger.PACKED,
  QtyLedger.SHIPPED,
];

export const LEDGER_LABEL: Record<QtyLedger, string> = {
  ORDER: 'Ordered',
  STOCK: 'From stock',
  CUT: 'Cut',
  IN_LINE: 'Produced (in-line)',
  OUT_LINE: 'Passed QC (out-line)',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  SECOND_DEGREE: 'Second degree',
};

export const StageKey = {
  CUSTOMER_ORDER_REF: 'CUSTOMER_ORDER_REF',
  ORDER_DETAILS: 'ORDER_DETAILS',
  MAIN_ORDER: 'MAIN_ORDER',
  /** The priced document sent to the customer before shipment. */
  PROFORMA_INVOICE: 'PROFORMA_INVOICE',
  PROGRESS_STATUS: 'PROGRESS_STATUS',
  CUT_ORDER: 'CUT_ORDER',
  LAYING_FABRIC: 'LAYING_FABRIC',
  BILL_OF_MATERIAL: 'BILL_OF_MATERIAL',
  CUSTOM_INSTRUCTIONS: 'CUSTOM_INSTRUCTIONS',
  EXTERNAL_ORDER: 'EXTERNAL_ORDER',
  STOCK: 'STOCK',
  FOLLOW_UP: 'FOLLOW_UP',
  PRODUCTION_FOLLOW_UP: 'PRODUCTION_FOLLOW_UP',
  PACKING: 'PACKING',
  AUDIT: 'AUDIT',
  ACTUAL_COSTING: 'ACTUAL_COSTING',
  /// The workbook's own `Data-Base` sheet, A20 of the menu: reference
  /// information about the order rather than work to be done.
  DATABASE: 'DATABASE',
  INVOICE: 'INVOICE',
  COMPLETED: 'COMPLETED',
} as const;
export type StageKey = (typeof StageKey)[keyof typeof StageKey];

/**
 * Stage weights for the overall progress roll-up. Not uniform: cutting and
 * production represent far more of an order's real completion than filling in
 * the customer reference tab. Weights sum to 100.
 */
export const STAGE_META: Record<
  StageKey,
  { order: number; label: string; weight: number; group: 'ORDER' | 'MATERIALS' | 'PRODUCTION' | 'DELIVERY' }
> = {
// `order` follows the workbook's own hyperlink menu — the factory's sequence,
// not ours. It is the same order as ORDER_STEPS in order-steps.ts, and the two
// are asserted equal by a test so they cannot drift apart.
//
// Weights sum to 100 and are deliberately uneven: production is most of an
// order's real completion, and filling in the customer reference tab is not.
  CUSTOMER_ORDER_REF:   { order: 1,  label: 'Customer Reference',      weight: 2,  group: 'ORDER' },
  ORDER_DETAILS:        { order: 2,  label: 'Order Details',            weight: 4,  group: 'ORDER' },
  MAIN_ORDER:           { order: 3,  label: 'Main Order',               weight: 4,  group: 'ORDER' },
  PROFORMA_INVOICE:     { order: 4,  label: 'Proforma Invoice',         weight: 2,  group: 'ORDER' },
  EXTERNAL_ORDER:       { order: 5,  label: 'External Order',           weight: 8,  group: 'PRODUCTION' },
  PROGRESS_STATUS:      { order: 6,  label: 'Progress Status',          weight: 1,  group: 'ORDER' },
  CUT_ORDER:            { order: 7,  label: 'Cut Order',                weight: 6,  group: 'MATERIALS' },
  LAYING_FABRIC:        { order: 8,  label: 'Laying Fabric',            weight: 8,  group: 'MATERIALS' },
  BILL_OF_MATERIAL:     { order: 9,  label: 'Bill of Material',         weight: 9,  group: 'MATERIALS' },
  CUSTOM_INSTRUCTIONS:  { order: 10, label: 'Custom Instructions',      weight: 3,  group: 'MATERIALS' },
  PACKING:              { order: 11, label: 'Packing',                  weight: 8,  group: 'DELIVERY' },
  STOCK:                { order: 12, label: 'Stock',                    weight: 3,  group: 'MATERIALS' },
  FOLLOW_UP:            { order: 13, label: 'Follow-up',                weight: 5,  group: 'PRODUCTION' },
  PRODUCTION_FOLLOW_UP: { order: 14, label: 'Production Follow-up',     weight: 18, group: 'PRODUCTION' },
  AUDIT:                { order: 15, label: 'Audit',                    weight: 10, group: 'DELIVERY' },
  ACTUAL_COSTING:       { order: 16, label: 'Actual Costing',           weight: 4,  group: 'DELIVERY' },
  /// Reference, not work: weight 0 so opening it cannot move an order's
  /// progress. It is step 17 because the workbook's menu puts it there.
  DATABASE:             { order: 17, label: 'Database',                 weight: 0,  group: 'ORDER' },
  INVOICE:              { order: 18, label: 'Invoice',                  weight: 3,  group: 'DELIVERY' },
  /// Not one of the eighteen. The workbook has no "completed" sheet; this is
  /// the terminal state an order reaches, kept because OrderStatus and the
  /// gate engine both refer to it.
  COMPLETED:            { order: 19, label: 'Completed / Shipped',      weight: 2,  group: 'DELIVERY' },
};

export const StageStatus = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING: 'WAITING',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  OVERDUE: 'OVERDUE',
  /** "This order does not need this step" — an answer, not an omission. */
  NOT_REQUIRED: 'NOT_REQUIRED',
} as const;
export type StageStatus = (typeof StageStatus)[keyof typeof StageStatus];

/**
 * How loudly a notification announces itself.
 *
 * Four levels rather than a boolean because a factory generates a great many
 * true statements a day, and a coordinator who is interrupted by all of them
 * stops reading any of them. The rules that assign these live in
 * `change-catalogue.ts`, next to the labels, so "which changes matter" is one
 * readable table rather than scattered `if` statements.
 */
export const NotificationPriority = {
  /** Worth recording, not worth interrupting anyone. A note, a comment. */
  LOW: 'LOW',
  /** The normal run of factory work: production, tasks, stock movements. */
  NORMAL: 'NORMAL',
  /** Somebody needs to know today: a delivery date, a shortage, a failure. */
  HIGH: 'HIGH',
  /** Something is going wrong: a cancellation, a failed audit, a blocked order. */
  URGENT: 'URGENT',
} as const;
export type NotificationPriority = (typeof NotificationPriority)[keyof typeof NotificationPriority];

/** Which part of the factory a change belongs to. Drives the What Changed filters. */
export const ChangeCategory = {
  ORDER: 'ORDER',
  PRODUCTION: 'PRODUCTION',
  INVENTORY: 'INVENTORY',
  MATERIALS: 'MATERIALS',
  TASKS: 'TASKS',
  QUALITY: 'QUALITY',
  SHIPMENT: 'SHIPMENT',
  APPROVALS: 'APPROVALS',
  DOCUMENTS: 'DOCUMENTS',
  ADMIN: 'ADMIN',
} as const;
export type ChangeCategory = (typeof ChangeCategory)[keyof typeof ChangeCategory];

/** Whether a notification email actually reached Microsoft 365. */
export const EmailStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;
export type EmailStatus = (typeof EmailStatus)[keyof typeof EmailStatus];

export const TaskStatus = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING: 'WAITING',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const Priority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const OrderStatus = {
  DRAFT: 'DRAFT',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  READY_FOR_PRODUCTION: 'READY_FOR_PRODUCTION',
  IN_PRODUCTION: 'IN_PRODUCTION',
  PRODUCTION_DELAYED: 'PRODUCTION_DELAYED',
  QUALITY_CHECK: 'QUALITY_CHECK',
  QUALITY_BLOCKED: 'QUALITY_BLOCKED',
  PACKING: 'PACKING',
  READY_TO_SHIP: 'READY_TO_SHIP',
  SHIPPED: 'SHIPPED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: 'Draft',
  WAITING_APPROVAL: 'Waiting for Approval',
  READY_FOR_PRODUCTION: 'Ready for Production',
  IN_PRODUCTION: 'In Production',
  PRODUCTION_DELAYED: 'Production Delayed',
  QUALITY_CHECK: 'Quality Check',
  QUALITY_BLOCKED: 'Quality Blocked',
  PACKING: 'Packing',
  READY_TO_SHIP: 'Ready to Ship',
  SHIPPED: 'Shipped',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Health colour per the brief: GREEN on track, YELLOW attention, RED late, BLUE waiting, GRAY not started. */
export const Health = {
  ON_TRACK: 'ON_TRACK',
  ATTENTION: 'ATTENTION',
  LATE: 'LATE',
  WAITING: 'WAITING',
  NOT_STARTED: 'NOT_STARTED',
} as const;
export type Health = (typeof Health)[keyof typeof Health];

export const Department = {
  COORDINATOR: 'COORDINATOR',
  FACTORY_MANAGER: 'FACTORY_MANAGER',
  PRODUCTION_MANAGER: 'PRODUCTION_MANAGER',
  CUTTING_MARKER: 'CUTTING_MARKER',
  WAREHOUSE: 'WAREHOUSE',
  EXTERNAL_OPS: 'EXTERNAL_OPS',
  PACKING: 'PACKING',
  QUALITY: 'QUALITY',
  FOLLOW_UP: 'FOLLOW_UP',
  FINANCE: 'FINANCE',
  ADMIN: 'ADMIN',
} as const;
export type Department = (typeof Department)[keyof typeof Department];

/** Department labels, with the Arabic term used in the workbook's Progress Status sheet. */
export const DEPARTMENT_LABEL: Record<Department, { en: string; ar: string }> = {
  COORDINATOR:        { en: 'Order Coordinator',  ar: 'منسق الأوردر' },
  FACTORY_MANAGER:    { en: 'Factory Manager',    ar: 'مدير المصنع' },
  PRODUCTION_MANAGER: { en: 'Production Manager', ar: 'مدير الإنتاج' },
  CUTTING_MARKER:     { en: 'Cutting & Marker',   ar: 'قسم القص والماركر' },
  WAREHOUSE:          { en: 'Warehouse',          ar: 'المخزن' },
  EXTERNAL_OPS:       { en: 'External Operations',ar: 'التشغيل الخارجي' },
  PACKING:            { en: 'Packing',            ar: 'قسم التعبئة' },
  QUALITY:            { en: 'Quality',            ar: 'مدير الجودة' },
  FOLLOW_UP:          { en: 'Follow-up Officer',  ar: 'مسئول المتابعة' },
  FINANCE:            { en: 'Finance',            ar: 'الحسابات' },
  ADMIN:              { en: 'Administrator',      ar: 'جميع القائمين على الأوردر' },
};

export const BomCategory = {
  FABRIC: 'FABRIC',
  THREAD: 'THREAD',
  LABEL: 'LABEL',
  TRANSFER: 'TRANSFER',
  BADGE: 'BADGE',
  LOGO: 'LOGO',
  SPONSOR: 'SPONSOR',
  SIZE: 'SIZE',
  POLY_BAG: 'POLY_BAG',
  BUTTER_PAPER: 'BUTTER_PAPER',
  STICKY_TAPE: 'STICKY_TAPE',
  BARCODE_PAPER: 'BARCODE_PAPER',
  HALF_BOX: 'HALF_BOX',
  CARTON: 'CARTON',
  TAPE: 'TAPE',
  ACCESSORY: 'ACCESSORY',
  OTHER: 'OTHER',
} as const;
export type BomCategory = (typeof BomCategory)[keyof typeof BomCategory];

export const ApprovalType = {
  PRINT_ARTWORK: 'PRINT_ARTWORK',
  EMBROIDERY: 'EMBROIDERY',
  COLOR: 'COLOR',
  SAMPLE: 'SAMPLE',
  LABEL: 'LABEL',
  PACKING: 'PACKING',
  PRODUCTION: 'PRODUCTION',
} as const;
export type ApprovalType = (typeof ApprovalType)[keyof typeof ApprovalType];

export const ApprovalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const ExternalOpStatus = {
  NOT_SENT: 'NOT_SENT',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  SENT: 'SENT',
  IN_PROGRESS: 'IN_PROGRESS',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
} as const;
export type ExternalOpStatus = (typeof ExternalOpStatus)[keyof typeof ExternalOpStatus];

export const ProductionOperation = {
  CUTTING: 'CUTTING',
  SEWING: 'SEWING',
  PRINTING: 'PRINTING',
  EMBROIDERY: 'EMBROIDERY',
  WASHING: 'WASHING',
  FINISHING: 'FINISHING',
  PACKING: 'PACKING',
} as const;
export type ProductionOperation = (typeof ProductionOperation)[keyof typeof ProductionOperation];

export const ShipmentStatus = {
  NOT_READY: 'NOT_READY',
  READY: 'READY',
  BOOKED: 'BOOKED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
} as const;
export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

export const AlertSeverity = {
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  ATTENTION: 'ATTENTION',
  OK: 'OK',
} as const;
export type AlertSeverity = (typeof AlertSeverity)[keyof typeof AlertSeverity];

export const AlertCode = {
  ORDER_OVERDUE: 'ORDER_OVERDUE',
  TASK_OVERDUE: 'TASK_OVERDUE',
  PRODUCTION_BEHIND: 'PRODUCTION_BEHIND',
  MATERIAL_SHORTAGE: 'MATERIAL_SHORTAGE',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  EXTERNAL_OP_LATE: 'EXTERNAL_OP_LATE',
  EXTERNAL_OP_BLOCKED: 'EXTERNAL_OP_BLOCKED',
  QUALITY_FAILED: 'QUALITY_FAILED',
  PACKING_INCOMPLETE: 'PACKING_INCOMPLETE',
  SHIP_DATE_APPROACHING: 'SHIP_DATE_APPROACHING',
  DELIVERY_DATE_APPROACHING: 'DELIVERY_DATE_APPROACHING',
  CUT_VARIANCE: 'CUT_VARIANCE',
  /** Stock exists but has not been reserved — a click, not a purchase order. */
  MATERIAL_UNRESERVED: 'MATERIAL_UNRESERVED',
  /** A stage cannot start because a requirement is unmet. */
  STAGE_BLOCKED: 'STAGE_BLOCKED',
  /** The floor used materially more or less than the BOM predicted. */
  CONSUMPTION_VARIANCE: 'CONSUMPTION_VARIANCE',
  /** A material is at or below its reorder level, factory-wide. */
  STOCK_LOW: 'STOCK_LOW',
} as const;
export type AlertCode = (typeof AlertCode)[keyof typeof AlertCode];

// ═══════════════════════════════════════════════════════════════════════════
// Inventory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What a material is. Drives which fields the form shows — a fabric has a width
 * and a composition, a carton has neither, and asking for both on every
 * material is how a materials list stops being filled in.
 */
export const MaterialType = {
  FABRIC: 'FABRIC',
  THREAD: 'THREAD',
  TRIM: 'TRIM',
  LABEL: 'LABEL',
  BUTTON: 'BUTTON',
  ZIPPER: 'ZIPPER',
  ELASTIC: 'ELASTIC',
  PRINT_TRANSFER: 'PRINT_TRANSFER',
  BADGE: 'BADGE',
  PACKAGING: 'PACKAGING',
  CARTON: 'CARTON',
  POLY_BAG: 'POLY_BAG',
  ACCESSORY: 'ACCESSORY',
  CHEMICAL: 'CHEMICAL',
  OTHER: 'OTHER',
} as const;
export type MaterialType = (typeof MaterialType)[keyof typeof MaterialType];

export const MATERIAL_TYPE_LABEL: Record<MaterialType, string> = {
  FABRIC: 'Fabric',
  THREAD: 'Thread',
  TRIM: 'Trim',
  LABEL: 'Label',
  BUTTON: 'Button',
  ZIPPER: 'Zipper',
  ELASTIC: 'Elastic',
  PRINT_TRANSFER: 'Print / transfer',
  BADGE: 'Badge',
  PACKAGING: 'Packaging',
  CARTON: 'Carton',
  POLY_BAG: 'Poly bag',
  ACCESSORY: 'Accessory',
  CHEMICAL: 'Chemical',
  OTHER: 'Other',
};

/**
 * Which material types carry which optional fields. The material form renders
 * from this rather than showing every field to everyone — §8's "do not force
 * irrelevant fields on every material type".
 */
export const MATERIAL_TYPE_FIELDS: Record<MaterialType, readonly string[]> = {
  FABRIC:         ['colorName', 'widthCm', 'composition', 'gsm', 'supplierName', 'batchLot'],
  THREAD:         ['colorName', 'composition', 'supplierName'],
  TRIM:           ['colorName', 'sizeLabel', 'supplierName'],
  LABEL:          ['sizeLabel', 'supplierName'],
  BUTTON:         ['colorName', 'sizeLabel', 'supplierName'],
  ZIPPER:         ['colorName', 'sizeLabel', 'supplierName'],
  ELASTIC:        ['colorName', 'widthCm', 'supplierName'],
  PRINT_TRANSFER: ['colorName', 'supplierName'],
  BADGE:          ['colorName', 'supplierName'],
  PACKAGING:      ['sizeLabel', 'supplierName'],
  CARTON:         ['sizeLabel', 'supplierName'],
  POLY_BAG:       ['sizeLabel', 'supplierName'],
  ACCESSORY:      ['colorName', 'sizeLabel', 'supplierName'],
  CHEMICAL:       ['supplierName', 'batchLot'],
  OTHER:          ['supplierName'],
};

/** Every way stock can move. The ledger is append-only; nothing is ever edited. */
export const MovementType = {
  /** Goods in from a supplier or another factory. */
  RECEIPT: 'RECEIPT',
  /** Out to production against an order. */
  ISSUE: 'ISSUE',
  /** Unused material coming back from the floor. */
  RETURN: 'RETURN',
  /** A stock count correcting the book figure. Signed. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Damaged, soiled or off-cut beyond use. */
  WASTAGE: 'WASTAGE',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
} as const;
export type MovementType = (typeof MovementType)[keyof typeof MovementType];

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  RECEIPT: 'Receipt',
  ISSUE: 'Issued to production',
  RETURN: 'Returned unused',
  ADJUSTMENT: 'Stock adjustment',
  WASTAGE: 'Wastage',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
};

export const StockStatus = {
  OK: 'OK',
  LOW: 'LOW',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  /** More is reserved than exists — an order is planned on fabric that is not there. */
  OVER_RESERVED: 'OVER_RESERVED',
} as const;
export type StockStatus = (typeof StockStatus)[keyof typeof StockStatus];

export const ReservationStatus = {
  ACTIVE: 'ACTIVE',
  /** Fully drawn down by issues. */
  FULFILLED: 'FULFILLED',
  /** Given back to the pool without being issued. */
  RELEASED: 'RELEASED',
  CANCELLED: 'CANCELLED',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

/** Units of measure. Conversions are deliberately NOT implicit — see `convertQty`. */
export const UnitOfMeasure = {
  M: 'M',
  CM: 'CM',
  YD: 'YD',
  KG: 'KG',
  G: 'G',
  PCS: 'PCS',
  DZN: 'DZN',
  ROLL: 'ROLL',
  CONE: 'CONE',
  SET: 'SET',
  BOX: 'BOX',
  L: 'L',
} as const;
export type UnitOfMeasure = (typeof UnitOfMeasure)[keyof typeof UnitOfMeasure];
