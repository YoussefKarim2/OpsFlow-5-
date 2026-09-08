/**
 * Recovering a table from glyph positions.
 *
 * A PDF has no rows and no columns, only text at coordinates, so the whole
 * question is whether the grid can be rebuilt from geometry. These tests work
 * on synthesised positions rather than a real file: the arithmetic is the part
 * that can be wrong, and a fixture PDF would test pdf.js rather than this.
 *
 * The scan case is here because it is the one failure a user will actually hit,
 * and because an empty extraction and an unreadable document must not look the
 * same from the outside.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoRows, rowToCells, findHeaderRow, extractFromPdf } from './pdf-extractor.js';

const at = (text: string, x: number, y: number, width = text.length * 5) => ({ text, x, y, width });

describe('recovering rows from glyph positions', () => {
  test('glyphs sharing a baseline become one row', () => {
    const rows = groupIntoRows([at('Color', 50, 700), at('Size', 200, 700), at('Qty', 320, 700)]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.map((i) => i.text), ['Color', 'Size', 'Qty']);
  });

  test('rows come back in reading order, not PDF order', () => {
    // PDF y counts up from the bottom of the page, so the largest y is the top
    // line — the reverse of how the page reads.
    const rows = groupIntoRows([at('second', 50, 680), at('first', 50, 700), at('third', 50, 660)]);
    assert.deepEqual(rows.map((r) => r[0]!.text), ['first', 'second', 'third']);
  });

  test('a baseline off by a point or two is still the same line', () => {
    // Real files are not pixel-perfect; 2pt is well inside one line's leading.
    const rows = groupIntoRows([at('Color', 50, 700), at('Size', 200, 698)]);
    assert.equal(rows.length, 1);
  });

  test('a genuine next line is not merged into the previous one', () => {
    const rows = groupIntoRows([at('Color', 50, 700), at('Red', 50, 685)]);
    assert.equal(rows.length, 2);
  });
});

describe('splitting a line into cells', () => {
  test('a wide gap is a column boundary', () => {
    assert.deepEqual(
      rowToCells([at('Red', 50, 700, 20), at('Small', 200, 700, 30), at('120', 320, 700, 15)]),
      ['Red', 'Small', '120'],
    );
  });

  test('a word space is not a column boundary', () => {
    // "Navy Blue" is one colour, not two cells — the distinction the whole
    // extraction rests on.
    assert.deepEqual(
      rowToCells([at('Navy', 50, 700, 22), at('Blue', 75, 700, 20), at('100', 300, 700, 15)]),
      ['Navy Blue', '100'],
    );
  });

  test('a single cell survives intact', () => {
    assert.deepEqual(rowToCells([at('PO 12345', 50, 700, 40)]), ['PO 12345']);
  });
});

describe('finding the table in a page of other things', () => {
  test('a letterhead above the table is skipped', () => {
    const rows = [
      ['ACME Garments Ltd'],
      ['12 Factory Road, Cairo'],
      ['Colour', 'Size', 'Quantity'],
      ['Red', 'S', '100'],
    ];
    const header = findHeaderRow(rows);
    assert.equal(header?.index, 2, 'should pick the headings, not the address');
  });

  test('a page with no table is reported as none rather than guessed at', () => {
    assert.equal(findHeaderRow([['Dear Sir'], ['Please find attached']]), null);
  });
});

describe('extraction as a whole', () => {
  test('a scan is named as a scan, not returned as an empty order', () => {
    // The failure a user will actually hit. "No orders found" would send
    // somebody looking for the problem in the wrong place.
    return extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{ pageNumber: 1, items: [] }],
    }).then((result) => {
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0]!.level, 'ERROR');
      assert.match(result.issues[0]!.message, /scan or a photograph/);
      // Names OCR as the missing capability rather than implying the file is bad.
      assert.match(result.issues[0]!.message, /OCR/);
      assert.match(result.issues[0]!.message, /Nothing was imported/);
      assert.equal(result.confidence, 0);
    });
  });

  test('a readable table produces the same result shape the Excel path does', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          at('Colour', 50, 700, 30), at('Size', 200, 700, 20), at('Quantity', 320, 700, 40),
          at('Red', 50, 685, 20), at('S', 200, 685, 8), at('100', 320, 685, 18),
        ],
      }],
    });
    assert.equal(result.profileKey, 'pdf');
    assert.ok(result.mappings.length >= 3);
    // Never HIGH: a PDF's grid is inferred, so the review screen always asks.
    for (const m of result.mappings) assert.notEqual(m.confidence, 'HIGH');
    // The contract the whole pipeline depends on.
    for (const key of ['matrices', 'bom', 'lays', 'externalColors', 'issues'] as const) {
      assert.ok(key in result, `ExtractionResult must carry ${key}`);
    }
  });
});

/**
 * Reading the rows, not just recognising the columns.
 *
 * The first version of this extractor found the header, scored the columns and
 * returned none of the data — an extraction that reported what it *could* read
 * and then didn't. These tests exist so that cannot come back.
 */
