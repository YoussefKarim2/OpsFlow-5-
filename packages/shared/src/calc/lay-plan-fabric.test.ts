import { describe, test as it } from 'node:test';
import assert from 'node:assert/strict';
import { layPlanFabric, layFabricKey, type LayInput } from './materials.js';

const lay = (o: Partial<LayInput>): LayInput => ({
  id: Math.random().toString(36), fabric: 'Rosetta', color: 'White', panel: 'ALL',
  ratio: '(S1), (M1)', layers: 10, markerLengthM: 2, ...o,
});

describe('layPlanFabric', () => {
  it('sums each fabric and colour, recorded totals first', () => {
    const out = layPlanFabric([
      lay({ totalLengthM: 21 }),
      lay({ layers: 5 }), // 5 × 2 = 10 m
      lay({ color: 'Black', layers: 4, markerLengthM: 1.5 }),
    ]);
    assert.deepEqual(out, [
      { fabric: 'Rosetta', color: 'White', metres: 31, consumptionPerPiece: 31 / 30, from: 'LAYS' },
      { fabric: 'Rosetta', color: 'Black', metres: 6, consumptionPerPiece: 0.75, from: 'LAYS' },
    ].map((f) => ({ ...f, consumptionPerPiece: Math.round(f.consumptionPerPiece * 1e6) / 1e6 })));
  });

  it('matches case and spacing loosely, and ignores panel rows with no length', () => {
    const out = layPlanFabric([
      lay({ fabric: 'Rosetta ', color: 'white' }),
      lay({ fabric: 'ROSETTA', color: 'White' }),
      lay({ color: 'Lime', panel: 'Front', markerLengthM: 0, layers: 1 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.metres, 40);
  });

  it('gives no metres per piece when the pair is cut in different panels', () => {
    const out = layPlanFabric([lay({ panel: 'Front' }), lay({ panel: 'Back' })]);
    assert.equal(out[0]!.consumptionPerPiece, null);
    assert.equal(out[0]!.metres, 40);
  });

  it("adds the sheet's own fabric figures only where no lay uses that fabric and colour", () => {
    const out = layPlanFabric([lay({})], [
      { fabric: 'rosetta', color: 'WHITE', metres: 999 },
      { fabric: 'Rib 37', color: 'Black', metres: 14 },
      { fabric: 'Lining', color: null, metres: null },
    ]);
    assert.deepEqual(out.map((f) => [f.fabric, f.color, f.metres, f.from]), [
      ['Rosetta', 'White', 20, 'LAYS'],
      ['Rib 37', 'Black', 14, 'SHEET'],
    ]);
  });

  it('keys ignore case and spacing', () => {
    assert.equal(layFabricKey(' Rib  37', 'black'), layFabricKey('RIB 37', 'Black '));
    assert.equal(layFabricKey('Rib', null), layFabricKey('rib', ''));
  });
});
