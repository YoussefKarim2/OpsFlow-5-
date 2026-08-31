/**
 * Stock lifecycle simulation.
 *
 * The unit tests next door check each calculation in isolation. This file
 * checks the thing that actually goes wrong in stock systems: a *sequence* of
 * operations that each look right and together lose or duplicate material.
 *
 * It models what `inventory-service.ts` does — apply a movement, draw down a
 * reservation, restore one on return — using the same pure functions the
 * service uses, and asserts the four invariants after every single step:
 *
 *   1. physical  == the sum of the movement ledger
 *   2. available == physical − reserved
 *   3. reserved  == the unconsumed part of active reservations
 *   4. nothing is ever negative except availability (which may legitimately be)
 *
 * A database is not needed to catch an arithmetic error, and the arithmetic is
 * where the money is.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MovementType } from '../enums.js';
import { qtyAdd, qtySub, qtyCmp } from './num.js';
import {
  replayMovements, computeStockPosition, signedQty,
  type MovementInput, type ReservationInput,
} from './inventory.js';

/**
 * A miniature of the service: the same state transitions, in memory.
 * Deliberately written the way the service is written, so a divergence between
 * this and the service is visible as a difference in the code rather than
 * hidden behind a different formulation of the same idea.
 */
class Store {
  movements: MovementInput[] = [];
  reservations: ReservationInput[] = [];
  private seq = 0;

  private move(type: MovementType, qty: number, orderId?: string): void {
    this.movements.push({
      id: `m${++this.seq}`, type, qty, occurredAt: '2026-08-25', orderId: orderId ?? null,
    });
  }

  get physical(): number {
    return replayMovements(this.movements);
  }

  get position() {
    return computeStockPosition({ physicalQty: this.physical, reservations: this.reservations });
  }

  receive(qty: number): void {
    this.move(MovementType.RECEIPT, qty);
  }

  /** Commit stock without moving it. Refuses to over-commit. */
  reserve(orderId: string, qty: number): void {
    if (qtyCmp(qty, this.position.availableQty) > 0) {
      throw new Error(`only ${this.position.availableQty} available, asked for ${qty}`);
    }
    const existing = this.reservations.find((r) => r.orderId === orderId && r.active);
    if (existing) existing.qty = qtyAdd(existing.qty, qty);
    else this.reservations.push({ id: `r${orderId}`, orderId, qty, consumedQty: 0, active: true });
  }

  /**
   * Draw down this order's reservation first, then free stock.
   * Mirrors `issueToProduction`.
   */
  issue(orderId: string, qty: number): void {
    const mine = this.reservations.filter((r) => r.orderId === orderId && r.active);
    const outstanding = qtyAdd(...mine.map((r) => Math.max(0, qtySub(r.qty, r.consumedQty))));
    const fromReservation = Math.min(qty, outstanding);
    const fromFree = qtySub(qty, fromReservation);

    if (qtyCmp(fromFree, this.position.availableQty) > 0) {
      throw new Error(`needs ${fromFree} beyond the reservation, only ${this.position.availableQty} free`);
    }

    let remaining = fromReservation;
    for (const r of mine) {
      if (qtyCmp(remaining, 0) === 0) break;
      const left = Math.max(0, qtySub(r.qty, r.consumedQty));
      const take = Math.min(left, remaining);
      r.consumedQty = qtyAdd(r.consumedQty, take);
      if (qtyCmp(r.consumedQty, r.qty) >= 0) r.active = false; // FULFILLED
      remaining = qtySub(remaining, take);
    }

    this.move(MovementType.ISSUE, qty, orderId);
  }

  /** Put material back on the shelf and back on the reservation it came off. */
  returnUnused(orderId: string, qty: number): void {
    const drawn = this.reservations
      .filter((r) => r.orderId === orderId && r.consumedQty > 0)
      .sort((a, b) => b.consumedQty - a.consumedQty)[0];
    if (drawn) {
      drawn.consumedQty = Math.max(0, qtySub(drawn.consumedQty, qty));
      if (qtyCmp(drawn.consumedQty, drawn.qty) < 0) drawn.active = true;
    }
    this.move(MovementType.RETURN, qty, orderId);
  }

  release(orderId: string): void {
    for (const r of this.reservations) if (r.orderId === orderId) r.active = false;
  }

  /** The four invariants. Called after every step in every test below. */
  check(label: string): void {
    const p = this.position;
    assert.equal(p.physicalQty, replayMovements(this.movements), `${label}: physical drifted from the ledger`);
    assert.equal(p.availableQty, qtySub(p.physicalQty, p.reservedQty), `${label}: available ≠ physical − reserved`);

    const expectedReserved = qtyAdd(
      ...this.reservations.filter((r) => r.active).map((r) => Math.max(0, qtySub(r.qty, r.consumedQty))),
    );
    assert.equal(p.reservedQty, expectedReserved, `${label}: reserved is not the unconsumed part`);
    assert.ok(qtyCmp(p.physicalQty, 0) >= 0, `${label}: physical went negative`);
    assert.ok(qtyCmp(p.reservedQty, 0) >= 0, `${label}: reserved went negative`);
  }
}

