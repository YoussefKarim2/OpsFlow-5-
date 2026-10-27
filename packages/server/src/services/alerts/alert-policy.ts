/**
 * When one of the sweep's alerts counts as news.
 *
 * Kept apart from `alert-worker.ts` so the rule can be tested without a
 * database, and read in one place. Whether it is emailed is not decided here:
 * the sweep announces as nobody, and `announceChange` never mails that.
 */

import { AlertCode } from '@opsflow/shared';

/**
 * Alerts that say something is late, overdue or due soon.
 *
 * Their detail carries a day count — "4 days past its expected return date" —
 * so it changes every day on its own. Compared as text, that made the sweep
 * announce every late item again each morning, which said nothing the
 * Follow-Up Centre did not already show.
 */
const DEADLINE_REMINDERS: ReadonlySet<string> = new Set([
  AlertCode.ORDER_OVERDUE,
  AlertCode.SHIP_DATE_APPROACHING,
  AlertCode.EXTERNAL_OP_LATE,
  AlertCode.PRODUCTION_BEHIND,
  AlertCode.TASK_OVERDUE,
  AlertCode.PACKING_INCOMPLETE,
  AlertCode.APPROVAL_PENDING,
]);

/** A stable, id-safe fallback discriminator for an alert with no entityId of its own. */
function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
}

/**
 * The record an alert's dedup row is kept against.
 *
 * `deriveOrder` can return several alerts sharing one `code` within the same
 * order with no `entityId` of their own — several blocked stages, several
 * materials with a consumption variance — each still uniquely identified by
 * its own `title` ("Cutting is blocked" vs "Packing is blocked"). Falling back
 * to the order id alone for all of them made every alert in such a group
 * fight over one dedup row, each sweep overwriting the last one's snapshot and
 * re-triggering the others: verified live against real order data, fixed by
 * keying on the title too whenever there is no better id.
 */
export function alertEntityId(orderId: string, alert: { entityId?: string; title: string }): string {
  return alert.entityId ?? `${orderId}:${slug(alert.title)}`;
}

/** One dedup row's identity: its code and the record it is kept against. */
export const alertKey = (code: string, entityId: string): string => `${code}\u0000${entityId}`;

/**
 * Whether a stored dedup row is one of this order's.
 *
 * The rows carry no order id. Every alert is kept against the order itself
 * (`<orderId>:<title>`) or against one of the order's own records — an
 * outside operation, a quality audit, a task — so those ids say it.
 */
export function orderOwnsAlertState(orderId: string, ownRecordIds: ReadonlySet<string>, entityId: string): boolean {
  return entityId.startsWith(`${orderId}:`) || ownRecordIds.has(entityId);
}

/**
 * The dedup rows to forget: this order's rows for alerts that did not fire in
 * this sweep.
 *
 * Kept, a row outlived its alert, and when the same problem came back — the
 * shortage after a restock ran out, the stage blocked again — its snapshot
 * still matched and it was never announced a second time.
 */
export function staleAlertStateIds(
  orderId: string,
  ownRecordIds: ReadonlySet<string>,
  states: ReadonlyArray<{ id: string; code: string; entityId: string }>,
  firedKeys: ReadonlySet<string>,
): string[] {
  return states
    .filter((s) => orderOwnsAlertState(orderId, ownRecordIds, s.entityId))
    .filter((s) => !firedKeys.has(alertKey(s.code, s.entityId)))
    .map((s) => s.id);
}

/** Compared with the last one announced; a different snapshot is news. */
export function alertSnapshot(alert: { code: string; severity: string; detail: string }): string {
  // The day count is left out, so a late item is announced once, and again
  // only if it becomes more serious — not every day it stays late.
  if (DEADLINE_REMINDERS.has(alert.code)) return alert.severity;
  return `${alert.severity}:${alert.detail}`;
}
