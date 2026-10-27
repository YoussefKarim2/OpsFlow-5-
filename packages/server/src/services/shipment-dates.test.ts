import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shipmentDates } from './shipment-dates.js';

const today = new Date('2026-10-27T00:00:00Z');
const shipped = new Date('2026-10-20T00:00:00Z');
const delivered = new Date('2026-10-25T00:00:00Z');

describe('a consignment carries the dates its status implies', () => {
  test('recorded straight in as shipped, it gets today as the departure', () => {
    const r = shipmentDates({ status: 'SHIPPED', previousStatus: null, actualShippingDate: null, deliveredDate: null, today });
    assert.equal(r.actualShippingDate, today);
    assert.equal(r.deliveredDate, null);
  });

  test('a typed date is kept', () => {
    const r = shipmentDates({ status: 'DELIVERED', previousStatus: 'SHIPPED', actualShippingDate: shipped, deliveredDate: null, today });
    assert.equal(r.actualShippingDate, shipped);
    assert.equal(r.deliveredDate, today);
  });

  test('moved back below shipped, both dates are cleared', () => {
    const r = shipmentDates({ status: 'BOOKED', previousStatus: 'DELIVERED', actualShippingDate: shipped, deliveredDate: delivered, today });
    assert.deepEqual(r, { actualShippingDate: null, deliveredDate: null });
  });

  test('moved back from delivered to shipped, only the arrival goes', () => {
    const r = shipmentDates({ status: 'SHIPPED', previousStatus: 'DELIVERED', actualShippingDate: shipped, deliveredDate: delivered, today });
    assert.deepEqual(r, { actualShippingDate: shipped, deliveredDate: null });
  });

  test('a status left alone keeps what it had', () => {
    const r = shipmentDates({ status: 'BOOKED', previousStatus: 'BOOKED', actualShippingDate: null, deliveredDate: null, today });
    assert.deepEqual(r, { actualShippingDate: null, deliveredDate: null });
  });
});
