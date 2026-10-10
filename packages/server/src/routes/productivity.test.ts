import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { ROLE_PERMISSIONS, ROLE_KEYS } from '@opsflow/shared';
import { createApp } from '../app.js';
import {
  sectionsFor, parseRange, productivityQuery, dayLogSchema, PRODUCTIVITY_PERMISSION, MAX_RANGE_DAYS,
} from './productivity.js';

/**
 * Who may see what on the productivity page.
 *
 * The page is gated on reading production. The defect rate and the fabric
 * figure are quality and cutting information, and follow the permissions of
 * the tabs that hold the underlying records — the page must not become a side
 * door to a figure a role cannot otherwise see.
 */
describe('productivity permissions', () => {
  test('the page opens on production:read, which every role holds', () => {
    assert.equal(PRODUCTIVITY_PERMISSION, 'production:read');
    for (const role of ROLE_KEYS) {
      assert.ok(ROLE_PERMISSIONS[role].includes('production:read'), `${role} cannot open the page`);
    }
  });

  test('the quality, fabric and delivery sections follow quality:read, cutting:read and shipment:read', () => {
    assert.deepEqual(sectionsFor(['production:read']), { quality: false, fabric: false, delivery: false });
    assert.deepEqual(sectionsFor(['production:read', 'quality:read']), { quality: true, fabric: false, delivery: false });
    assert.deepEqual(sectionsFor(['production:read', 'cutting:read']), { quality: false, fabric: true, delivery: false });
    assert.deepEqual(sectionsFor(['production:read', 'shipment:read']), { quality: false, fabric: false, delivery: true });
    assert.deepEqual(sectionsFor(ROLE_PERMISSIONS.ADMIN), { quality: true, fabric: true, delivery: true });
  });

  test('the day log is written with production:write, the same permission as recording output', () => {
    for (const role of ['COORDINATOR', 'FACTORY_MANAGER', 'PRODUCTION_MANAGER', 'FOLLOW_UP'] as const) {
      assert.ok(ROLE_PERMISSIONS[role].includes('production:write'), `${role} cannot file the day sheet`);
    }
    assert.equal(ROLE_PERMISSIONS.FINANCE.includes('production:write'), false);
  });

  test('nothing on the page needs costing:read — there is no cost figure to protect', () => {
    // Phase 1 shows no cost, labour or efficiency values, so a role without
    // costing access sees the same sections as one with it.
    const withCosting = sectionsFor([...ROLE_PERMISSIONS.PRODUCTION_MANAGER, 'costing:read']);
    assert.deepEqual(sectionsFor(ROLE_PERMISSIONS.PRODUCTION_MANAGER), withCosting);
  });
});

describe('productivity range validation', () => {
  test('a well-formed range is accepted as given', () => {
    assert.deepEqual(parseRange({ from: '2026-10-05', to: '2026-10-11' }), { from: '2026-10-05', to: '2026-10-11' });
    assert.deepEqual(parseRange({ from: '2026-10-05', to: '2026-10-05' }), { from: '2026-10-05', to: '2026-10-05' });
  });

  test('a range that ends before it starts is refused', () => {
    assert.throws(() => parseRange({ from: '2026-10-11', to: '2026-10-05' }), /start of the range/);
  });

  test('a range longer than a year is refused', () => {
    assert.doesNotThrow(() => parseRange({ from: '2026-01-01', to: '2026-12-31' }));
    assert.throws(() => parseRange({ from: '2025-01-01', to: '2026-12-31' }), new RegExp(String(MAX_RANGE_DAYS)));
  });

  test('the query takes calendar days only, and the primary operation must be a real one', () => {
    assert.ok(productivityQuery.safeParse({ from: '2026-10-05', to: '2026-10-11' }).success);
    assert.ok(productivityQuery.safeParse({ from: '2026-10-05', to: '2026-10-11', primary: 'PACKING' }).success);
    for (const bad of [
      { from: '2026-10-05' },
      { from: '05/10/2026', to: '2026-10-11' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-10-05T00:00:00Z', to: '2026-10-11' },
      { from: '2026-10-05', to: '2026-10-11', primary: 'IRONING' },
      // Operations the factory does not have, and never did as far as the enum is concerned.
      { from: '2026-10-05', to: '2026-10-11', primary: 'WASHING' },
      { from: '2026-10-05', to: '2026-10-11', primary: 'FINISHING' },
    ]) {
      assert.equal(productivityQuery.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe('the day log sheet', () => {
  test('a blank box is recorded as unknown, not as zero', () => {
    const r = dayLogSchema.parse({ operators: 30, helpers: '', workingMinutes: undefined, machinesRunning: NaN });
    assert.equal(r.operators, 30);
    assert.equal(r.helpers, null);
    assert.equal(r.workingMinutes, null);
    assert.equal(r.machinesRunning, null);
  });

  test('an implausible figure is refused rather than stored', () => {
    assert.equal(dayLogSchema.safeParse({ operators: -1, helpers: null, workingMinutes: null, machinesRunning: null }).success, false);
    assert.equal(dayLogSchema.safeParse({ operators: 30, helpers: null, workingMinutes: 25 * 60, machinesRunning: null }).success, false);
    assert.equal(dayLogSchema.safeParse({ operators: 30.5, helpers: null, workingMinutes: null, machinesRunning: null }).success, false);
  });
});

describe('the productivity endpoint', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  after(() => { server.close(); });

  test('is refused without a session', async () => {
    const res = await fetch(`${base}/api/productivity?from=2026-10-05&to=2026-10-11`);
    assert.equal(res.status, 401);
  });

  test('is refused with a token that is not a session', async () => {
    const res = await fetch(`${base}/api/productivity?from=2026-10-05&to=2026-10-11`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
  });

  test('the day log cannot be written without a session', async () => {
    const res = await fetch(`${base}/api/productivity/day-log/2026-10-05`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operators: 30 }),
    });
    assert.equal(res.status, 401);
  });
});
