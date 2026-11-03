/**
 * Whether an order's packing is approved: every packing list that holds
 * cartons is approved, and there is at least one. Only the newest list used to
 * count, so one click on "New list" un-approved a packed order, and an
 * approved new list hid an older one never approved.
 */
export function packingListsApproved(lists: ReadonlyArray<{ approved: boolean; cartons: readonly unknown[] }>): boolean {
  const packed = lists.filter((l) => l.cartons.length > 0);
  return packed.length > 0 && packed.every((l) => l.approved);
}
