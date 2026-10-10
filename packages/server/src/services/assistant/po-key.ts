/**
 * The comparison key for an order reference: letters and digits only, upper
 * case, a leading "PO" dropped. "PO 13506", "po-13506" and "13506" all match,
 * and so do "PO231" and "PO-231".
 *
 * Its own module so the matching rules can be used (and tested) without
 * loading the database client.
 */
export function poKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^PO(?=\w)/, '');
}