describe('reading the data out of a PDF', () => {
  const row = (y: number, cells: Array<[number, string]>) =>
    cells.map(([x, text]) => at(text, x, y, text.length * 5));

  test('a colour/size/quantity table becomes a matrix', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
          ...row(680, [[50, 'Red'], [200, 'S'], [340, '420']]),
          ...row(660, [[50, 'Red'], [200, 'M'], [340, '610']]),
          ...row(640, [[50, 'Navy'], [200, 'S'], [340, '150']]),
        ],
      }],
    });
    assert.equal(result.matrices.length, 1);
    const m = result.matrices[0]!;
    assert.equal(m.ledger, 'ORDER');
    assert.deepEqual(m.sizes, ['S', 'M']);
    assert.equal(m.rows.length, 2);                       // Red and Navy
    assert.equal(m.rows.find((r) => r.color === 'Red')!.cells.M, 610);
    assert.equal(m.computedTotal, 1180);                  // 420 + 610 + 150
  });

  test('the column order does not matter', async () => {
    // Quantity first, then colour, then size — and different words for each.
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(700, [[50, 'Pieces'], [180, 'Shade'], [320, 'Sz']]),
          ...row(680, [[50, '300'], [180, 'Sky Blue'], [320, 'XL']]),
          ...row(660, [[50, '275'], [180, 'Scarlet'], [320, 'M']]),
        ],
      }],
    });
    assert.equal(result.matrices[0]?.rows.length, 2);
    assert.equal(result.matrices[0]!.computedTotal, 575);
  });

  test('label-and-value lines above the table are read as fields', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(760, [[50, 'PO Number:'], [220, 'HM-2026-8841']]),
          ...row(740, [[50, 'Customer:'], [220, 'Hummel A/S']]),
          ...row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
          ...row(680, [[50, 'Red'], [200, 'S'], [340, '10']]),
        ],
      }],
    });
    assert.equal(result.fields.PO_NUMBER, 'HM-2026-8841');
    assert.equal(result.fields.CLIENT, 'Hummel A/S');
  });

  test('rows with no quantity are skipped rather than imported as zero', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
          ...row(680, [[50, 'Red'], [200, 'S'], [340, '0']]),
          ...row(660, [[50, 'Red'], [200, 'M'], [340, 'TBC']]),
          ...row(640, [[50, 'Red'], [200, 'L'], [340, '90']]),
        ],
      }],
    });
    assert.equal(result.matrices[0]!.computedTotal, 90);
  });

  test('headings with nothing under them are not reported as a successful read', async () => {
    // One line is not a table. Whatever it is called, the result must carry an
    // explanation rather than an empty success.
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
      }],
    });
    assert.equal(result.matrices.length, 0);
    assert.ok(result.issues.some((i) => i.level === 'ERROR'), 'must explain itself');
  });
});

/**
 * A real customer purchase order, positioned as it appears on the page.
 *
 * Meyba's UFEC order, which the first version of this extractor could not read
 * at all: it reported that no column looked like a colour, a size or a quantity
 * and returned nothing. Three separate causes, each worth a test of its own —
 * the sizes are the column headings rather than a column, the colour sits in
 * front of the grid with no heading, and the order-information line above the
 * table matched more concepts than the table's own header did.
 */
