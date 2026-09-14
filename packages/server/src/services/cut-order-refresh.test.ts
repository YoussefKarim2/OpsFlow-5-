import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { QtyLedger } from '@opsflow/shared';
import { CUT_ORDER_INPUT_LEDGERS } from '../services/cut-order.js';

/**
 * The cut order is a stored snapshot of a calculation. It was generated once,
 * by a button, and then nothing recalculated it — so recording finished stock
 * changed the arithmetic and left the sheet showing the old figure. Saving any
 * ledger the cut order is calculated from now refreshes it.
 */
describe('which quantity ledgers make the cut order stale', () => {
  test('finished stock does — it is subtracted from what has to be cut', () => {
    assert.ok(CUT_ORDER_INPUT_LEDGERS.includes(QtyLedger.STOCK));
  });

  test('the order quantity does — it is what the cut order is cut from', () => {
    assert.ok(CUT_ORDER_INPUT_LEDGERS.includes(QtyLedger.ORDER));
  });

  test('the cut ledger itself does not — it is the output, not an input', () => {
    assert.equal(CUT_ORDER_INPUT_LEDGERS.includes(QtyLedger.CUT), false);
  });

  test('the ledgers downstream of cutting do not', () => {
    // Sewing, packing and shipping consume the cut pieces. Recording them must
    // not reach back and rewrite the sheet the floor is cutting to.
    for (const downstream of [
      QtyLedger.IN_LINE, QtyLedger.OUT_LINE, QtyLedger.PACKED,
      QtyLedger.SHIPPED, QtyLedger.SECOND_DEGREE,
    ]) {
      assert.equal(
        CUT_ORDER_INPUT_LEDGERS.includes(downstream), false,
        `${downstream} must not trigger a cut-order rewrite`,
      );
    }
  });
});
