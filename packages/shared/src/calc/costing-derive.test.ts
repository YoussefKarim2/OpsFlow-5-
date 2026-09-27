/**
 * What Actual Costing may and may not claim.
 *
 * The rule these tests exist to hold is that a missing price produces no
 * *cost* rather than a zero. A zero is a claim that something was free; a blank
 * is a claim that nobody has said yet, and a costing screen that confuses the
 * two is worse than one that shows less.
 *
 * Materials are listed one row per item, because the sheet's costing table has
 * a consumption, a unit and a unit price column and a collapsed category has
 * none of the three. An unpriced row still appears — with its price blank —
 * so it is visible as the thing still waiting on a price.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveCostLines, bomGroupFor, bomSourceRef, sourceRefCovers, visibleDerivedLines,
  type DerivableInputs,
} from './costing-derive.js';

const EMPTY: DerivableInputs = { bom: [], external: [] };

describe('deriving cost lines from the production sections', () => {
  test('nothing recorded means nothing claimed', () => {
    assert.deepEqual(deriveCostLines(EMPTY), []);
  });

  test('only what was issued is costed; the plan is carried for reference', () => {
    // An actual costing may not report a plan as a fact. A row with nothing
    // issued arrives blank, with its planned figure alongside.
    const [line] = deriveCostLines({
      ...EMPTY,
      bom: [{ id: 'b1', category: 'FABRIC', item: 'Jersey', issuedQty: 0, requiredQty: 500, unit: 'M', unitPriceUsd: 2 }],
    });
    assert.equal(line!.quantity, null, 'nothing issued is not a consumption');
    assert.equal(line!.estimatedQty, 500, 'but the plan is there to measure against');
  });

  test('each material is its own row, keeping consumption, unit and price', () => {
    // The sheet's UsedFabric block: one line per fabric, not one lump labelled
    // "Fabric". Consumption and unit price are columns, so they must survive.
    const lines = deriveCostLines({
      ...EMPTY,
      bom: [
        { id: 'b2', category: 'FABRIC', item: 'Jersey', issuedQty: 100, requiredQty: 100, unit: 'M', unitPriceUsd: 2 },
        { id: 'b3', category: 'FABRIC', item: 'Rib', issuedQty: 50, requiredQty: 50, unit: 'M', unitPriceUsd: 1 },
      ],
    });
    assert.equal(lines.length, 2);
    const jersey = lines.find((l) => l.label === 'Jersey')!;
    assert.equal(jersey.group, 'FABRIC');
    assert.equal(jersey.quantity, 100);
    assert.equal(jersey.unit, 'M');
    assert.equal(jersey.unitPriceUsd, 2);
    // Follow it back — to the row, not only the category, so the sheet can
    // edit or remove this fabric without touching the other one.
    assert.equal(jersey.sourceRef, bomSourceRef('FABRIC', 'b2'));
    assert.notEqual(lines[0]!.sourceRef, lines[1]!.sourceRef);
  });

  test('an unpriced material is shown, with no price rather than a zero', () => {
    // The dangerous case is a silent one: a fabric total that is quietly
    // missing a fabric and looks complete. The row appears, priced at nothing,
    // and contributes no cost — so the gap is on screen instead of hidden.
    const lines = deriveCostLines({
      ...EMPTY,
      bom: [
        { id: 'b4', category: 'FABRIC', item: 'Jersey', issuedQty: 100, requiredQty: 100, unit: 'M', unitPriceUsd: 2 },
        { id: 'b5', category: 'FABRIC', item: 'Mesh', issuedQty: 20, requiredQty: 20, unit: 'M', unitPriceUsd: null },
      ],
    });
    assert.equal(lines.length, 2);
    const mesh = lines.find((l) => l.label === 'Mesh')!;
    assert.equal(mesh.unitPriceUsd, null);
    assert.notEqual(mesh.unitPriceUsd, 0);
  });

  test('a missing quantity leaves the consumption blank, not zero', () => {
    const [line] = deriveCostLines({
      ...EMPTY,
      bom: [{ id: 'b6', category: 'LABEL', item: 'Neck label', issuedQty: null, requiredQty: null, unit: 'PCS', unitPriceUsd: 0.1 }],
    });
    assert.equal(line!.quantity, null);
    assert.equal(line!.group, 'ACCESSORY');
  });

  test('fabric is its own group; everything else the BOM holds is an accessory', () => {
    assert.equal(bomGroupFor('FABRIC'), 'FABRIC');
    for (const c of ['LABEL', 'BADGE', 'CARTON', 'THREAD', 'OTHER']) {
      assert.equal(bomGroupFor(c), 'ACCESSORY', `${c} should be an accessory cost`);
    }
  });

  test('outside work is grouped by operation and traceable to it', () => {
    const lines = deriveCostLines({
      ...EMPTY,
      external: [
        { operationType: 'PRINTING', qty: 500, unitPriceUsd: 0.2 },
        { operationType: 'PRINTING', qty: 100, unitPriceUsd: 0.2 },
        { operationType: 'EMBROIDERY', qty: 200, unitPriceUsd: 0.5 },
      ],
    });
    assert.equal(lines.length, 2);
    const printing = lines.find((l) => l.sourceRef === 'external:PRINTING')!;
    assert.equal(printing.group, 'EXTERNAL');
    assert.equal(printing.quantity, 600);            // 500 + 100
    assert.equal(printing.unitPriceUsd, 0.2);        // blended, so qty × price = 120
    assert.equal(printing.quantity! * printing.unitPriceUsd!, 120);
  });

  test('consignments sent out at different prices blend to the true cost', () => {
    const [line] = deriveCostLines({
      ...EMPTY,
      external: [
        { operationType: 'PRINTING', qty: 100, unitPriceUsd: 0.10 },
        { operationType: 'PRINTING', qty: 100, unitPriceUsd: 0.30 },
      ],
    });
    assert.equal(line!.quantity, 200);
    assert.equal(line!.unitPriceUsd, 0.20);
    assert.equal(line!.quantity! * line!.unitPriceUsd!, 40);   // 10 + 30
  });

  test('an operation with one unpriced consignment claims no cost', () => {
    const [line] = deriveCostLines({
      ...EMPTY,
      external: [
        { operationType: 'PRINTING', qty: 100, unitPriceUsd: 0.10 },
        { operationType: 'PRINTING', qty: 100, unitPriceUsd: null },
      ],
    });
    assert.equal(line!.unitPriceUsd, null, 'a partial sum reads as a complete one');
    assert.equal(line!.quantity, 200, 'the quantity that went out is still known');
  });

  test('no production labour line is derived; the C.M row is that cost', () => {
    // computeCosting never totalled a LABOUR line, yet the sheet listed it
    // with a cost and a share of a total it was not part of — $5,004 at 2175%
    // of a $230 costing. The cut-and-make row replaced it.
    const lines = deriveCostLines({
      bom: [{ id: 'x', category: 'FABRIC', item: 'Jersey', issuedQty: 10, requiredQty: 10, unit: 'M', unitPriceUsd: 2 }],
      external: [{ operationType: 'PRINTING', qty: 10, unitPriceUsd: 1 }],
    });
    assert.ok(lines.every((l) => l.group !== 'LABOUR'));
    assert.ok(lines.every((l) => !l.sourceRef.startsWith('production:')));
  });

  test('every derived line says where it came from', () => {
    const lines = deriveCostLines({
      bom: [{ id: 'b7', category: 'FABRIC', item: 'Jersey', issuedQty: 10, requiredQty: 10, unit: 'M', unitPriceUsd: 2 }],
      external: [{ operationType: 'PRINTING', qty: 10, unitPriceUsd: 1 }],
    });
    assert.equal(lines.length, 2);
    for (const l of lines) assert.match(l.sourceRef, /^(bom|external):.+/);
  });
});

describe('editing or removing one derived row', () => {
  const lines = deriveCostLines({
    ...EMPTY,
    bom: [
      { id: 'f1', category: 'FABRIC', item: 'Jersey', issuedQty: 100, requiredQty: 100, unit: 'M', unitPriceUsd: 2 },
      { id: 'f2', category: 'FABRIC', item: 'Rib', issuedQty: 50, requiredQty: 50, unit: 'M', unitPriceUsd: 1 },
      { id: 'a1', category: 'LABEL', item: 'Neck label', issuedQty: 10, requiredQty: 10, unit: 'PCS', unitPriceUsd: 0.1 },
    ],
    external: [{ operationType: 'PRINTING', qty: 10, unitPriceUsd: 1 }],
  });
  const labels = (ls: readonly { label: string }[]) => ls.map((l) => l.label).sort();

  test('editing one fabric row leaves the other fabric rows alone', () => {
    // Every fabric row used to carry `bom:FABRIC`, so the edited copy claimed
    // all of them and the rest vanished from the costing.
    const kept = visibleDerivedLines(lines, [bomSourceRef('FABRIC', 'f1')], []);
    assert.deepEqual(labels(kept), ['Neck label', 'Printing', 'Rib']);
  });

  test('deleting one fabric row hides only that row', () => {
    const kept = visibleDerivedLines(lines, [], [bomSourceRef('FABRIC', 'f2')]);
    assert.deepEqual(labels(kept), ['Jersey', 'Neck label', 'Printing']);
  });

  test('a reference saved before rows were named still means the whole category', () => {
    // Existing costings hold `bom:FABRIC`; what they meant must not change.
    assert.deepEqual(labels(visibleDerivedLines(lines, [], ['bom:FABRIC'])), ['Neck label', 'Printing']);
    assert.deepEqual(labels(visibleDerivedLines(lines, ['bom:FABRIC'], [])), ['Neck label', 'Printing']);
  });

  test('the category rule does not leak into other categories or sections', () => {
    assert.ok(!sourceRefCovers('bom:FAB', bomSourceRef('FABRIC', 'f1')));
    assert.ok(!sourceRefCovers('bom', bomSourceRef('FABRIC', 'f1')));
    assert.ok(!sourceRefCovers(bomSourceRef('FABRIC', 'f1'), bomSourceRef('FABRIC', 'f10')));
    assert.ok(sourceRefCovers('external:PRINTING', 'external:PRINTING'));
    assert.ok(!sourceRefCovers('external:PRINT', 'external:PRINTING'));
  });

  test('nothing claimed or hidden leaves every line', () => {
    assert.equal(visibleDerivedLines(lines, [null, undefined, ''], []).length, lines.length);
  });
});
