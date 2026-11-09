/**
 * A picture of an order — a screenshot — read by text recognition.
 *
 * Recognition runs in the browser (web/src/lib/ocr.ts), not here: it peaks at
 * several hundred megabytes for one picture, which is the server's whole
 * memory, while every coordinator's computer has it to spare. The browser
 * sends the picture and the words it found, each with where it sat; both are
 * stored together as one import file, so the preview, every re-read and the
 * commit all read the same words — the same rule as for any other file.
 *
 * The words become the positioned text a PDF gives (`PdfPage`), so the PDF
 * readers — tables, size grids, PO lines, the piece-count cross-check and the
 * sanity checks — read a screenshot exactly as they read a PDF.
 */

import { z } from 'zod';
import { BadRequestError } from '../../errors.js';
import type { ExtractionResult } from './extractor.js';
import { extractFromPdf, type PdfPage, type TextItem } from './pdf-extractor.js';

const MAGIC = Buffer.from('OPSFLOW-OCR1\n', 'latin1');

/** What the browser reports: each word and its box, in the picture's pixels. */
export const ocrWordsSchema = z.object({
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
  words: z.array(z.object({
    text: z.string().max(200),
    x0: z.number().finite(), y0: z.number().finite(),
    x1: z.number().finite(), y1: z.number().finite(),
    /** Where the word's line sits (its baseline), when the engine reports one. */
    baseline: z.number().finite().nullable().optional(),
    conf: z.number().finite().optional(),
  })).max(20_000),
});
export type OcrWords = z.infer<typeof ocrWordsSchema>;
type OcrWord = OcrWords['words'][number];

/**
 * The browser reads a picture more than once, each time enlarged by a
 * different amount: small print that one enlargement garbles another reads
 * cleanly. All readings are in the picture's own pixels, so the same word sits
 * in the same place in each, and `consensusWords` takes the reading most of
 * them agree on.
 */
export const ocrPassesSchema = z.array(ocrWordsSchema).min(1).max(4);
export type OcrPasses = z.infer<typeof ocrPassesSchema>;

/** The picture types a browser sends and the recogniser reads. */
export function imageMimeOf(buffer: Buffer): string | null {
  const b = buffer;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function isOcrBundle(buffer: Buffer): boolean {
  return buffer.length > MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

/** The words, then the picture, in one stored file. */
export function packOcrBundle(image: Buffer, passes: OcrPasses): Buffer {
  const mime = imageMimeOf(image);
  if (!mime) throw new BadRequestError('That picture is not a PNG, JPEG or WebP image.');
  const json = Buffer.from(JSON.stringify({ mime, passes }), 'utf8');
  return Buffer.concat([MAGIC, Buffer.from(`${json.length}\n`, 'latin1'), json, image]);
}

export function unpackOcrBundle(buffer: Buffer): { passes: OcrPasses; image: Buffer; mime: string } {
  const bad = () => new BadRequestError('This stored picture could not be read back. Upload the screenshot again.');
  if (!isOcrBundle(buffer)) throw bad();
  const nl = buffer.indexOf(0x0a, MAGIC.length);
  const len = Number(buffer.toString('latin1', MAGIC.length, nl));
  if (nl < 0 || !Number.isInteger(len) || len <= 0 || nl + 1 + len > buffer.length) throw bad();
  let parsed: unknown;
  try { parsed = JSON.parse(buffer.toString('utf8', nl + 1, nl + 1 + len)); } catch { throw bad(); }
  const passes = ocrPassesSchema.safeParse((parsed as { passes?: unknown }).passes);
  const image = buffer.subarray(nl + 1 + len);
  // The type is the picture's own, never the stored claim: it is the type the
  // file is served with from the order, and a claimed "text/html" on bytes
  // of our choosing would be a web page on OpsFlow's own address.
  const mime = imageMimeOf(image);
  if (!passes.success || !mime || (parsed as { mime?: unknown }).mime !== mime) throw bad();
  return { passes: passes.data, image, mime };
}

/**
 * The size, in points, a word's box is drawn at — about 9pt text.
 *
 * The PDF readers measure in points: a line is anything within 3pt, a new
 * column starts after a 12pt gap. A screenshot's pixels are whatever the
 * screen and zoom made them, so the picture is scaled until its typical word
 * is as tall as the letters of ordinary 8–9pt print (a word's box hugs its letters, about 6pt); then those same thresholds hold.
 */
const TYPICAL_WORD_PT = 6;

/** The recognised words as one page of positioned text, top line first. */
export function ocrPages(words: OcrWords): PdfPage[] {
  const real = words.words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => w.text !== '' && w.x1 > w.x0 && w.y1 > w.y0 && /[\p{L}\p{N}]/u.test(w.text));
  if (real.length === 0) return [{ pageNumber: 1, items: [] }];
  const heights = real.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)]!;
  const scale = TYPICAL_WORD_PT / typical;
  const items: TextItem[] = real.map((w) => {
    const text = fixDigits(w.text);
    // The line's baseline when known: a "p" or a "g" hangs below the others
    // and would otherwise drop out of its own row.
    const base = w.baseline != null && w.baseline >= w.y0 - typical && w.baseline <= w.y1 + typical ? w.baseline : w.y1;
    return {
      text,
      x: w.x0 * scale,
      // PDF coordinates run upwards from the bottom of the page.
      y: (words.height - base) * scale,
      width: (w.x1 - w.x0) * scale,
    };
  });
  return [{ pageNumber: 1, items }];
}

