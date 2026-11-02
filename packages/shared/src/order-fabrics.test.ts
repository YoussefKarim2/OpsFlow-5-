import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderFabrics, fabricFields } from './order-fabrics.js';

test('the fabric list: slots first, blanks and repeats dropped', () => {
  assert.deepEqual(orderFabrics({ fabric: 'Rosetta', fabric2: null, fabric3: 'Rib 37', moreFabrics: ['Mesh', 'rosetta', ' '] }), ['Rosetta', 'Rib 37', 'Mesh']);
  assert.deepEqual(fabricFields(['A', 'B', 'C', 'D', 'E']), { fabric: 'A', fabric2: 'B', fabric3: 'C', moreFabrics: ['D', 'E'] });
  assert.deepEqual(fabricFields([]), { fabric: null, fabric2: null, fabric3: null, moreFabrics: [] });
});
