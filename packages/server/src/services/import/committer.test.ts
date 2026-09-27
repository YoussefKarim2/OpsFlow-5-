/**
 * What the import commit writes.
 *
 * The test runner has no database, so the commit runs against a recorder: a
 * stand-in client that answers the lookups, keeps every row the commit asks to
 * create, and stops the run at the workflow step — by then every record these
 * tests care about has been written. What is asserted is exactly what would
 * have reached Prisma.
 *
 * Each case is a fault reproduced against the real app: a colour spelled two
 * ways failing the file on a unique violation, a cleared delivery date reaching
 * the database as an Invalid Date, the lay plan's total length and the
 * external order sheet read and then never saved, and imported stock written
 * only to the ledger so the Stock step wiped it.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { commitImport, mergeMatrixAxes } from './committer.js';
import type { ExtractionResult } from './extractor.js';

/** Thrown by the recorder when the commit reaches the workflow step. */
class ReachedWorkflow extends Error {}

type Row = Record<string, unknown>;

function recorder() {
  const created: Record<string, Row[]> = {};
  let seq = 0;
  const keep = (model: string, data: Row | Row[]) => {
    for (const d of Array.isArray(data) ? data : [data]) (created[model] ??= []).push(d);
  };
  const model = (name: string) => ({
    findFirst: async () => null,
    findUnique: async () => null,
    create: async ({ data }: { data: Row }) => { keep(name, data); return { id: `${name}-${++seq}`, ...data }; },
    createMany: async ({ data }: { data: Row[] }) => { keep(name, data); return { count: data.length }; },
  });
  const known = [
    'client', 'factory', 'user', 'order', 'refColor', 'refSize', 'orderColor', 'orderSize',
    'stageQuantity', 'stockRecord', 'orderNote', 'bomItem', 'marker', 'costingRecord', 'externalOperation',
  ];
  const tx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (known.includes(prop)) return model(prop);
      // Anything else is the workflow, which these tests do not need.
      throw new ReachedWorkflow(prop);
    },
  });
  const prisma = {
    order: { findUnique: async () => null },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, created };
}

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    profileKey: 'test', confidence: 1, sheets: [], mappings: [],
    fields: { poNumber: 'PO-T1', clientName: 'Audit Co', poDate: new Date('2026-09-01T00:00:00Z') },
    matrices: [], lineItems: [], bom: [], lays: [], externalColors: [], costing: {}, issues: [],
    ...over,
  };
}

async function commit(x: ExtractionResult) {
  const r = recorder();
  await assert.rejects(
    commitImport(r.prisma, x, { actorId: 'u1', actorName: 'Tester' }),
    ReachedWorkflow,
  );
  return r.created;
}

describe('one colour spelled two ways', () => {
  test('rows that differ only in case are merged, their cells added', () => {
    const m = mergeMatrixAxes({
      sizes: ['M', 'L', 'l'],
      rows: [
        { color: 'Navy', cells: { M: 10 }, total: 10 },
        { color: 'navy ', cells: { L: 20, l: 5 }, total: 25 },
        { color: 'Red', cells: { M: 1 }, total: 1 },
      ],
    });
    assert.deepEqual(m.sizes, ['M', 'L']);
    assert.deepEqual(m.rows, [
      { color: 'Navy', cells: { M: 10, L: 25 }, total: 35 },
      { color: 'Red', cells: { M: 1 }, total: 1 },
    ]);
  });

  test('the commit creates one order colour for "Navy" and "navy"', async () => {
    const created = await commit(extraction({
      matrices: [{
        ledger: 'ORDER', sizes: ['M', 'L'], sheetTotal: null, computedTotal: 30,
        rows: [
          { color: 'Navy', cells: { M: 10 }, total: 10 },
          { color: 'navy', cells: { L: 20 }, total: 20 },
        ],
      }],
    }));
    assert.equal(created.orderColor?.length, 1);
    const order = created.stageQuantity!.filter((q) => q.ledger === 'ORDER');
    assert.deepEqual(order.map((q) => q.qty), [10, 20]);
    assert.equal(new Set(order.map((q) => q.orderColorId)).size, 1);
  });
});

