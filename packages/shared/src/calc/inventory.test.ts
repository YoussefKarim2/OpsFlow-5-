/**
 * Inventory engine tests.
 *
 * These cover the arithmetic a factory's stock actually depends on. The cases
 * chosen are the ones that go wrong in real systems: reserving twice, counting
 * a reservation as a withdrawal, comparing floating-point metres, and treating
 * "not reserved yet" as the same problem as "does not exist".
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MovementType, StockStatus } from '../enums.js';
import { qtyAdd, qtySub, qtyCmp, quantise, qtyIsZero } from './num.js';
import {
  signedQty, replayMovements, computeStockPosition, deriveStockStatus,
  computeRequirement, computeMaterialPosition, computeConsumptionVariance,
  summariseInventory, daysOfCover, convertQty, unitsCompatible, normaliseUnit,
  type MovementInput, type ReservationInput, type RequirementInput,
} from './inventory.js';

const mv = (type: MovementType, qty: number): MovementInput => ({
  id: `${type}-${qty}`, type, qty, occurredAt: '2026-08-25',
});

describe('quantity arithmetic', () => {
  test('adding does not accumulate floating-point error', () => {
    // The plain-JS answer is 0.30000000000000004.
    assert.equal(qtyAdd(0.1, 0.2), 0.3);
    // A hundred issues of a third of a metre.
    const hundred = qtyAdd(...Array.from({ length: 100 }, () => 0.3333));
    assert.equal(hundred, 33.33);
  });

  test('subtracting to zero gives exactly zero, not a negative crumb', () => {
    // The regression: a balance of -0.0000000001 reads as a shortage.
    let balance = 1194;
    for (let i = 0; i < 3; i++) balance = qtySub(balance, 398);
    assert.equal(balance, 0);
    assert.ok(qtyIsZero(balance));
    assert.equal(qtyCmp(balance, 0), 0);
  });

  test('comparison works at storage precision', () => {
    assert.equal(qtyCmp(0.00001, 0), 0, 'below storage precision is zero');
    assert.equal(qtyCmp(0.0001, 0), 1);
    assert.equal(qtyCmp(1.6759, 1.676), -1);
  });

  test('quantise snaps to four places', () => {
    assert.equal(quantise(1.67589), 1.6759);
    assert.equal(quantise(null), 0);
    assert.equal(quantise(Number.NaN), 0);
  });
});

describe('movement ledger', () => {
  test('each type moves the balance the right way', () => {
    assert.equal(signedQty(mv(MovementType.RECEIPT, 5000)), 5000);
    assert.equal(signedQty(mv(MovementType.ISSUE, 1200)), -1200);
    assert.equal(signedQty(mv(MovementType.RETURN, 200)), 200);
    assert.equal(signedQty(mv(MovementType.WASTAGE, 15)), -15);
    assert.equal(signedQty(mv(MovementType.TRANSFER_IN, 100)), 100);
    assert.equal(signedQty(mv(MovementType.TRANSFER_OUT, 100)), -100);
  });

  test('an issue entered as a positive number still reduces stock', () => {
    // The UI sends a magnitude; direction is the type's job, not the sign's.
    assert.equal(signedQty({ type: MovementType.ISSUE, qty: 1200 }), -1200);
    assert.equal(signedQty({ type: MovementType.ISSUE, qty: -1200 }), -1200);
  });

  test('an adjustment carries its own sign — a count can find less', () => {
    assert.equal(signedQty({ type: MovementType.ADJUSTMENT, qty: -40 }), -40);
    assert.equal(signedQty({ type: MovementType.ADJUSTMENT, qty: 40 }), 40);
  });

  test('replaying the ledger reproduces the brief’s worked example', () => {
    // §21: +5,000 receipt, −1,200 to A302059B, −500 to A302060C, +200 returned.
    const balance = replayMovements([
      mv(MovementType.RECEIPT, 5000),
      mv(MovementType.ISSUE, 1200),
      mv(MovementType.ISSUE, 500),
      mv(MovementType.RETURN, 200),
    ]);
    assert.equal(balance, 3500);
  });
});

describe('stock position', () => {
  const reservation = (qty: number, consumedQty = 0, active = true): ReservationInput => ({
    id: `r${qty}`, orderId: 'o1', qty, consumedQty, active,
  });

  test('the brief’s worked example: 12,500 physical, 1,676 reserved', () => {
    const p = computeStockPosition({
      physicalQty: 12_500,
      reservations: [reservation(1676)],
    });
    assert.equal(p.physicalQty, 12_500);
    assert.equal(p.reservedQty, 1676);
    assert.equal(p.availableQty, 10_824);
  });

  test('a reservation does not leave the shelf', () => {
    // The double-count this guards: reserving must not reduce physical stock.
    const p = computeStockPosition({ physicalQty: 1000, reservations: [reservation(400)] });
    assert.equal(p.physicalQty, 1000, 'reserving moved physical stock');
    assert.equal(p.availableQty, 600);
  });

  test('issuing against a reservation releases the unissued remainder only', () => {
    // 400 of a reserved 1,000 have been issued, so 400 have physically gone and
    // 600 are still spoken for. Counting 1,000 would hide 400 from every other order.
    const p = computeStockPosition({
      physicalQty: 600,
      reservations: [reservation(1000, 400)],
    });
    assert.equal(p.reservedQty, 600);
    assert.equal(p.availableQty, 0);
  });

  test('a fully consumed reservation stops reserving anything', () => {
    const p = computeStockPosition({
      physicalQty: 500,
      reservations: [reservation(1000, 1000)],
    });
    assert.equal(p.reservedQty, 0);
    assert.equal(p.availableQty, 500);
  });

  test('released reservations are ignored', () => {
    const p = computeStockPosition({
      physicalQty: 1000,
      reservations: [reservation(400, 0, false)],
    });
    assert.equal(p.reservedQty, 0);
    assert.equal(p.availableQty, 1000);
  });

  test('reservations from several orders add up', () => {
    const p = computeStockPosition({
      physicalQty: 12_500,
      reservations: [reservation(1676), reservation(3000), reservation(500, 200)],
    });
    assert.equal(p.reservedQty, 4976);
    assert.equal(p.availableQty, 7524);
  });
});

describe('stock status', () => {
  test('over-reserved outranks out of stock', () => {
    // Promising fabric that does not exist is worse than having none: an order
    // somewhere is planned on it.
    assert.equal(deriveStockStatus(100, -50, 200), StockStatus.OVER_RESERVED);
    assert.equal(deriveStockStatus(0, 0, 200), StockStatus.OUT_OF_STOCK);
  });

  test('low is measured against available, not physical', () => {
    // 5,000 on the shelf but 4,900 reserved is not a healthy material.
    assert.equal(deriveStockStatus(5000, 100, 500), StockStatus.LOW);
    assert.equal(deriveStockStatus(5000, 5000, 500), StockStatus.OK);
  });

  test('no minimum set means never low', () => {
    assert.equal(deriveStockStatus(1, 1, null), StockStatus.OK);
  });
});

describe('requirements and shortages', () => {
  const req = (over: Partial<RequirementInput> = {}): RequirementInput => ({
    id: 'r1', materialId: 'm1', materialName: 'Cotton Jersey', unit: 'M',
    requiredQty: 1676, reservedQty: 0, issuedQty: 0, availableQty: 1200,
    ...over,
  });

  test('the brief’s shortage example: need 1,676, have 1,200, short 476', () => {
    const r = computeRequirement(req());
    assert.equal(r.outstandingQty, 1676);
    assert.equal(r.reservableQty, 1200);
    assert.equal(r.shortQty, 476);
    assert.equal(r.status, 'SHORT');
  });

  test('stock on the shelf but unreserved is reservable, not short', () => {
    // The distinction that matters: one is a click, the other is a purchase order.
    const r = computeRequirement(req({ availableQty: 5000 }));
    assert.equal(r.shortQty, 0);
    assert.equal(r.reservableQty, 1676);
    assert.equal(r.status, 'RESERVABLE');
  });

  test('reserved and issued both count toward securing the requirement', () => {
    const r = computeRequirement(req({ reservedQty: 1000, issuedQty: 676 }));
    assert.equal(r.outstandingQty, 0);
    assert.equal(r.status, 'COVERED');
    assert.equal(r.coveragePct, 100);
  });

  test('over-issuing does not create a negative outstanding', () => {
    const r = computeRequirement(req({ issuedQty: 2000 }));
    assert.equal(r.outstandingQty, 0);
    assert.equal(r.shortQty, 0);
  });

  test('a line with no linked material is reported as unlinked, not as covered', () => {
    // Silently treating it as fine is the lie the cutting floor finds out about.
    const r = computeRequirement(req({ materialId: null, availableQty: null }));
    assert.equal(r.status, 'UNLINKED');
    assert.equal(r.shortQty, 0);
  });

  test('position roll-up separates short from merely unreserved', () => {
    const p = computeMaterialPosition([
      req({ id: 'a', requiredQty: 1676, availableQty: 1200 }),                 // short 476
      req({ id: 'b', requiredQty: 500, availableQty: 5000 }),                  // reservable
      req({ id: 'c', requiredQty: 300, reservedQty: 300, availableQty: 100 }), // covered
      req({ id: 'd', materialId: null, availableQty: null, requiredQty: 40 }), // unlinked
    ]);
    assert.equal(p.shortCount, 1);
    assert.equal(p.reservableCount, 1);
    assert.equal(p.coveredCount, 1);
    assert.equal(p.unlinkedCount, 1);
    assert.equal(p.fullySecured, false);
    assert.equal(p.fullyCoverable, false);
    assert.equal(p.topShortages[0]?.shortQty, 476);
  });

  test('fullyCoverable is true when every line can be reserved right now', () => {
    const p = computeMaterialPosition([
      req({ id: 'a', requiredQty: 100, availableQty: 5000 }),
      req({ id: 'b', requiredQty: 200, availableQty: 5000 }),
    ]);
    assert.equal(p.fullyCoverable, true);
    assert.equal(p.fullySecured, false, 'coverable is not the same as secured');
  });
});

describe('consumption variance', () => {
  test('the brief’s example: 0.85 m × 1,000 pieces expects 850 m', () => {
    const v = computeConsumptionVariance({
      materialName: 'Cotton Jersey', unit: 'M',
      consumptionPerPiece: 0.85, piecesProduced: 1000, actualQty: 900,
    });
    assert.equal(v.expectedQty, 850);
    assert.equal(v.varianceQty, 50);
    assert.ok(v.variancePct != null && Math.abs(v.variancePct - 5.882) < 0.01);
    assert.equal(v.direction, 'OVER');
    assert.equal(v.isSignificant, true);
  });

  test('inside the tolerance band it is on plan, not a variance', () => {
    const v = computeConsumptionVariance({
      materialName: 'Cotton Jersey', unit: 'M',
      consumptionPerPiece: 0.85, piecesProduced: 1000, actualQty: 870,
    });
    assert.equal(v.direction, 'ON_PLAN');
    assert.equal(v.isSignificant, false);
  });

  test('using less than planned is flagged too', () => {
    // Under-consumption usually means the BOM is wrong, and every future order
    // quoted from it is priced wrong.
    const v = computeConsumptionVariance({
      materialName: 'Cotton Jersey', unit: 'M',
      consumptionPerPiece: 0.85, piecesProduced: 1000, actualQty: 700,
    });
    assert.equal(v.direction, 'UNDER');
    assert.equal(v.isSignificant, true);
  });

  test('no consumption rate means unknown, never zero', () => {
    const v = computeConsumptionVariance({
      materialName: 'Buttons', unit: 'PCS',
      consumptionPerPiece: null, piecesProduced: 1000, actualQty: 900,
    });
    assert.equal(v.expectedQty, null);
    assert.equal(v.varianceQty, null);
    assert.equal(v.direction, 'UNKNOWN');
    assert.equal(v.isSignificant, false);
  });
});

describe('inventory roll-up', () => {
  const pos = (physical: number, reserved: number, minimum: number | null) =>
    computeStockPosition({
      physicalQty: physical,
      reservations: reserved > 0 ? [{ id: 'r', orderId: 'o', qty: reserved, consumedQty: 0, active: true }] : [],
      minimumQty: minimum,
    });

  test('counts each status once', () => {
    const s = summariseInventory([
      { position: pos(12_500, 1676, 1000), unitCost: 2 },
      { position: pos(1200, 1400, 500), unitCost: 3 },   // over-reserved
      { position: pos(0, 0, 100), unitCost: 1 },         // out of stock
      { position: pos(400, 0, 500), unitCost: null },    // low
    ]);
    assert.equal(s.totalMaterials, 4);
    assert.equal(s.okCount, 1);
    assert.equal(s.overReservedCount, 1);
    assert.equal(s.outOfStockCount, 1);
    assert.equal(s.lowCount, 1);
    assert.equal(s.reservedCount, 2);
  });

  test('value ignores materials with no cost rather than treating them as free', () => {
    const s = summariseInventory([
      { position: pos(100, 0, null), unitCost: 2 },
      { position: pos(100, 0, null), unitCost: null },
    ]);
    assert.equal(s.totalValue, 200);
  });

  test('no costed material at all gives null, not zero', () => {
    const s = summariseInventory([{ position: pos(100, 0, null), unitCost: null }]);
    assert.equal(s.totalValue, null);
  });
});

describe('days of cover', () => {
  test('divides available by the burn rate', () => {
    assert.equal(daysOfCover(1000, 100), 10);
    assert.equal(daysOfCover(1050, 100), 10, 'rounds down — a partial day is not cover');
  });

  test('no consumption gives null, never Infinity', () => {
    assert.equal(daysOfCover(1000, 0), null);
    assert.equal(daysOfCover(1000, null), null);
  });
});

describe('unit conversion', () => {
  test('converts within a dimension', () => {
    assert.equal(convertQty(1, 'M', 'CM'), 100);
    assert.equal(convertQty(100, 'CM', 'M'), 1);
    assert.equal(convertQty(1, 'YD', 'M'), 0.9144);
    assert.equal(convertQty(1, 'DZN', 'PCS'), 12);
    assert.equal(convertQty(1, 'KG', 'G'), 1000);
  });

  test('refuses to convert across dimensions', () => {
    // 100 pieces are not 100 kilos, and guessing is how that reaches the floor.
    assert.equal(convertQty(100, 'PCS', 'KG'), null);
    assert.equal(convertQty(100, 'M', 'PCS'), null);
  });

  test('refuses packaging units whose size varies by supplier', () => {
    assert.equal(convertQty(1, 'ROLL', 'M'), null);
    assert.equal(convertQty(1, 'CONE', 'M'), null);
  });

  test('identical units pass through', () => {
    assert.equal(convertQty(1.6759, 'M', 'M'), 1.6759);
    assert.ok(unitsCompatible('M', 'YD'));
    assert.ok(!unitsCompatible('M', 'KG'));
  });

  test('units as people actually spell them resolve to one unit', () => {
    // The source workbook writes "Met." and "Pcs"; a supplier writes "MTR".
    // Treating those as different units silently refuses to compare a
    // requirement with the stock that satisfies it.
    for (const spelling of ['Met.', 'MTR', 'metres', 'Meter', 'm', 'MTS']) {
      assert.equal(normaliseUnit(spelling), 'M', `“${spelling}”`);
    }
    for (const spelling of ['Pcs', 'PC', 'pieces', 'EA', 'Each']) {
      assert.equal(normaliseUnit(spelling), 'PCS', `“${spelling}”`);
    }
    assert.equal(normaliseUnit('Dzn'), 'DZN');
    assert.equal(normaliseUnit('Kgs'), 'KG');
  });

  test('spelling differences do not block comparison or conversion', () => {
    assert.ok(unitsCompatible('Met.', 'M'));
    assert.ok(unitsCompatible('Pcs', 'PCS'));
    assert.equal(convertQty(1194, 'Met.', 'M'), 1194);
    assert.equal(convertQty(2, 'Doz', 'Pcs'), 24);
  });

  test('an unrecognised unit is still refused rather than guessed', () => {
    assert.equal(normaliseUnit('sparkles'), null);
    assert.equal(convertQty(1, 'sparkles', 'M'), null);
    assert.ok(!unitsCompatible('sparkles', 'M'));
    // …but two identical unknown units are trivially comparable.
    assert.ok(unitsCompatible('sparkles', 'sparkles'));
  });
});