describe('a wide size grid, as customers actually send them', () => {
  const at2 = (t: string, x: number, y: number) => at(t, x, y, t.length * 5);

  const meyba = [
    at2('PURCHASE ORDER', 30, 780),
    at2('Order number:', 30, 750), at2('178', 170, 750),
    at2('Date:', 290, 750), at2('04-06-2026', 460, 750),
    at2('Sales order:', 640, 750), at2('817', 790, 750),
    at2('Reference:', 930, 750), at2('UFEC bespoke jersey 2026', 1070, 750),
    at2('UFEC 2026 S/S Jersey (UFEC01010)', 30, 700),
    at2('Season:', 30, 680), at2('26/27', 400, 680), at2('Brand:', 840, 680), at2('MEYBA', 1030, 680),
    at2('XS', 320, 650), at2('S', 435, 650), at2('M', 520, 650), at2('L', 645, 650),
    at2('XL', 750, 650), at2('XXL', 855, 650), at2('XXXL', 965, 650),
    at2('Quantity', 1075, 650), at2('Price', 1140, 650), at2('Total', 1200, 650),
    at2('Yellow/Red', 155, 620), at2('056', 245, 620),
    at2('10', 320, 620), at2('30', 435, 620), at2('80', 520, 620), at2('100', 645, 620),
    at2('57', 750, 620), at2('20', 855, 620), at2('3', 965, 620),
    at2('300', 1075, 620), at2('0,00', 1140, 620), at2('0,00', 1200, 620),
    at2('Total', 155, 585),
    at2('10', 320, 585), at2('30', 435, 585), at2('80', 520, 585), at2('100', 645, 585),
    at2('57', 750, 585), at2('20', 855, 585), at2('3', 965, 585), at2('300', 1075, 585),
  ];

  const read = () => extractFromPdf(Buffer.alloc(0), {
    reader: async () => [{ pageNumber: 1, items: meyba }],
  });

  test('the grid is read, with every size and the right total', async () => {
    const r = await read();
    assert.equal(r.matrices.length, 1);
    const m = r.matrices[0]!;
    assert.deepEqual(m.sizes, ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
    assert.deepEqual(m.rows[0]!.cells, { XS: 10, S: 30, M: 80, L: 100, XL: 57, XXL: 20, XXXL: 3 });
    // The document states 300 itself, so this is checkable against the paper.
    assert.equal(m.computedTotal, 300);
  });

  test('the colour is found although its column has no heading', async () => {
    const r = await read();
    assert.equal(r.matrices[0]!.rows[0]!.color, 'Yellow/Red');
  });

  test("the sheet's own Total row is not imported as a colour", async () => {
    // It has a value in every size column and would otherwise double the order.
    const r = await read();
    assert.equal(r.matrices[0]!.rows.length, 1);
  });

  test('the order information above the table is read as fields', async () => {
    const r = await read();
    assert.equal(r.fields.PO_NUMBER, '178');
    assert.equal(r.fields.ORDER_DATE, '04-06-2026');
    assert.equal(r.fields.SEASON, '26/27');
  });

  test('a wide grid reports no missing colour, size or quantity column', async () => {
    // It legitimately has none — that is what "wide" means — and saying so sends
    // the user to fix something that is not broken.
    const r = await read();
    assert.deepEqual(r.issues, []);
  });

  test('a European decimal is read as a number, not discarded', async () => {
    // "0,00" is a price of zero, and reading it as NaN would lose the column.
    const { toNum } = await import('./pdf-extractor.js');
    assert.equal(toNum('0,00'), 0);
    assert.equal(toNum('1.234,56'), 1234.56);
    assert.equal(toNum('1,234.56'), 1234.56);
    assert.equal(toNum('300'), 300);
    assert.equal(toNum('TBC'), null);
  });
});

/**
 * Everything the purchase order states, not only what it labels.
 *
 * The complaint that produced these tests was that the PO number, date and
 * customer "were not read" — and two different things were true. The number and
 * date *were* extracted and then never shown, because the review screen renders
 * mappings and scalar fields produced none. The customer genuinely was not read:
 * a PO prints the buyer in a letterhead block, not as "Customer:".
 */
describe('reading a purchase order in full', () => {
  const at2 = (t: string, x: number, y: number) => at(t, x, y, t.length * 5);

  const items = [
    at2('Age (Soccertex) Al Shimaa Garment And Embroidery', 360, 700),
    at2('Street 5-Nasr City', 360, 688), at2('. Cairo', 360, 664), at2('Egypt', 360, 652),
    at2('Delivery address', 845, 700), at2('United Kingdom', 845, 676),
    at2('Meyba International SL B.V', 1120, 712), at2('Piekstraat 71', 1180, 700),
    at2('3071 EL Rotterdam', 1160, 688), at2('Netherlands', 1200, 676),
    at2('PURCHASE ORDER', 30, 560),
    at2('Order number:', 30, 530), at2('178', 170, 530),
    at2('Date:', 290, 530), at2('04-06-2026', 460, 530),
    at2('Reference:', 930, 530), at2('UFEC bespoke jersey 2026', 1070, 530),
    at2('Tariff No.:', 30, 505), at2('6109902000', 400, 505),
    at2('UFEC 2026 S/S Jersey (UFEC01010)', 30, 440),
    at2('Season:', 30, 420), at2('26/27', 400, 420),
    at2('XS', 320, 380), at2('S', 435, 380), at2('M', 520, 380), at2('L', 645, 380),
    at2('XL', 750, 380), at2('XXL', 855, 380), at2('XXXL', 965, 380),
    at2('Quantity', 1075, 380), at2('Price', 1140, 380), at2('Total', 1200, 380),
    at2('Yellow/Red', 155, 350), at2('056', 245, 350),
    at2('10', 320, 350), at2('30', 435, 350), at2('80', 520, 350), at2('100', 645, 350),
    at2('57', 750, 350), at2('20', 855, 350), at2('3', 965, 350),
    at2('300', 1075, 350), at2('0,00', 1140, 350), at2('0,00', 1200, 350),
  ];
  const read = () => extractFromPdf(Buffer.alloc(0), {
    reader: async () => [{ pageNumber: 1, items }],
  });

  test('the labelled details are read', async () => {
    const r = await read();
    assert.equal(r.fields.PO_NUMBER, '178');
    assert.equal(r.fields.ORDER_DATE, '04-06-2026');
    assert.equal(r.fields.SEASON, '26/27');
    assert.equal(r.fields.CUSTOMER_REF, 'UFEC bespoke jersey 2026');
  });

  test('the customer is found in the letterhead, where nothing labels it', async () => {
    const r = await read();
    assert.equal(r.fields.CLIENT, 'Meyba International SL B.V');
  });

  test('the supplier is not mistaken for the customer', async () => {
    // This document is addressed *to* the factory, so its own name appears
    // first and is the one company on the page that must not be picked.
    const r = await read();
    assert.doesNotMatch(String(r.fields.CLIENT), /soccertex|shimaa/i);
  });

  test('the style heading gives the order name and the style number', async () => {
    const r = await read();
    assert.equal(r.fields.ORDER_NAME, 'UFEC 2026 S/S Jersey');
    assert.equal(r.fields.STYLE, 'UFEC01010');
  });

  test('"Tariff No." is not read as a player number', async () => {
    // It matches "no" loosely, and a single prose pair has no column of values
    // to disprove the guess. The label must be a synonym, not resemble one.
    const r = await read();
    assert.equal(r.fields.PLAYER_NUMBER, undefined);
  });

  test('a street in the letterhead is not read as a destination', async () => {
    const r = await read();
    assert.notEqual(r.fields.DESTINATION, 'Piekstraat 71');
  });

  test('every field read is shown on the review screen with its value', async () => {
    // The original complaint. A field extracted and not displayed is
    // indistinguishable from one that was never read.
    const r = await read();
    const shown = new Map(r.mappings.filter((m) => m.sampleValue).map((m) => [m.field, m.sampleValue]));
    for (const key of ['PO_NUMBER', 'ORDER_DATE', 'CLIENT', 'STYLE', 'SEASON']) {
      assert.equal(shown.get(key), String(r.fields[key]), `${key} must appear for review`);
    }
  });
});
