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

/** Compared with the last one announced; a different snapshot is news. */
export function alertSnapshot(alert: { code: string; severity: string; detail: string }): string {
  // The day count is left out, so a late item is announced once, and again
  // only if it becomes more serious — not every day it stays late.
  if (DEADLINE_REMINDERS.has(alert.code)) return alert.severity;
  return `${alert.severity}:${alert.detail}`;
}
