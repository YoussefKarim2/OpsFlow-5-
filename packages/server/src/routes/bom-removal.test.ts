import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bomRemovalBlocker, type BomLineHistory } from './materials.js';

/**
 * Removing bill-of-materials lines.
 *
 * The editor now names the lines it removed, and the server deletes exactly
 * those; these are the rules that still refuse a removal once it is named.
 */
describe('which BOM lines may be removed', () => {
  const clean: BomLineHistory = { item: 'Poly bag', issuedQty: 0, issueCount: 0, openReservations: 0 };

  test('a line with no history goes', () => {
    assert.equal(bomRemovalBlocker([clean]), null);
    assert.equal(bomRemovalBlocker([]), null);
  });

  test('a line anything was issued against stays, and says why', () => {
    const why = bomRemovalBlocker([clean, { ...clean, item: 'Rosetta', issuedQty: 12 }]);
    assert.match(why!, /already been issued against Rosetta/);
    // An issue corrected back to zero still left a record behind.
    assert.match(bomRemovalBlocker([{ ...clean, issueCount: 2 }])!, /already been issued/);
  });

  test('a line holding a reservation or a request stays, and says what to do', () => {
    // Deleting it left the reservation holding stock for a line that no longer exists.
    const why = bomRemovalBlocker([{ ...clean, item: 'Mesh', openReservations: 1 }]);
    assert.match(why!, /Mesh has stock reserved or requested/);
    assert.match(why!, /Release the reservation or withdraw the request/);
    const two = bomRemovalBlocker([
      { ...clean, item: 'Mesh', openReservations: 1 },
      { ...clean, item: 'Rib', openReservations: 2 },
    ]);
    assert.match(two!, /Mesh, Rib have stock reserved/);
  });
});