/**
 * A number the recogniser spelled with a letter: "1O0" for 100, "l5" for 15.
 * Only inside a token that is mostly digits already, so a size ("XS"), a
 * colour code ("158") or a word is never touched.
 */
export function fixDigits(token: string): string {
  if (!/^[\dOoIl|.,]+$/.test(token)) return token;
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits === 0 || digits * 2 < token.replace(/[.,]/g, '').length) return token;
  return token.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
}

const isNumber = (t: string) => /^\d[\d.,]*%?$/.test(fixDigits(t));

/** How much of the smaller box the two boxes share, over their union. */
function overlap(a: OcrWord, b: OcrWord): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const area = (q: OcrWord) => (q.x1 - q.x0) * (q.y1 - q.y0);
  return inter / (area(a) + area(b) - inter);
}

/**
 * One word for each place a word was read, by vote across the readings.
 *
 * The same word read by several passes is grouped by where it sits. The
 * spelling most passes agree on wins; on a tie a clean number beats a garbled
 * one ("80" over "#0" — quantities are what matter here), then the reading the
 * engine was surest of. A word only one of several passes saw, lying across
 * words the others agree on, is a misreading of those words and is dropped.
 */
export function consensusWords(passes: OcrPasses): OcrWords {
  const first = passes[0]!;
  if (passes.length === 1) return first;
  type Cluster = { words: Array<OcrWord & { pass: number }> };
  const clusters: Cluster[] = [];
  // Words are looked up by the band of the page they sit in, so each is
  // compared with its neighbours only — not with every word on the page,
  // which for ten joined screenshots was hundreds of millions of comparisons.
  const band = Math.max(1, median(passes.flatMap((p) => p.words.map((w) => w.y1 - w.y0)).filter((h) => h > 0)));
  const bandOf = (w: OcrWord) => Math.floor((w.y0 + w.y1) / 2 / band);
  const byBand = new Map<number, Cluster[]>();
  passes.forEach((p, pass) => {
    for (const w of p.words) {
      if (!w.text.trim() || !(w.x1 > w.x0 && w.y1 > w.y0)) continue;
      let best: Cluster | null = null; let bestO = 0.45;
      const b = bandOf(w);
      for (const c of [...(byBand.get(b - 1) ?? []), ...(byBand.get(b) ?? []), ...(byBand.get(b + 1) ?? [])]) {
        if (c.words.some((x) => x.pass === pass)) continue;
        const o = overlap(c.words[0]!, w);
        if (o > bestO) { best = c; bestO = o; }
      }
      if (best) { best.words.push({ ...w, pass }); continue; }
      const made: Cluster = { words: [{ ...w, pass }] };
      clusters.push(made);
      byBand.set(b, [...(byBand.get(b) ?? []), made]);
    }
  });

  const chosen = clusters.map((c) => {
    const byText = new Map<string, Array<OcrWord & { pass: number }>>();
    for (const w of c.words) {
      const key = w.text.trim();
      byText.set(key, [...(byText.get(key) ?? []), w]);
    }
    const options = [...byText.entries()].map(([text, ws]) => ({
      text, ws, count: ws.length, number: isNumber(text),
      conf: Math.max(...ws.map((w) => w.conf ?? 0)),
    }));
    options.sort((a, b) => b.count - a.count || Number(b.number) - Number(a.number) || b.conf - a.conf);
    const win = options[0]!;
    const box = win.ws[0]!;
    return { word: { ...box, text: win.text } as OcrWord, seen: c.words.length };
  });

  const shared = new Map<number, typeof chosen>();
  for (const c of chosen) if (c.seen > 1) shared.set(bandOf(c.word), [...(shared.get(bandOf(c.word)) ?? []), c]);
  const near = (w: OcrWord) => [-1, 0, 1].flatMap((d) => shared.get(bandOf(w) + d) ?? []);
  const kept = chosen.filter((c) => !(c.seen === 1 && near(c.word).some((o) => covers(c.word, o.word))));
  return { width: first.width, height: first.height, words: kept.map((c) => c.word) };
}

