import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bomItemsFor, bomDepartmentOf, bomCategoryFor, BOM_DEPARTMENTS } from './bom-departments.js';

test('each department offers the template list', () => {
  assert.deepEqual(bomItemsFor('Production').slice(0, 7), ['Washing Inst.', 'Elastic', 'Tie Cord', 'Thread', 'Tape', 'Sponge', 'Side Woven']);
  assert.ok(bomItemsFor('Press').includes('Sponser'));
  assert.ok(bomItemsFor('Packing').includes('Carton'));
  assert.deepEqual(bomItemsFor('Yoko'), []);
});

test('a saved line reads back to its department', () => {
  assert.equal(bomDepartmentOf('Washing Inst.', 'LABEL'), 'Production');
  assert.equal(bomDepartmentOf('carton', 'CARTON'), 'Packing');
  assert.equal(bomDepartmentOf('Yoko collar', 'FABRIC'), 'Yoko');
  assert.equal(bomDepartmentOf('Main Fabric', 'FABRIC'), 'Fabric');
  assert.equal(bomDepartmentOf('Club crest transfer', 'TRANSFER'), 'Press');
  assert.equal(bomDepartmentOf('Something', 'OTHER'), null);
});

test('every listed item and every typed item round-trips to the same department', () => {
  for (const d of BOM_DEPARTMENTS) {
    for (const item of [...bomItemsFor(d), 'A typed item']) {
      if (d === 'Yoko' && item === 'A typed item') continue; // a typed Yoko line is stored as fabric
      assert.equal(bomDepartmentOf(item, bomCategoryFor(d, item)), d, `${d} / ${item}`);
    }
  }
});
