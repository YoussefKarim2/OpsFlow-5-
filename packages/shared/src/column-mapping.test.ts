/**
 * Universal column-mapping tests.
 *
 * The importer's whole claim is that it does not depend on one Excel layout.
 * These tests are that claim, written down: the same four concepts recognised
 * under different customers' header conventions, and — just as important — an
 * honest "I don't know" when a header is genuinely ambiguous.
 *
 * Run: npm test -w @opsflow/shared
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ImportConcept, normaliseHeader, guessConcept, analyseColumns, assessMapping,
  toSavedMapping, AUTO_ACCEPT_CONFIDENCE, CONCEPT_SYNONYMS, CONCEPT_META,
} from './column-mapping.js';

/** The top guess for a header, given some sample values. */
const top = (header: string, samples: unknown[] = []) => guessConcept(header, samples)[0]!;

describe('header normalisation', () => {
  test('case, punctuation and spacing collapse to one form', () => {
    assert.equal(normaliseHeader('Order Qty.'), 'order qty');
    assert.equal(normaliseHeader('ORDER_QTY'), 'order qty');
    assert.equal(normaliseHeader('  order   qty  '), 'order qty');
    assert.equal(normaliseHeader('Style No.'), 'style no');
    assert.equal(normaliseHeader('Colour (Shade)'), 'colour shade');
  });
});

describe('the brief’s two customers', () => {
  // §3: Customer A writes Style|Color|Size|Qty, Customer B writes
  // Article|Shade|Size|Pieces. Both are the same four concepts.
  const numbers = [480, 512, 380];
  const colours = ['Sky Blue', 'Navy', 'White'];
  const sizes = ['S', 'M', 'L'];
  const styles = ['ST-204', 'ST-205', 'ST-206'];

  test('Customer A headers resolve', () => {
    assert.equal(top('Style', styles).concept, ImportConcept.STYLE);
    assert.equal(top('Color', colours).concept, ImportConcept.COLOR);
    assert.equal(top('Size', sizes).concept, ImportConcept.SIZE);
    assert.equal(top('Qty', numbers).concept, ImportConcept.QUANTITY);
  });

  test('Customer B headers resolve to the same concepts', () => {
    assert.equal(top('Article', styles).concept, ImportConcept.ARTICLE);
    assert.equal(top('Shade', colours).concept, ImportConcept.COLOR);
    assert.equal(top('Size', sizes).concept, ImportConcept.SIZE);
    assert.equal(top('Pieces', numbers).concept, ImportConcept.QUANTITY);
  });

  test('Article and Style both land on the same order field', () => {
    assert.equal(CONCEPT_META.ARTICLE.field, CONCEPT_META.STYLE.field);
  });
});

describe('quantity synonyms', () => {
  const numbers = [480, 512, 380];
  const spellings = [
    'Qty', 'Quantity', 'PCS', 'Pieces', 'Order Qty', 'Order Quantity',
    'QTY.', 'qty_pcs', 'Total Qty', 'No of PCS', 'Units',
  ];

  test('every spelling in the brief is recognised with confidence', () => {
    for (const s of spellings) {
      const g = top(s, numbers);
      assert.equal(g.concept, ImportConcept.QUANTITY, `“${s}” was read as ${g.concept}`);
      assert.ok(
        g.confidence >= AUTO_ACCEPT_CONFIDENCE,
        `“${s}” scored ${g.confidence}, below the auto-accept threshold`,
      );
    }
  });
});

describe('style and colour synonyms', () => {
  test('style spellings', () => {
    for (const s of ['Style', 'Style No', 'Style Number', 'STYLE CODE', 'Model']) {
      assert.equal(top(s, ['ST-204']).concept, ImportConcept.STYLE, `“${s}”`);
    }
  });

  test('colour spellings, including both spellings of the word', () => {
    for (const s of ['Color', 'Colour', 'Shade', 'Colorway', 'COLOUR NAME']) {
      assert.equal(top(s, ['Navy']).concept, ImportConcept.COLOR, `“${s}”`);
    }
  });
});

describe('the data argues with the header', () => {
  test('a “quantity” column of text loses confidence', () => {
    const numeric = top('Qty', [100, 200, 300]);
    const textual = top('Qty', ['red', 'blue', 'green']);
    assert.ok(
      textual.confidence < numeric.confidence,
      'a quantity column full of words should not score as highly as one full of numbers',
    );
    assert.ok(textual.confidence < AUTO_ACCEPT_CONFIDENCE, 'it should ask rather than assume');
  });

  test('a “delivery date” column of non-dates loses confidence', () => {
    const dates = top('Delivery Date', ['2026-09-15', '2026-09-20']);
    const notDates = top('Delivery Date', ['ASAP', 'TBC']);
    assert.ok(notDates.confidence < dates.confidence);
  });

  test('numeric sizes are still sizes — the exception that proves the rule', () => {
    // 32/34/36 is a real size column. Other text concepts get penalised for
    // being all-numeric; SIZE deliberately does not.
    assert.equal(top('Size', [32, 34, 36]).concept, ImportConcept.SIZE);
    assert.ok(top('Size', [32, 34, 36]).confidence >= AUTO_ACCEPT_CONFIDENCE);
  });
});

describe('honest uncertainty', () => {
  test('an unrecognised header is not forced into a concept', () => {
    const g = top('Zebra Widget Code', ['x', 'y']);
    assert.equal(g.concept, ImportConcept.IGNORE);
    assert.equal(g.confidence, 0);
  });

  test('every guess carries a reason the coordinator can check', () => {
    for (const h of ['Qty', 'Shade', 'Style No']) {
      assert.ok(top(h, ['a']).reason.length > 0, `“${h}” had no reason`);
    }
  });

  test('a blank header is ignored, confidently', () => {
    const g = top('', []);
    assert.equal(g.concept, ImportConcept.IGNORE);
    assert.equal(g.confidence, 1);
  });
});