/** Whether `b` lies mostly inside `a`. */
function covers(a: OcrWord, b: OcrWord): boolean {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 && (w * h) / ((b.x1 - b.x0) * (b.y1 - b.y0)) > 0.5;
}

/** Pieces in a reading's Main Order grid. */
const piecesIn = (r: ExtractionResult) =>
  r.matrices.find((m) => m.ledger === 'ORDER')?.rows.reduce((a, row) => a + row.total, 0) ?? 0;

/**
 * The order in a picture, read from each of the browser's passes.
 *
 * Every pass, and the word-by-word vote across them, is read as a PDF would
 * be; the reading kept is the one the document's own figures confirm (its
 * printed piece count or money total), then the one with the fewest doubts,
 * then the one that found the most pieces.
 */
export async function extractFromPicture(
  bundle: Buffer,
  options: { placeholderPoNumber?: string } = {},
): Promise<ExtractionResult> {
  const { passes } = unpackOcrBundle(bundle);
  const candidates = passes.length > 1 ? [consensusWords(passes), ...passes] : passes;
  const readings = await Promise.all(candidates.map((words) => extractFromPdf(Buffer.alloc(0), {
    reader: async () => ocrPages(words),
    placeholderPoNumber: options.placeholderPoNumber,
  })));
  const doubts = (r: ExtractionResult) => r.issues.filter((i) => i.level !== 'INFO').length;
  const best = readings
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.confidence - a.r.confidence || doubts(a.r) - doubts(b.r) || piecesIn(b.r) - piecesIn(a.r) || a.i - b.i)[0]!.r;

  const noText = candidates.every((w) => ocrPages(w)[0]!.items.length === 0);
  best.issues = best.issues
    .filter((i) => !(noText && /no text layer/i.test(i.message)))
    .map((i) => ({ ...i, message: i.message.replace(/\bthe PDF\b/g, 'the picture').replace(/\bThis PDF\b/g, 'This picture') }));
  best.issues.unshift(noText
    ? {
      level: 'WARNING', field: null, sheet: null, cell: null,
      message: 'No text could be read in this picture. Take the screenshot closer, so the order fills the picture, '
        + 'or upload the original PDF or spreadsheet. Nothing was imported.',
    }
    : {
      level: 'WARNING', field: null, sheet: null, cell: null,
      message: 'Read from a picture by text recognition, which can misread small print. '
        + 'Check every model, size, quantity and price against the picture before confirming.',
    });
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}
