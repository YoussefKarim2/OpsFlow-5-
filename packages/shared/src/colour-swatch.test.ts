import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { swatchFor, colourHexFor } from './colour-swatch.js';

describe('a swatch from a colour name', () => {
  test('plain names and the abbreviations purchase orders use', () => {
    assert.equal(colourHexFor('Navy'), '#1b2a4a');
    assert.equal(colourHexFor('ROY/WHT')!, '#1e4fd8');
    assert.deepEqual(swatchFor('ROY/WHT')!.hexes, ['#1e4fd8', '#ffffff']);
    assert.deepEqual(swatchFor('ATH. GOLD')!.hexes, ['#d4a017']);
    assert.deepEqual(swatchFor('A.GLD/ROYAL')!.hexes, ['#d4a017', '#1e4fd8']);
    assert.deepEqual(swatchFor('SKY BLUE')!.hexes, ['#8fc5f0']);
    assert.deepEqual(swatchFor('Black/Yellow 020')!.hexes, ['#111111', '#f2d21b'], 'the colour code is not a colour');
  });

  test('a style prefix is skipped and a two-tone name is two tones', () => {
    assert.deepEqual(swatchFor('Harrogate Shirt — RED/BLACK')!.hexes, ['#d7263d', '#111111']);
    assert.deepEqual(swatchFor('Red & Black')!.hexes, ['#d7263d', '#111111']);
    assert.deepEqual(swatchFor('Bleu Marine / Blanc')!.hexes, ['#1b2a4a']);
  });

  test('a name nothing recognises gets no swatch rather than a wrong one', () => {
    assert.equal(swatchFor('Rosetta'), null);
    assert.equal(swatchFor('USA'), null);
    assert.equal(swatchFor(''), null);
    assert.equal(swatchFor(null), null);
  });
});
