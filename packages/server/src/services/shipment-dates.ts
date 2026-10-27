/**
 * The departure and arrival dates a consignment carries at a given status.
 *
 * Its own module so the rule can be tested by value. Two ways it went wrong:
 *
 * - Forward: a consignment recorded straight in as Shipped had no departure
 *   date, while the same move made later through the status menu did — so the
 *   on-time figures depended on which button was pressed.
 * - Backward: a shipment moved back from Shipped to Booked, because it was
 *   marked too early, kept its departure date, and on-time delivery went on
 *   counting a consignment that had not left.
 */

export const SHIPMENT_STATUS_ORDER = ['NOT_READY', 'READY', 'BOOKED', 'SHIPPED', 'DELIVERED'] as const;
export type ShipmentStatusName = (typeof SHIPMENT_STATUS_ORDER)[number];

const rank = (s: string): number => SHIPMENT_STATUS_ORDER.indexOf(s as ShipmentStatusName);

export function shipmentDates(opts: {
  status: string;
  /** The status before this change; null when the consignment is new. */
  previousStatus: string | null;
  actualShippingDate: Date | null;
  deliveredDate: Date | null;
  /** The day to stamp when a date is needed and none was given. */
  today: Date;
}): { actualShippingDate: Date | null; deliveredDate: Date | null } {
  let { actualShippingDate, deliveredDate } = opts;
  const { status, previousStatus, today } = opts;
  const movedBack = previousStatus != null && rank(status) < rank(previousStatus);

  // Moved back: the dates that belong to the status it no longer has go.
  if (movedBack && rank(status) < rank('DELIVERED')) deliveredDate = null;
  if (movedBack && rank(status) < rank('SHIPPED')) actualShippingDate = null;

  // A consignment that has gone has a departure date, and a delivered one an
  // arrival date. When nobody typed one, the day it was marked is the best
  // record there is — better than a gap the invoice step then waits on.
  if (rank(status) >= rank('SHIPPED') && !actualShippingDate) actualShippingDate = today;
  if (status === 'DELIVERED' && !deliveredDate) deliveredDate = today;

  return { actualShippingDate, deliveredDate };
}
