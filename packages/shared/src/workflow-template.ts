/**
 * The workflow template — a direct transcription of `Progress Status!C8:I34`.
 *
 * This is the most important thing in the workbook and the thing most easily
 * lost in a rewrite. Twenty-seven rows, each `(tab, responsible role, estimated
 * duration, required work, sequence)`. It is the factory's actual process,
 * written down by the people who run it.
 *
 * Every new order materialises these into real Task rows with owners and due
 * dates derived from the PO date and the sequence group.
 */

import { StageKey, Department, Priority } from './enums.js';

export interface TaskTemplate {
  /** Stable key so seeds are idempotent and templates can be edited without duplicating tasks. */
  key: string;
  stageKey: StageKey;
  department: Department;
  /** English task title. */
  title: string;
  /** The original Arabic requirement text from column H, preserved verbatim. */
  requirementAr: string;
  /** English rendering of the requirement. */
  requirementEn: string;
  /** Column E — estimated minutes. */
  estimatedMinutes: number;
  /** Column I — the sequence group. Tasks in group N may start when group N−1 is done. */
  sequence: number;
  priority: Priority;
  /** Blocks progress of the whole order when overdue. */
  critical: boolean;
}

export const WORKFLOW_TEMPLATE: TaskTemplate[] = [
  // ── Sequence 1 — Factory Manager opens the order ────────────────────────
  {
    key: 'FM_CUSTOMER_REF', stageKey: StageKey.CUSTOMER_ORDER_REF, department: Department.FACTORY_MANAGER,
    title: 'Attach approved customer order reference',
    requirementAr: 'إضافة صورة أوردر العميل المرسلة من CEO بعد الموافقة عليها',
    requirementEn: 'Attach the customer order image sent by the CEO after approval.',
    estimatedMinutes: 5, sequence: 1, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'FM_ORDER_DETAILS', stageKey: StageKey.ORDER_DETAILS, department: Department.FACTORY_MANAGER,
    title: 'Assign coordinator and enter core order details',
    requirementAr: 'اختيار منسق الأوردر إضافة تفاصيل وتعليمات الاوردر الأساسية وسعر القطعة',
    requirementEn: 'Choose the order coordinator, add the basic order details and instructions, and the unit price.',
    estimatedMinutes: 10, sequence: 1, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'FM_MAIN_ORDER', stageKey: StageKey.MAIN_ORDER, department: Department.FACTORY_MANAGER,
    title: 'Enter sizes and quantities',
    requirementAr: 'إضافة المقاسات والكميات',
    requirementEn: 'Add the sizes and quantities.',
    estimatedMinutes: 10, sequence: 1, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'FM_CUSTOM_INSTR', stageKey: StageKey.CUSTOM_INSTRUCTIONS, department: Department.FACTORY_MANAGER,
    title: 'Record numbering and special instructions',
    requirementAr: 'في حالة وجود ارقام على التيشرتات او تعليمات خاصة يقوم بإضافتها في هذا التبويب',
    requirementEn: 'If there is shirt numbering or any special instruction, record it here.',
    estimatedMinutes: 10, sequence: 1, priority: Priority.MEDIUM, critical: false,
  },

  // ── Sequence 2 — Coordinator reviews and sets parameters ────────────────
  {
    key: 'CO_REVIEW_REF', stageKey: StageKey.CUSTOMER_ORDER_REF, department: Department.COORDINATOR,
    title: 'Review customer order reference',
    requirementAr: 'مراجعة الاوردر',
    requirementEn: 'Review the order.',
    estimatedMinutes: 5, sequence: 2, priority: Priority.HIGH, critical: false,
  },
  {
    key: 'CO_REVIEW_MAIN', stageKey: StageKey.MAIN_ORDER, department: Department.COORDINATOR,
    title: 'Review the quantity matrix',
    requirementAr: 'مراجعة الاوردر',
    requirementEn: 'Review the order.',
    estimatedMinutes: 10, sequence: 2, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'CO_SET_PARAMS', stageKey: StageKey.ORDER_DETAILS, department: Department.COORDINATOR,
    title: 'Set cut %, confirm shipping address, record customer notes',
    requirementAr: 'تحديد نسبة القص المناسبة والتأكيد على عنوان الشحن واضافة تعليقات العميل الخاصة بالأوردر ( تشغيل - خامات - تعبئة ....الخ )',
    requirementEn: 'Set the appropriate cut percentage, confirm the shipping address, and add the customer comments for the order (production, materials, packing, etc.).',
    estimatedMinutes: 10, sequence: 2, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'CO_STOCK', stageKey: StageKey.STOCK, department: Department.COORDINATOR,
    title: 'Record usable finished-goods stock',
    requirementAr: 'إضافة مخزون المنتج التام (إن وجد)',
    requirementEn: 'Add finished-product stock, if any.',
    estimatedMinutes: 10, sequence: 2, priority: Priority.MEDIUM, critical: false,
  },
  {
    key: 'CO_CUT_ORDER', stageKey: StageKey.CUT_ORDER, department: Department.COORDINATOR,
    title: 'Verify cut order after stock deduction',
    requirementAr: 'التأكد من تفاصيل الاوردر بعد خصم المخزون (إن وجد)',
    requirementEn: 'Verify the order details after deducting stock, if any.',
    estimatedMinutes: 5, sequence: 2, priority: Priority.HIGH, critical: true,
  },

  // ── Sequence 3 — Cutting & Marker plus BOM ──────────────────────────────
  {
    key: 'CM_CUT_RATIOS', stageKey: StageKey.LAYING_FABRIC, department: Department.CUTTING_MARKER,
    title: 'Set cut ratios and real consumption per marker',
    requirementAr: 'تحديد نسب القص والاستهلاكات الفعلية لكل ماركر',
    requirementEn: 'Determine the cut ratios and the actual consumption for each marker.',
    estimatedMinutes: 35, sequence: 3, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'CM_BOM_FABRIC', stageKey: StageKey.BILL_OF_MATERIAL, department: Department.CUTTING_MARKER,
    title: 'Add actual fabric consumption for warehouse issue',
    requirementAr: 'إضافة استهلاكات الفعلية للقماش ليتم صرفها من المخزن',
    requirementEn: 'Add the actual fabric consumption so it can be issued from the warehouse.',
    estimatedMinutes: 20, sequence: 3, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'CO_BOM_ACCESSORIES', stageKey: StageKey.BILL_OF_MATERIAL, department: Department.COORDINATOR,
    title: 'Add accessories and raise POs for shortfalls',
    requirementAr: 'إضافة الاكسسوارات اللازمة للأوردر ومواصفاتها وكمياتها وعمل اوردر شراء للكميات الغير متوفرة',
    requirementEn: 'Add the accessories required for the order with their specifications and quantities, and raise a purchase order for anything unavailable.',
    estimatedMinutes: 30, sequence: 3, priority: Priority.HIGH, critical: true,
  },

  // ── Sequence 4 — External operations set-up, real markers ───────────────
  {
    key: 'EX_INSTRUCTIONS', stageKey: StageKey.ORDER_DETAILS, department: Department.EXTERNAL_OPS,
    title: 'Add external work instructions, reference and prices',
    requirementAr: 'إضافة التعليمات الخاصة بتشغيل الاوردر خارجيا و إضافة المرجع للأوردر وأسعار التشغيل الخارجي',
    requirementEn: 'Add the instructions for running the order externally, the order reference, and the external operation prices.',
    estimatedMinutes: 15, sequence: 4, priority: Priority.HIGH, critical: false,
  },
  {
    key: 'CM_REAL_MARKERS', stageKey: StageKey.LAYING_FABRIC, department: Department.CUTTING_MARKER,
    title: 'Produce the real markers per spread and cut instructions',
    requirementAr: 'عمل المراكر الفعلية للأوردر وفقا لتعليمات الفرش والقص',
    requirementEn: 'Produce the actual markers for the order according to the spread and cut instructions.',
    estimatedMinutes: 35, sequence: 4, priority: Priority.HIGH, critical: true,
  },

  // ── Sequence 5 — Release to the external factory ────────────────────────
  {
    key: 'EX_SEND_ORDER', stageKey: StageKey.EXTERNAL_ORDER, department: Department.EXTERNAL_OPS,
    title: 'Verify and send the print / embroidery order',
    requirementAr: 'التأكد من تفاصيل الاوردر وارسال أوردر التشغيل الخارجي للطباعة او التطريز',
    requirementEn: 'Verify the order details and send the external operation order for printing or embroidery.',
    estimatedMinutes: 15, sequence: 5, priority: Priority.URGENT, critical: true,
  },
  {
    key: 'EX_SPECIAL_DETAILS', stageKey: StageKey.CUSTOM_INSTRUCTIONS, department: Department.EXTERNAL_OPS,
    title: 'Extract special details and send with the external order',
    requirementAr: 'مراجعة التفاصيل الخاصة واستخراجها وارسالها مع أوردر التشغيل الخارجي للطباعة او التطريز',
    requirementEn: 'Review the special details, extract them, and send them with the external printing or embroidery order.',
    estimatedMinutes: 20, sequence: 5, priority: Priority.HIGH, critical: false,
  },

  // ── Sequence 6 — Coordinator verifies external ──────────────────────────
  {
    key: 'CO_VERIFY_EXTERNAL', stageKey: StageKey.EXTERNAL_ORDER, department: Department.COORDINATOR,
    title: 'Verify external order details',
    requirementAr: 'التأكد من تفاصيل الاوردر',
    requirementEn: 'Verify the order details.',
    estimatedMinutes: 15, sequence: 6, priority: Priority.HIGH, critical: false,
  },

  // ── Sequence 7 — Warehouse issues materials ─────────────────────────────
  {
    key: 'WH_ISSUE_MATERIALS', stageKey: StageKey.BILL_OF_MATERIAL, department: Department.WAREHOUSE,
    title: 'Issue materials and record issuer / receiver',
    requirementAr: 'إضافة ماتم صرفه من المخزن وتحديد المسلم والمستلم لحجز الاكسسوارات الخاصة بكل موديل',
    requirementEn: 'Record what has been issued from the store and set the issuer and receiver, to reserve the accessories for each style.',
    estimatedMinutes: 30, sequence: 7, priority: Priority.URGENT, critical: true,
  },

  // ── Sequence 8 — Daily tracking begins ──────────────────────────────────
  {
    key: 'FU_DAILY_DETAIL', stageKey: StageKey.FOLLOW_UP, department: Department.FOLLOW_UP,
    title: 'Enter daily order detail',
    requirementAr: 'إضافة تفاصيل الاوردر اليومية',
    requirementEn: 'Add the daily order details.',
    estimatedMinutes: 35, sequence: 8, priority: Priority.HIGH, critical: false,
  },
  {
    key: 'PM_DAILY_PRODUCTION', stageKey: StageKey.PRODUCTION_FOLLOW_UP, department: Department.PRODUCTION_MANAGER,
    title: 'Record daily production output',
    requirementAr: 'تسجيل الإنتاج اليومي',
    requirementEn: 'Record the daily production output.',
    estimatedMinutes: 5, sequence: 8, priority: Priority.HIGH, critical: true,
  },

  // ── Sequence 9 — Coordinator monitors and escalates ─────────────────────
  {
    key: 'CO_TRACK_ESCALATE', stageKey: StageKey.FOLLOW_UP, department: Department.COORDINATOR,
    title: 'Track order status and escalate deviations',
    requirementAr: 'متابعة موقف الاوردر وإبلاغ مدير المصنع في حالة أي انحراف في الاوردر في أي مرحلة',
    requirementEn: 'Follow the order status and notify the factory manager of any deviation at any stage.',
    estimatedMinutes: 20, sequence: 9, priority: Priority.HIGH, critical: true,
  },

  // ── Sequence 10–11 — Packing ────────────────────────────────────────────
  {
    key: 'PK_BUILD_LIST', stageKey: StageKey.PACKING, department: Department.PACKING,
    title: 'Build the packing list',
    requirementAr: 'عمل باكينج ليست',
    requirementEn: 'Create the packing list.',
    estimatedMinutes: 35, sequence: 10, priority: Priority.HIGH, critical: true,
  },
  {
    key: 'CO_REVIEW_PACKING', stageKey: StageKey.PACKING, department: Department.COORDINATOR,
    title: 'Review and approve the packing list',
    requirementAr: 'مراجعة الباكينج لست',
    requirementEn: 'Review the packing list.',
    estimatedMinutes: 15, sequence: 11, priority: Priority.HIGH, critical: true,
  },

  // ── Sequence 12 — Quality ───────────────────────────────────────────────
  {
    key: 'QA_FINAL_AUDIT', stageKey: StageKey.AUDIT, department: Department.QUALITY,
    title: 'Perform the R02 final inspection and audit',
    requirementAr: 'عمل تقرير الفحص النهائي R02',
    requirementEn: 'Carry out the R02 final inspection and audit report.',
    estimatedMinutes: 10, sequence: 12, priority: Priority.URGENT, critical: true,
  },

  // ── Sequence 13 — Costing ───────────────────────────────────────────────
  {
    key: 'WH_COSTING_ISSUES', stageKey: StageKey.ACTUAL_COSTING, department: Department.WAREHOUSE,
    title: 'Record materials actually issued and their prices',
    requirementAr: 'إضافة ماتم صرفة فعليا للأوردر من خامات واكسسوارات وأسعارها',
    requirementEn: 'Add what was actually issued to the order in materials and accessories, and their prices.',
    estimatedMinutes: 20, sequence: 13, priority: Priority.MEDIUM, critical: false,
  },
  {
    key: 'CO_COSTING_DAYS', stageKey: StageKey.ACTUAL_COSTING, department: Department.COORDINATOR,
    title: 'Record order production days',
    requirementAr: 'إضافة أيام تشغيل الاوردر',
    requirementEn: 'Add the order production days.',
    estimatedMinutes: 10, sequence: 13, priority: Priority.MEDIUM, critical: false,
  },

  // ── Sequence 14 — Everyone logs their time ──────────────────────────────
  {
    key: 'ALL_LOG_TIME', stageKey: StageKey.PROGRESS_STATUS, department: Department.ADMIN,
    title: 'Log actual time spent on each task',
    requirementAr: 'تسجيل الوقت الذي تم عمل المهمة الخاصة به في الأوردر وفقا للجدول السابق',
    requirementEn: 'Record the time at which each task on the order was performed, per the table above.',
    estimatedMinutes: 2, sequence: 14, priority: Priority.LOW, critical: false,
  },
];

