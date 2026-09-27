/**
 * Which of the sweep's alerts are worth an email, and when one counts as news.
 *
 * Kept apart from `alert-worker.ts` so the rule can be tested without a
 * database, and read in one place.
 */

import { AlertCode } from '@opsflow/shared';

/**
 * Alerts that say something is late, overdue or due soon.
 *
 * Their detail carries a day count — "4 days past its expected return date" —
 * so it changes every day on its own. Compared as text, that made the sweep
 * announce every late item again each morning, by email, to everyone routed
 * plus every ALWAYS_NOTIFY address: a batch of mail per day that said nothing
 * the Follow-Up Centre did not already show. These stay on the screen and in
 * the bell, and are never emailed.
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

export interface AlertNotice {
  /** Compared with the last one sent; a different snapshot is news. */
  snapshot: string;
  /** Whether the announcement goes out by email as well as in-app. */
  email: boolean;
}

export function alertNotice(alert: { code: string; severity: string; detail: string }): AlertNotice {
  if (DEADLINE_REMINDERS.has(alert.code)) {
    // The day count is left out, so a late item is announced once, and again
    // only if it becomes more serious — not every day it stays late.
    return { snapshot: alert.severity, email: false };
  }
  return { snapshot: `${alert.severity}:${alert.detail}`, email: true };
}