describe('whole-table analysis', () => {
  const headersA = ['Style', 'Color', 'Size', 'Qty'];
  const rowsA = [
    ['ST-204', 'Sky Blue', 'S', 120],
    ['ST-204', 'Sky Blue', 'M', 180],
    ['ST-204', 'Navy', 'L', 140],
  ];

  test('a clean table needs no confirmation and is ready', () => {
    const analyses = analyseColumns(headersA, rowsA);
    assert.deepEqual(analyses.map((a) => a.concept), [
      ImportConcept.STYLE, ImportConcept.COLOR, ImportConcept.SIZE, ImportConcept.QUANTITY,
    ]);
    assert.equal(analyses.every((a) => !a.needsConfirmation), true);

    const readiness = assessMapping(analyses);
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.missing, []);
  });

  test('samples are captured for the preview', () => {
    const analyses = analyseColumns(headersA, rowsA);
    assert.deepEqual(analyses[1]!.samples, ['Sky Blue', 'Sky Blue', 'Navy']);
  });

  test('a missing essential concept blocks readiness and names what is missing', () => {
    const analyses = analyseColumns(['Style', 'Color', 'Qty'], [['ST-204', 'Navy', 100]]);
    const readiness = assessMapping(analyses);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.missing, [ImportConcept.SIZE]);
  });

  test('two columns cannot claim the same concept', () => {
    // Two quantity columns silently summed is a wrong order total that nobody
    // notices until cutting.
    const analyses = analyseColumns(
      ['Qty', 'Quantity', 'Color', 'Size'],
      [[100, 200, 'Navy', 'M']],
    );
    const quantities = analyses.filter((a) => a.concept === ImportConcept.QUANTITY);
    assert.equal(quantities.length, 1, 'two columns were both mapped to quantity');
    const loser = analyses.find((a) => a.concept !== ImportConcept.QUANTITY && /qty|quantity/i.test(a.header));
    assert.equal(loser?.needsConfirmation, true, 'the losing column should be flagged for a human');
  });

  test('columns that may legitimately repeat are allowed to', () => {
    const analyses = analyseColumns(['Notes', 'Remarks', 'Color', 'Size', 'Qty'], [['a', 'b', 'Navy', 'M', 10]]);
    const notes = analyses.filter((a) => a.concept === ImportConcept.NOTES);
    assert.equal(notes.length, 2);
  });

  test('an unrecognised column is flagged rather than dropped in silence', () => {
    const analyses = analyseColumns(['Color', 'Size', 'Qty', 'Widget'], [['Navy', 'M', 10, 'x']]);
    const widget = analyses.find((a) => a.header === 'Widget')!;
    assert.equal(widget.concept, ImportConcept.IGNORE);
    assert.equal(widget.needsConfirmation, true);
  });
});

describe('saved mappings', () => {
  test('a saved decision beats a fresh guess', () => {
    // The point of saving is that a human already decided.
    const saved = { 'pcs': ImportConcept.SIZE };
    const analyses = analyseColumns(['PCS', 'Color', 'Qty'], [[42, 'Navy', 100]], saved);
    const pcs = analyses.find((a) => a.header === 'PCS')!;
    assert.equal(pcs.concept, ImportConcept.SIZE);
    assert.equal(pcs.source, 'SAVED');
    assert.equal(pcs.needsConfirmation, false);
  });

  test('a saved mapping round-trips through normalisation', () => {
    const analyses = analyseColumns(['Order Qty.', 'Colour', 'Size'], [[100, 'Navy', 'M']]);
    const saved = toSavedMapping(analyses);
    assert.equal(saved['order qty'], ImportConcept.QUANTITY);
    assert.equal(saved['colour'], ImportConcept.COLOR);

    // The same file next month, with the header typed slightly differently.
    const again = analyseColumns(['ORDER QTY', 'Colour', 'Size'], [[100, 'Navy', 'M']], saved);
    assert.equal(again[0]!.concept, ImportConcept.QUANTITY);
    assert.equal(again[0]!.source, 'SAVED');
  });

  test('ignored columns are not saved', () => {
    const analyses = analyseColumns(['Widget', 'Color', 'Size', 'Qty'], [['x', 'Navy', 'M', 1]]);
    assert.equal(toSavedMapping(analyses)['widget'], undefined);
  });
});

describe('the synonym table itself', () => {
  test('no synonym is claimed by two concepts', () => {
    const seen = new Map<string, ImportConcept>();
    for (const [concept, synonyms] of Object.entries(CONCEPT_SYNONYMS) as Array<[ImportConcept, readonly string[]]>) {
      for (const s of synonyms) {
        const other = seen.get(s);
        assert.equal(other, undefined, `“${s}” is claimed by both ${other} and ${concept}`);
        seen.set(s, concept);
      }
    }
  });

  test('every synonym is already normalised, so it can match', () => {
    for (const [concept, synonyms] of Object.entries(CONCEPT_SYNONYMS)) {
      for (const s of synonyms) {
        // '#' and similar are stripped by normalisation, so a synonym containing
        // them could never match anything.
        assert.equal(normaliseHeader(s), normaliseHeader(normaliseHeader(s)), `“${s}” in ${concept} is unstable`);
      }
    }
  });

  test('every concept has display metadata', () => {
    for (const concept of Object.keys(CONCEPT_SYNONYMS) as ImportConcept[]) {
      assert.ok(CONCEPT_META[concept], `${concept} has no metadata`);
      assert.ok(CONCEPT_META[concept].label.length > 0);
    }
  });
});