/** Total planned effort for an order, in minutes. 27 tasks → 442 minutes. */
export const TEMPLATE_TOTAL_MINUTES = WORKFLOW_TEMPLATE.reduce((a, t) => a + t.estimatedMinutes, 0);

/** Highest sequence group in the template. */
export const MAX_SEQUENCE = Math.max(...WORKFLOW_TEMPLATE.map((t) => t.sequence));

/**
 * Due-date planning.
 *
 * The sequence groups are spread proportionally across the window between the
 * PO date and the promised shipping date, so a 40-day order and a 10-day order
 * both get a sensible schedule instead of fixed offsets that make short orders
 * instantly overdue. A minimum of one day per group keeps the ordering intact.
 */
export function planDueDate(
  sequence: number,
  poDate: Date,
  promisedShippingDate: Date,
): Date {
  const totalDays = Math.max(
    MAX_SEQUENCE,
    Math.round((promisedShippingDate.getTime() - poDate.getTime()) / 86_400_000),
  );
  // Reserve the last 10% of the window for shipping preparation.
  const usableDays = Math.max(MAX_SEQUENCE, Math.floor(totalDays * 0.9));
  const offset = Math.max(1, Math.round((sequence / MAX_SEQUENCE) * usableDays));
  const d = new Date(poDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

/** Group the template by sequence, for the workflow timeline view. */
export function templateBySequence(): Array<{ sequence: number; tasks: TaskTemplate[]; minutes: number }> {
  const map = new Map<number, TaskTemplate[]>();
  for (const t of WORKFLOW_TEMPLATE) {
    const arr = map.get(t.sequence) ?? [];
    arr.push(t);
    map.set(t.sequence, arr);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sequence, tasks]) => ({
      sequence,
      tasks,
      minutes: tasks.reduce((a, t) => a + t.estimatedMinutes, 0),
    }));
}
