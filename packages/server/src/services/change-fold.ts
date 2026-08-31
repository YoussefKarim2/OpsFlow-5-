/**
 * Folding a request's raw changes into the events a person reads.
 *
 * Pure. This module imports nothing at runtime but `@opsflow/shared`, so it can
 * be tested by value without a database, an environment file or an HTTP server
 * — the same split as `step-context.ts`, and for the same reason: this is where
 * "three edited fields become one notification" is decided, and getting that
 * wrong is invisible until somebody's inbox has three emails in it.
 */

import {
  TRACKED_MODELS, fieldLabel, NOISE_FIELDS, type FieldChange,
} from '@opsflow/shared';
import type { ChangeDraft } from '../request-context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Folding drafts into events
// ─────────────────────────────────────────────────────────────────────────────

export interface FoldedChange {
  model: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  entityId: string;
  orderId: string | null;
  subjectHint: string | null;
  fields: FieldChange[];
}

/**
 * One event per record touched, not one per column.
 *
 * A request that edits an order's quantity, delivery date and coordinator
 * produces three drafts against the same order id, and they fold into one
 * change with three fields. A request that also creates a production record
 * produces a second change, because that is a different record and a person
 * reading the timeline would expect two lines.
 */
export function foldChanges(drafts: readonly ChangeDraft[]): FoldedChange[] {
  const byRecord = new Map<string, FoldedChange>();

  for (const d of drafts) {
    if (!TRACKED_MODELS[d.model]) continue;

    const key = `${d.model}:${d.entityId}:${d.action}`;
    let folded = byRecord.get(key);
    if (!folded) {
      folded = {
        model: d.model,
        action: d.action,
        entityId: d.entityId,
        orderId: d.orderId,
        subjectHint: d.subjectHint,
        fields: [],
      };
      byRecord.set(key, folded);
    }
    // A later draft may know the order or the subject when an earlier one did
    // not — a create often learns its own name only once written.
    folded.orderId ??= d.orderId;
    folded.subjectHint ??= d.subjectHint;

    // Noise is dropped from the *fields*, not from the event. A create whose
    // only recorded column happened to be a sort position is still a record
    // that now exists, and "a packing list was created" is worth saying. The
    // filter at the bottom removes updates that turned out to say nothing.
    if (NOISE_FIELDS.has(d.field)) continue;

    // The same column written twice in one request: keep the first "before"
    // and the last "after", which is what actually happened end to end.
    const existing = folded.fields.find((f) => f.field === d.field);
    if (existing) {
      existing.newValue = d.newValue;
      continue;
    }
    folded.fields.push({
      field: d.field,
      label: fieldLabel(d.field),
      oldValue: d.oldValue,
      newValue: d.newValue,
    });
  }

  // A fold whose every field turned out to be uninteresting says nothing.
  return [...byRecord.values()].filter(
    (f) => f.action !== 'UPDATE' || f.fields.length > 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming and linking
// ─────────────────────────────────────────────────────────────────────────────

/** Where in the web app this change can be looked at. */
const TAB_FOR_MODEL: Record<string, string> = {
  ProductionRecord: 'production', CuttingRecord: 'cutting', Marker: 'cutting',
  BomItem: 'bom', MaterialReservation: 'materials', MaterialIssue: 'materials',
  QualityAudit: 'quality', QualityDefect: 'quality',
  PackingList: 'packing', Carton: 'packing', Shipment: 'shipping',
  Approval: 'approvals', ExternalOperation: 'external',
  Attachment: 'documents', CustomInstruction: 'instructions',
  StockRecord: 'stock', ProformaInvoice: 'proforma',
  Task: 'tasks', CostingRecord: 'costing', StageQuantity: 'quantity',
  OrderStage: 'overview',
};

export function buildLink(model: string, orderId: string | null): string | null {
  if (orderId) {
    const tab = TAB_FOR_MODEL[model];
    return tab ? `/orders/${orderId}?tab=${tab}` : `/orders/${orderId}`;
  }
  // Routes that exist in App.tsx. Nothing is invented here.
  if (model === 'Material' || model === 'MaterialStock') return '/inventory/materials';
  if (model === 'MaterialMovement') return '/inventory/movements';
  if (model === 'MaterialReservation') return '/inventory/reservations';
  if (model === 'User' || model === 'Role') return '/admin/users';
  return null;
}