describe('the order row itself', () => {
  test('an unreadable delivery date falls back to the shipping date', async () => {
    const created = await commit(extraction({
      fields: {
        poNumber: 'PO-T2', clientName: 'Audit Co', poDate: new Date('2026-09-01T00:00:00Z'),
        promisedShippingDate: new Date('2026-10-01T00:00:00Z'),
        requiredDeliveryDate: new Date('not a date'),
      },
    }));
    const order = created.order![0]!;
    assert.equal((order.requiredDeliveryDate as Date).toISOString().slice(0, 10), '2026-10-01');
  });

  test('the customer reference and the composition are written, not only previewed', async () => {
    const created = await commit(extraction({
      fields: {
        poNumber: 'PO-T3', clientName: 'Audit Co',
        externalReference: 'REF-777', fabricDescription: '100% cotton',
      },
    }));
    assert.equal(created.order![0]!.externalReference, 'REF-777');
    assert.equal(created.order![0]!.fabricDescription, '100% cotton');
  });
});

describe('what the rest of the workbook carries', () => {
  test('lays keep their total length, with whole layers and pieces', async () => {
    const created = await commit(extraction({
      lays: [{
        fabric: 'Rosetta', color: 'USA', panel: 'ALL', sizeRatio: '(S1)(M1)',
        layers: 11.9999, markerLengthM: 2.4, totalLengthM: 30.5, nestPcs: 2.0001,
      }],
    }));
    const marker = created.marker![0]!;
    assert.equal(marker.layers, 12);
    assert.equal(marker.nestPcs, 2);
    assert.equal(marker.totalLengthM, 30.5);
  });

  test('the external order sheet becomes external operations, one per colour', async () => {
    const created = await commit(extraction({
      fields: { poNumber: 'PO-T4', clientName: 'Audit Co', externalWorkType: 'Printing' },
      matrices: [{
        ledger: 'ORDER', sizes: ['M'], sheetTotal: null, computedTotal: 50,
        rows: [{ color: 'USA', cells: { M: 50 }, total: 50 }],
      }],
      externalColors: [
        { color: 'usa', qty: 35, rate: null, area: null },
        { color: 'Germany', qty: 34, rate: 0.5, area: null },
      ],
    }));
    const ops = created.externalOperation!;
    assert.equal(ops.length, 2);
    assert.deepEqual(ops.map((o) => [o.operationType, o.qty]), [['Printing', 35], ['Printing', 34]]);
    // Matched to the order's colour whatever its case; kept in the note if absent.
    assert.equal((ops[0]!.colorIds as string[]).length, 1);
    assert.deepEqual(ops[1]!.colorIds, []);
    assert.match(String(ops[1]!.notes), /Germany/);
  });

  test('imported stock is recorded as stock rows as well as ledger cells', async () => {
    const created = await commit(extraction({
      matrices: [
        {
          ledger: 'ORDER', sizes: ['M', 'L'], sheetTotal: null, computedTotal: 300,
          rows: [{ color: 'Navy', cells: { M: 100, L: 200 }, total: 300 }],
        },
        {
          ledger: 'STOCK', sizes: ['M', 'l'], sheetTotal: null, computedTotal: 30,
          rows: [{ color: 'NAVY', cells: { M: 10, l: 20 }, total: 30 }],
        },
      ],
    }));
    const stockCells = created.stageQuantity!.filter((q) => q.ledger === 'STOCK');
    assert.deepEqual(stockCells.map((q) => q.qty), [10, 20]);
    // The same cells, in the Stock step's own terms, so neither can wipe the other.
    assert.deepEqual(
      created.stockRecord!.map((s) => [s.colorName, s.sizeName, s.availableQty]),
      [['Navy', 'M', 10], ['Navy', 'L', 20]],
    );
  });
});

describe('the costing record', () => {
  test('a workbook with no dollar rate leaves the rate empty, not 48.5', async () => {
    const created = await commit(extraction({ costing: { dollarRate: null, dailyCostEgp: 1867 } }));
    assert.equal(created.costingRecord![0]!.dollarRate, null);
  });

  test('a rate the workbook states is kept', async () => {
    const created = await commit(extraction({ costing: { dollarRate: 50.25, dailyCostEgp: 1867 } }));
    assert.equal(created.costingRecord![0]!.dollarRate, 50.25);
  });
});
