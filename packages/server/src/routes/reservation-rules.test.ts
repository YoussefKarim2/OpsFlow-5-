import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canDecideReservations } from '../config.js';
import { materialDeletionBlocker } from './inventory.js';

describe('who decides reservation requests', () => {
  const deciders = ['mahmoud@soccertex.biz', 'samy@soccertex.biz', 'ibrahim@soccertex.biz'];

  test('a super administrator always decides', () => {
    assert.equal(canDecideReservations({ email: 'anyone@soccertex.biz', isSuperAdmin: true }, deciders), true);
  });

  test('a named decider decides, whatever the case of their address', () => {
    assert.equal(canDecideReservations({ email: 'Mahmoud@SoccerTex.biz', isSuperAdmin: false }, deciders), true);
    assert.equal(canDecideReservations({ email: 'ibrahim@soccertex.biz', isSuperAdmin: false }, deciders), true);
  });

  test('anyone else may only ask', () => {
    assert.equal(canDecideReservations({ email: 'hassona@soccertex.biz', isSuperAdmin: false }, deciders), false);
    assert.equal(canDecideReservations({ email: 'ibrahem@soccertex.biz', isSuperAdmin: false }, deciders), false, 'a similar name is not the same person');
  });
});

describe('deleting a material', () => {
  const clean = { name: 'Rosetta', movements: 0, reservations: 0, bomLines: 0, onHand: 0 };

  test('a material with no history can be deleted', () => {
    assert.equal(materialDeletionBlocker(clean), null);
  });

  test('any history refuses it, and the reason names what would be lost', () => {
    const r = materialDeletionBlocker({ ...clean, movements: 3, onHand: 12, reservations: 1, bomLines: 2 });
    assert.match(r!, /3 stock movements/);
    assert.match(r!, /stock on hand/);
    assert.match(r!, /1 reservation\b/);
    assert.match(r!, /2 bill-of-materials lines/);
    assert.match(r!, /inactive/);
  });
});
