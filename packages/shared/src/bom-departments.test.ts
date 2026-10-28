import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bomItemsFor, bomDepartmentOf, bomCategoryFor, bomItemName, BOM_DEPARTMENTS } from './bom-departments.js';

test('each department offers the template list', () => {
  assert.deepEqual(bomItemsFor('Production').slice(0, 7), ['Washing Inst.', 'Elastic', 'Tie Cord', 'Thread', 'Tape', 'Sponge', 'Side Woven']);
  assert.ok(bomItemsFor('Press').includes('Sponser'));
  assert.ok(bomItemsFor('Packing').includes('Carton'));
  assert.deepEqual(bomItemsFor('Yoko'), ['Yoko Collar', 'Yoko Cuffs']);
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
    // "Tape", "Size", "Logo" are on other departments' lists; typed under this
    // one they are this department's, and come back to it.
    for (const raw of [...bomItemsFor(d), 'A typed item', 'Tape', 'Size', 'Logo', 'Collar']) {
      const item = bomItemName(d, raw);
      assert.equal(bomDepartmentOf(item, bomCategoryFor(d, item)), d, `${d} / ${item}`);
    }
  }
});

test('a part typed under Yoko is named as one, and a named one is left alone', () => {
  assert.equal(bomItemName('Yoko', 'Collar'), 'Yoko Collar');
  assert.equal(bomItemName('Yoko', '  yoko  cuffs '), 'yoko cuffs');
  assert.equal(bomItemName('Yoko', ''), '');
  assert.equal(bomItemName('Press', 'Collar'), 'Collar');
  assert.equal(bomItemName(null, ' Collar '), 'Collar');
  assert.equal(bomDepartmentOf('Yoko Collar', 'FABRIC'), 'Yoko');
  assert.equal(bomDepartmentOf('Collar', 'FABRIC'), 'Fabric');
});