describe('the full lifecycle', () => {
  test('receive → reserve → issue → return leaves the books balanced', () => {
    const s = new Store();

    s.receive(1000);
    s.check('after receipt');
    assert.equal(s.position.availableQty, 1000);

    s.reserve('A', 400);
    s.check('after reserving');
    // The reservation must not have moved anything off the shelf.
    assert.equal(s.position.physicalQty, 1000, 'reserving moved physical stock');
    assert.equal(s.position.availableQty, 600);

    s.issue('A', 250);
    s.check('after partial issue');
    assert.equal(s.position.physicalQty, 750);
    assert.equal(s.position.reservedQty, 150, 'the issued part should stop being reserved');
    assert.equal(s.position.availableQty, 600, 'issuing against a reservation must not change what others can take');

    s.returnUnused('A', 100);
    s.check('after return');
    assert.equal(s.position.physicalQty, 850);
    assert.equal(s.position.reservedQty, 250, 'the returned material goes back on the reservation');
    assert.equal(s.position.availableQty, 600);
  });

  test('a reservation issued in full closes, and frees nothing extra', () => {
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 400);
    s.issue('A', 400);
    s.check('after full issue');

    assert.equal(s.position.physicalQty, 600);
    assert.equal(s.position.reservedQty, 0);
    assert.equal(s.position.availableQty, 600);
  });

  test('two orders cannot both take the same metres', () => {
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 700);
    s.check('A reserved');

    assert.throws(() => s.reserve('B', 400), /only 300 available/);
    s.reserve('B', 300);
    s.check('B reserved the rest');

    assert.equal(s.position.availableQty, 0);
    assert.equal(s.position.reservedQty, 1000);
    assert.equal(s.position.physicalQty, 1000, 'nothing has physically moved yet');
  });

  test('an order cannot issue into another order’s reservation', () => {
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 900);
    s.reserve('B', 100);

    // B wants 300 but has only reserved 100, and the other 800 belongs to A.
    assert.throws(() => s.issue('B', 300), /beyond the reservation/);
    s.check('after the refusal');
    assert.equal(s.position.physicalQty, 1000, 'a refused issue must move nothing');
  });

  test('issuing beyond a reservation is allowed when the stock is genuinely free', () => {
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 200);

    s.issue('A', 500); // 200 from the reservation, 300 from free stock
    s.check('after over-issue');
    assert.equal(s.position.physicalQty, 500);
    assert.equal(s.position.reservedQty, 0);
    assert.equal(s.position.availableQty, 500);
  });

  test('releasing a reservation returns it to the pool without moving stock', () => {
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 400);
    s.release('A');
    s.check('after release');

    assert.equal(s.position.physicalQty, 1000);
    assert.equal(s.position.reservedQty, 0);
    assert.equal(s.position.availableQty, 1000);
  });
});

describe('the numbers stay exact', () => {
  test('a hundred fractional issues do not drift', () => {
    // Fabric is issued in metres to three decimals. A plain `-=` loop here
    // accumulates error until a zero balance compares as −0.0000000001.
    const s = new Store();
    s.receive(100);
    s.reserve('A', 100);
    for (let i = 0; i < 100; i++) s.issue('A', 1);
    s.check('after a hundred issues');

    assert.equal(s.position.physicalQty, 0);
    assert.equal(s.position.reservedQty, 0);
    assert.equal(s.position.availableQty, 0);
  });

  test('thirds of a metre reconcile exactly', () => {
    const s = new Store();
    s.receive(0.9999);
    s.reserve('A', 0.3333);
    s.issue('A', 0.3333);
    s.check('after fractional issue');
    assert.equal(s.position.physicalQty, 0.6666);
    assert.equal(s.position.availableQty, 0.6666);
  });

  test('the ledger and the balance agree after a long mixed sequence', () => {
    const s = new Store();
    const script: Array<() => void> = [
      () => s.receive(5000),
      () => s.reserve('A', 1200),
      () => s.reserve('B', 800),
      () => s.issue('A', 500),
      () => s.receive(250.5),
      () => s.issue('B', 800),
      () => s.returnUnused('A', 120.25),
      () => s.issue('A', 700),
      () => s.reserve('C', 1000),
      () => s.returnUnused('B', 50),
      () => s.release('C'),
      () => s.issue('A', 120.25),
    ];

    for (const [i, step] of script.entries()) {
      step();
      s.check(`step ${i + 1}`);
    }

    // 5000 + 250.5 − 500 − 800 + 120.25 − 700 + 50 − 120.25
    assert.equal(s.position.physicalQty, 3300.5);
    assert.equal(s.movements.length, 8, 'only the movements that touch stock are in the ledger');
  });
});

describe('the ledger is the source of truth', () => {
  test('replaying it reproduces the balance whatever the order of operations', () => {
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 400);
    s.issue('A', 400);
    s.returnUnused('A', 50);

    const replayed = qtyAdd(...s.movements.map(signedQty));
    assert.equal(replayed, s.position.physicalQty);
    assert.equal(replayed, 650);
  });

  test('reservations leave no trace in the ledger — they are not movements', () => {
    // The mistake this guards: recording a reservation as a withdrawal, which
    // deducts the metres at reservation and again at issue.
    const s = new Store();
    s.receive(1000);
    s.reserve('A', 400);
    s.release('A');
    s.reserve('B', 400);

    assert.equal(s.movements.length, 1, 'a reservation was written to the movement ledger');
    assert.equal(s.position.physicalQty, 1000);
  });
});
