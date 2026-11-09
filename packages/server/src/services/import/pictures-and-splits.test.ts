/**
 * Screenshots read by text recognition, and one PO split into several orders.
 *
 * The screenshot fixture is what the browser's procedure (web/src/lib/ocr-read.ts)
 * read from a 1400px screenshot of Donkey PO 600772 — two passes, at 2× and
 * 3× — trimmed to the PO line and the item table. Its small print came back
 * garbled in places ("9.000.00", a lone "S" as "3"), which is the point.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

import {
  consensusWords, extractFromPicture, fixDigits, imageMimeOf, isOcrBundle, ocrPages,
  ocrPassesSchema, packOcrBundle, unpackOcrBundle, type OcrPasses,
} from './ocr-bundle.js';
import { splitExtraction, splitOrderName } from './split-orders.js';
import { commitImports } from './committer.js';
import { toNum } from './pdf-extractor.js';
import { parseAmount } from './size-grid.js';
import { readPoLines } from './po-lines.js';
import type { ExtractionResult } from './extractor.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const screenshot: OcrPasses = ocrPassesSchema.parse(JSON.parse(
  readFileSync(new URL('./fixtures/donkey-600772-screenshot.ocr.json', import.meta.url), 'utf8'),
));

describe('a screenshot of a PO', () => {
  test('is read into the same order as the PDF', async () => {
    const r = await extractFromPicture(packOcrBundle(PNG, screenshot));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(r.fields.poNumber, '600772');
    assert.deepEqual(m.sizes, ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
    assert.deepEqual(m.rows.map((x) => [Object.values(x.cells), x.unitPrice]), [
      [[10, 40, 80, 100, 100, 60, 10], 25],
      [[15, 60, 120, 150, 150, 90, 15], 15],
    ]);
    assert.match(m.rows[0]!.color, /Track Jacket/);
    assert.match(m.rows[1]!.color, /26 Jersey/);
    // Confirmed by the document's own figures.
    assert.equal(r.confidence, 0.85);
  });

  test('always says it was read from a picture, and speaks of the picture, not a PDF', async () => {
    const r = await extractFromPicture(packOcrBundle(PNG, screenshot));
    assert.match(r.issues[0]!.message, /Read from a picture by text recognition/);
    assert.ok(r.issues.every((i) => !/\bthe PDF\b/.test(i.message)));
  });

  test('a picture with no words says so, rather than "no text layer"', async () => {
    const r = await extractFromPicture(packOcrBundle(PNG, [{ width: 100, height: 100, words: [] }]));
    assert.match(r.issues[0]!.message, /No text could be read in this picture/);
    assert.ok(r.issues.every((i) => !/text layer/.test(i.message)));
  });

  test('the picture and its words are stored together and come back whole', () => {
    const bundle = packOcrBundle(PNG, screenshot);
    assert.ok(isOcrBundle(bundle));
    assert.ok(!isOcrBundle(PNG));
    const back = unpackOcrBundle(bundle);
    assert.equal(back.mime, 'image/png');
    assert.ok(back.image.equals(PNG));
    assert.deepEqual(back.passes, screenshot);
  });

  test('only PNG, JPEG and WebP are pictures', () => {
    assert.equal(imageMimeOf(PNG), 'image/png');
    assert.equal(imageMimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
    assert.equal(imageMimeOf(Buffer.from('%PDF-1.7')), null);
    assert.throws(() => packOcrBundle(Buffer.from('GIF89a'), screenshot), /not a PNG, JPEG or WebP/);
  });

  test('a damaged stored bundle is refused by name', () => {
    const bundle = packOcrBundle(PNG, screenshot);
    assert.throws(() => unpackOcrBundle(bundle.subarray(0, 40)), /could not be read back/);
  });

  test('words are scaled so ordinary print is about 6pt tall, top line first', () => {
    const [page] = ocrPages({ width: 1000, height: 500, words: [
      { text: 'Top', x0: 10, y0: 10, x1: 40, y1: 30, baseline: 30 },
      { text: 'Bottom', x0: 10, y0: 400, x1: 70, y1: 420, baseline: 420 },
    ] });
    const top = page!.items.find((i) => i.text === 'Top')!;
    const bottom = page!.items.find((i) => i.text === 'Bottom')!;
    assert.ok(top.y > bottom.y, 'PDF coordinates run upwards');
    assert.equal(Math.round(top.width * 20 / 30), 6);
  });

  test('a number spelled with a letter is mended, a word is not', () => {
    assert.equal(fixDigits('1O0'), '100');
    assert.equal(fixDigits('l5'), '15');
    assert.equal(fixDigits('XS'), 'XS');
    assert.equal(fixDigits('Oil'), 'Oil');
    assert.equal(fixDigits('IO'), 'IO');
  });

  test('passes are joined by vote: the agreed spelling, then a clean number', () => {
    const at = (text: string, x0: number, conf = 50) => ({ text, x0, y0: 10, x1: x0 + 20, y1: 20, baseline: 20, conf });
    const v = consensusWords([
      { width: 200, height: 40, words: [at('#0', 0), at('S', 50)] },
      { width: 200, height: 40, words: [at('80', 1), at('S', 51)] },
      { width: 200, height: 40, words: [at('LH', 0), at('5', 50, 90)] },
    ]);
    assert.deepEqual(v.words.map((w) => w.text), ['80', 'S']);
  });
});

describe('numbers as a picture reads them back', () => {
  test('"9.000.00" is nine thousand, "1.234.567" over a million', () => {
    assert.equal(toNum('9.000.00'), 9000);
    assert.equal(toNum('1.234.567'), 1234567);
    assert.equal(parseAmount('9.000.00'), 9000);
    assert.equal(parseAmount('1.234.567'), 1234567);
    assert.equal(parseAmount('10,000.00'), 10000);
  });

  test('one unreadable size between two a step apart is the size between them', () => {
    const line = (y: number, cells: string[], x0 = 0) => cells.map((text, i) => ({ text, x: x0 + i * 40, end: x0 + i * 40 + 20, y }));
    const lines = [
      line(0, ['Item Code', 'Description', 'Color', 'Pcs', 'Price', 'Amount']),
      line(1, ['MA1', 'Jacket', 'Navy', '200', '10.00', '2,000.00']),
      line(2, ['XS', '3', 'M', 'L'], 100),
      line(3, ['50', '50', '50', '50'], 100),
    ];
    const [item] = readPoLines(lines.map((l) => l.map(({ text, x, end }) => ({ text, x, end }))), new Set(), true);
    assert.deepEqual(item?.sizes, { XS: 50, S: 50, M: 50, L: 50 });
  });
});

function reading(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    profileKey: 'pdf', confidence: 0.85, sheets: [], mappings: [],
    fields: { poNumber: '600772', orderName: 'Club order', clientName: 'Donkey' },
    matrices: [
      {
        ledger: 'ORDER', sizes: ['S', 'M', 'L', '30', '32'], sheetTotal: 900, computedTotal: 900,
        rows: [
          { color: 'Track Jacket — White', cells: { S: 100, M: 100, L: 100 }, total: 300, unitPrice: 25 },
          { color: 'Jersey — White', cells: { S: 100, M: 200 }, total: 300, unitPrice: 15 },
          { color: 'Pants — Navy', cells: { '30': 150, '32': 150 }, total: 300, unitPrice: 18 },
        ],
      },
      { ledger: 'STOCK', sizes: ['S', '30'], sheetTotal: null, computedTotal: 15, rows: [
        { color: 'Track Jacket — White', cells: { S: 5 }, total: 5 },
        { color: 'Pants — Navy', cells: { '30': 10 }, total: 10 },
      ] },
    ],
    lineItems: [], bom: [{ category: 'Fabric', item: 'Poly', description: null, color: null, consumptionPerPiece: 1, requiredQty: 900, unit: 'M', issuedQty: 0, issuedBy: null, issuedTo: null, position: null } as never],
    lays: [], externalColors: [{ color: 'Pants — Navy', qty: 300, rate: 1, area: null }],
    costing: { machineCount: 20 }, issues: [],
    ...over,
  };
}

describe('one PO split into separate orders', () => {
  test('no split is the document as read', () => {
    const r = reading();
    assert.deepEqual(splitExtraction(r, undefined), [r]);
    assert.deepEqual(splitExtraction(r, []), [r]);
  });

  test('models moved out become their own order, with only their sizes', () => {
    const [main, pants] = splitExtraction(reading(), [{ poNumber: '600772-2', colors: ['pants — navy'] }]);
    const grid = (x: ExtractionResult) => x.matrices.find((m) => m.ledger === 'ORDER')!;
    assert.deepEqual(grid(main!).rows.map((r) => r.color), ['Track Jacket — White', 'Jersey — White']);
    assert.deepEqual(grid(main!).sizes, ['S', 'M', 'L']);
    assert.equal(grid(main!).computedTotal, 600);
    assert.deepEqual(grid(pants!).rows.map((r) => [r.color, r.unitPrice]), [['Pants — Navy', 18]]);
    assert.deepEqual(grid(pants!).sizes, ['30', '32']);
    assert.equal(pants!.fields.poNumber, '600772-2');
    assert.equal(pants!.fields.orderName, 'Pants — Navy');
    assert.equal(pants!.fields.clientName, 'Donkey');
  });

  test('stock and outside work follow their model; BOM and costing stay with the document\'s order', () => {
    const [main, pants] = splitExtraction(reading(), [{ poNumber: 'P-2', colors: ['Pants — Navy'] }]);
    const stock = (x: ExtractionResult) => x.matrices.find((m) => m.ledger === 'STOCK')!.rows.map((r) => r.color);
    assert.deepEqual(stock(main!), ['Track Jacket — White']);
    assert.deepEqual(stock(pants!), ['Pants — Navy']);
    assert.equal(main!.externalColors.length, 0);
    assert.equal(pants!.externalColors.length, 1);
    assert.equal(main!.bom.length, 1);
    assert.equal(pants!.bom.length, 0);
    assert.deepEqual(pants!.costing, {});
  });

  test('each order is priced from its own models, and a counted name is recounted', () => {
    const r = reading({ fields: { poNumber: '600772', orderName: 'PO 600772 (3 styles)', pricePerPieceUsd: 19.3333 } });
    const [main, pants] = splitExtraction(r, [{ poNumber: 'P-2', colors: ['Pants — Navy'] }]);
    assert.equal(main!.fields.pricePerPieceUsd, 20);
    assert.equal(pants!.fields.pricePerPieceUsd, 18);
    assert.equal(main!.fields.orderName, 'PO 600772 (2 styles)');
    const [one] = splitExtraction(r, [{ poNumber: 'P-2', colors: ['Pants — Navy', 'Jersey — White'] }]);
    assert.equal(one!.fields.orderName, 'Track Jacket — White');
    // A name the document gave is kept.
    const [named] = splitExtraction(reading(), [{ poNumber: 'P-2', colors: ['Pants — Navy'] }]);
    assert.equal(named!.fields.orderName, 'Club order');
  });

  test('several orders at once', () => {
    const out = splitExtraction(reading(), [
      { poNumber: 'A-2', colors: ['Jersey — White'] },
      { poNumber: 'A-3', colors: ['Pants — Navy'] },
    ]);
    assert.deepEqual(out.map((x) => x.matrices[0]!.rows.map((r) => r.color)), [
      ['Track Jacket — White'], ['Jersey — White'], ['Pants — Navy'],
    ]);
  });

  test('refused by name: a PO used twice, a model twice or unknown, nothing left behind', () => {
    assert.throws(() => splitExtraction(reading(), [{ poNumber: '600772', colors: ['Jersey — White'] }]), /used for two orders/);
    assert.throws(() => splitExtraction(reading(), [
      { poNumber: 'A', colors: ['Jersey — White'] }, { poNumber: 'a', colors: ['Pants — Navy'] },
    ]), /used for two orders/);
    assert.throws(() => splitExtraction(reading(), [
      { poNumber: 'A', colors: ['Jersey — White'] }, { poNumber: 'B', colors: ['Jersey — White'] },
    ]), /in two of the separate orders/);
    assert.throws(() => splitExtraction(reading(), [{ poNumber: 'A', colors: ['Hoodie'] }]), /not a model in the grid/);
    assert.throws(() => splitExtraction(reading(), [{ poNumber: 'A', colors: ['Track Jacket — White', 'Jersey — White', 'Pants — Navy'] }]), /Keep at least one model/);
    assert.throws(() => splitExtraction(reading(), [{ poNumber: '  ', colors: ['Jersey — White'] }]), /PO number is required/);
  });

  test('a long list of models is named, then cut', () => {
    assert.equal(splitOrderName(['A', 'B']), 'A, B');
    assert.ok(splitOrderName(Array.from({ length: 40 }, (_, i) => `Model number ${i}`)).length <= 150);
  });

  test('two orders under one PO are refused before anything is written', async () => {
    let wrote = false;
    const prisma = {
      order: { findUnique: async () => null },
      $transaction: async () => { wrote = true; },
    } as unknown as PrismaClient;
    const a = reading();
    await assert.rejects(commitImports(prisma, [a, a], { actorId: 'u', actorName: 'T' }), /given to two of the orders/);
    assert.equal(wrote, false);
  });
});
