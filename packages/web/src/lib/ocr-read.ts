/**
 * How a picture of an order is read: the procedure, apart from the engine.
 *
 * Kept free of the browser so the same steps can be run against the engine in
 * a test. `ocr.ts` supplies the engine (tesseract.js, in a web worker).
 *
 * Small print is the hard part of a screenshot: a 7px "80" under a size row
 * comes back as "#0". Three things recover it:
 *
 *   1. The picture is enlarged before it is read — the engine wants letters
 *      about 20–30px tall — and read twice at two enlargements, because what
 *      one garbles the other often reads cleanly.
 *   2. Each table row is read again as a single line, which keeps the lone
 *      characters ("6", "M") a whole-page reading drops; and in a row that is
 *      mostly numbers, a cell that is not a clean number is read again on its
 *      own, allowed digits only.
 *   3. The server (ocr-bundle.ts) reads the order from each pass and keeps
 *      the reading the document's own totals confirm.
 */

export interface OcrWord {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
  baseline: number | null;
  conf: number;
}

export interface OcrPass { width: number; height: number; words: OcrWord[] }

export interface OcrEngine {
  /** Read the whole picture enlarged by `scale`; boxes in the enlarged picture's pixels. */
  page(scale: number): Promise<OcrWord[]>;
  /** Read one box of the enlarged picture as a single word, using only `allowed` characters. */
  word(scale: number, box: { left: number; top: number; width: number; height: number }, allowed: string): Promise<{ text: string; conf: number }>;
  /** Read one strip of the enlarged picture as a single line of text; boxes in the enlarged picture's pixels. */
  line(scale: number, box: { left: number; top: number; width: number; height: number }): Promise<OcrWord[]>;
}

/** The letter height, in pixels, the engine reads small print best at. */
const GOOD_WORD_PX = 24;
/** The most pixels one reading may enlarge the picture to — the browser's memory, not the engine's taste. */
const MAX_PIXELS = 24_000_000;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};
const isCleanNumber = (t: string) => /^\d[\d.,]*%?$/.test(t);
/** A size heading: S, M, XL, XXS, 2XL and the like. */
const isSizeWord = (t: string) => /^(x{0,4}s|m|x{0,4}l|[2-5]xl)$/i.test(t);

/** The enlargements to read at: a first guess, then one set by what the first found. */
export function firstScale(width: number, height: number): number {
  return clampScale(2800 / width, width, height);
}
export function secondScale(first: number, words: readonly OcrWord[], width: number, height: number): number | null {
  const h = median(words.map((w) => w.y1 - w.y0).filter((x) => x > 0));
  if (h <= 0) return null;
  let s = clampScale(first * (GOOD_WORD_PX / h), width, height);
  if (Math.abs(s - first) / first < 0.2) s = clampScale(first * 1.5, width, height);
  return Math.abs(s - first) / first < 0.1 ? null : s;
}
function clampScale(s: number, width: number, height: number): number {
  const most = Math.sqrt(MAX_PIXELS / (width * height));
  return Math.round(Math.max(0.5, Math.min(4, s, most)) * 100) / 100;
}

/** Words on one line, by where their baseline sits. */
function lines(words: readonly OcrWord[]): OcrWord[][] {
  const h = median(words.map((w) => w.y1 - w.y0)) || 1;
  const base = (w: OcrWord) => w.baseline ?? w.y1;
  const sorted = [...words].sort((a, b) => base(a) - base(b));
  const out: OcrWord[][] = [];
  for (const w of sorted) {
    const line = out[out.length - 1];
    if (line && Math.abs(base(line[0]!) - base(w)) < h * 0.5) line.push(w);
    else out.push([w]);
  }
  return out;
}

/**
 * Read each row of a table again as one line, and keep what fills its gaps.
 *
 * Reading a whole page, the engine drops a character that stands alone — the
 * "6" under S, the "M" in a size heading — and every cell after it lands in
 * the wrong column. Read as a single line, the same row comes back whole. A
 * row counts as a table row when it holds two or more numbers or sizes; from
 * its second reading, only numbers and sizes are kept, and only where the
 * first reading found nothing.
 */
async function fillTableRows(engine: OcrEngine, scale: number, words: OcrWord[], pageWidth: number): Promise<OcrWord[]> {
  const added: OcrWord[] = [];
  for (const line of lines(words)) {
    if (line.filter((w) => isCleanNumber(w.text) || isSizeWord(w.text)).length < 2) continue;
    const h = median(line.map((w) => w.y1 - w.y0)) || 1;
    const top = Math.min(...line.map((w) => w.y0));
    const bottom = Math.max(...line.map((w) => w.y1));
    const pad = Math.max(3, h * 0.5);
    const strip = { top: Math.max(0, Math.round(top - pad)), height: Math.round(bottom - top + 2 * pad) };
    // The row's own width first — another window beside the order, in a
    // whole-screen screenshot, can leave the engine reading nothing — then
    // the picture's whole width.
    const left = Math.max(0, Math.round(Math.min(...line.map((w) => w.x0)) - 2 * h));
    const right = Math.min(pageWidth, Math.round(Math.max(...line.map((w) => w.x1)) + 2 * h));
    const boxes = [{ ...strip, left, width: right - left }];
    if (left > 0 || right < pageWidth) boxes.push({ ...strip, left: 0, width: Math.round(pageWidth) });
    let got: OcrWord[] = [];
    for (const box of boxes) {
      try {
        got = await engine.line(scale, box);
      } catch {
        got = [];
      }
      if (got.filter((w) => isCleanNumber(w.text.trim()) || isSizeWord(w.text.trim())).length >= 2) break;
    }
    const taken = [...line];
    for (const w of got) {
      const text = w.text.trim();
      if (!(isCleanNumber(text) || isSizeWord(text)) || w.conf < 50) continue;
      const wh = w.y1 - w.y0;
      const mid = (w.y0 + w.y1) / 2;
      // A table's rule read as "1" is taller than the row's letters.
      if (wh < h * 0.6 || wh > h * 1.5 || mid < top || mid > bottom) continue;
      const gap = h * 0.3;
      if (taken.some((t) => w.x0 < t.x1 + gap && w.x1 > t.x0 - gap)) continue;
      const word = { ...w, text };
      taken.push(word);
      added.push(word);
    }
  }
  return added.length === 0 ? words : [...words, ...added];
}

/** Read again, digits only, each garbled cell of a row that is mostly numbers. */
async function rereadNumbers(engine: OcrEngine, scale: number, words: OcrWord[]): Promise<OcrWord[]> {
  const fixed = new Map<OcrWord, OcrWord>();
  for (const line of lines(words)) {
    if (line.length < 3) continue;
    const numbers = line.filter((w) => isCleanNumber(w.text)).length;
    if (numbers * 2 < line.length) continue;
    for (const w of line) {
      if (isCleanNumber(w.text) || w.text.length > 6) continue;
      const h = w.y1 - w.y0;
      const pad = Math.max(4, h * 0.6);
      const got = await engine.word(scale, {
        left: Math.max(0, Math.round(w.x0 - pad)), top: Math.max(0, Math.round(w.y0 - pad)),
        width: Math.round(w.x1 - w.x0 + 2 * pad), height: Math.round(h + 2 * pad),
      }, '0123456789.,');
      const text = got.text.trim();
      if (isCleanNumber(text) && got.conf >= 30) fixed.set(w, { ...w, text, conf: got.conf });
    }
  }
  return words.map((w) => fixed.get(w) ?? w);
}

/** The picture read at each enlargement, in the picture's own pixels. */
export async function readPicture(
  engine: OcrEngine,
  width: number,
  height: number,
  onStep: (step: 'first' | 'second', done: boolean) => void = () => {},
): Promise<OcrPass[]> {
  const passes: OcrPass[] = [];
  const one = async (scale: number) => {
    const read = (await engine.page(scale)).filter((w) => w.text.trim() !== '');
    const words = await rereadNumbers(engine, scale, await fillTableRows(engine, scale, read, width * scale));
    passes.push({
      width, height,
      words: words.map((w) => ({
        text: w.text.trim(),
        x0: w.x0 / scale, y0: w.y0 / scale, x1: w.x1 / scale, y1: w.y1 / scale,
        baseline: w.baseline == null ? null : w.baseline / scale,
        conf: w.conf,
      })),
    });
    return words;
  };
  onStep('first', false);
  const s1 = firstScale(width, height);
  const first = await one(s1);
  onStep('first', true);
  const s2 = secondScale(s1, first, width, height);
  if (s2 != null) {
    onStep('second', false);
    await one(s2);
    onStep('second', true);
  }
  return passes;
}

/** How wide a copy of the picture `findPage` looks at, in pixels. */
export const PAGE_PROBE_WIDTH = 600;

/**
 * The document page inside a whole-screen screenshot, or null to read it all.
 *
 * A screenshot of the screen carries the other windows beside the PO — a
 * chat list, a side panel — and their words sit on the same lines as the
 * PO's rows: "Total" reads as "Starred Total", a colour as "Khaki TJ
 * Archived". The page itself is the one large white rectangle, so the
 * columns, then the rows, that are mostly white mark it out. It is kept only
 * when what lies outside it is mostly not white (other windows, the
 * desktop); a picture that is white throughout — a spreadsheet, a page
 * cropped already — is read whole.
 *
 * `light` is one brightness byte per pixel of a small copy of the picture,
 * row by row. The box is in fractions of the picture.
 */
export function findPage(
  light: ArrayLike<number>, w: number, h: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (w < 50 || h < 50 || light.length < w * h) return null;
  const white = (x: number, y: number) => light[y * w + x]! >= 240;
  /** The longest run of indices whose share of white is high, small dips allowed. */
  const longestRun = (shares: number[], allowGap: number): [number, number] | null => {
    let best: [number, number] | null = null, start = -1, last = -1;
    shares.forEach((share, i) => {
      if (share < 0.5) return;
      if (start < 0 || i - last > allowGap + 1) start = i;
      last = i;
      if (!best || last - start > best[1] - best[0]) best = [start, last];
    });
    return best;
  };
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  for (let pass = 0; pass < 3; pass++) {
    const cols: number[] = [];
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = y0; y <= y1; y++) if (white(x, y)) n++;
      cols.push(n / (y1 - y0 + 1));
    }
    const xs = longestRun(cols, Math.floor(w * 0.02));
    if (!xs) return null;
    [x0, x1] = xs;
    const rows: number[] = [];
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (white(x, y)) n++;
      rows.push(n / (x1 - x0 + 1));
    }
    const ys = longestRun(rows, Math.floor(h * 0.02));
    if (!ys) return null;
    [y0, y1] = ys;
  }
  const area = ((x1 - x0 + 1) * (y1 - y0 + 1)) / (w * h);
  if (area < 0.15 || area > 0.85 || (x1 - x0 + 1) < w * 0.3 || (y1 - y0 + 1) < h * 0.2) return null;
  let outside = 0, outsideWhite = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
    outside++;
    if (white(x, y)) outsideWhite++;
  }
  if (outside === 0 || outsideWhite / outside > 0.35) return null;
  // A little margin, so a word on the page's edge is not cut.
  const m = 0.005;
  return {
    x0: Math.max(0, x0 / w - m), y0: Math.max(0, y0 / h - m),
    x1: Math.min(1, (x1 + 1) / w + m), y1: Math.min(1, (y1 + 1) / h + m),
  };
}

/** The gap left between two screenshots joined into one page, in its pixels. */
const JOIN_GAP = 40;
/** Each screenshot's words are brought to this height before they are joined. */
const JOINED_WORD_PX = 20;

/**
 * Several screenshots of one order as one page, top to bottom.
 *
 * Each may be taken at a different zoom, and the readers measure gaps in
 * fixed units, so each screenshot's words are first brought to the same
 * letter height, then placed below the one before. Pass k of the page is
 * pass k of every screenshot (its last, where it was read fewer times).
 */
export function joinPictures(pictures: readonly OcrPass[][]): OcrPass[] {
  if (pictures.length === 1) return pictures[0]!;
  const passCount = Math.max(...pictures.map((p) => p.length));
  const factor = pictures.map((p) => {
    const h = median(p[0]?.words.map((w) => w.y1 - w.y0).filter((x) => x > 0) ?? []);
    return h > 0 ? JOINED_WORD_PX / h : 1;
  });
  const width = Math.round(Math.max(...pictures.map((p, i) => (p[0]?.width ?? 0) * factor[i]!)));
  const out: OcrPass[] = [];
  for (let k = 0; k < passCount; k++) {
    let top = 0;
    const words: OcrWord[] = [];
    pictures.forEach((p, i) => {
      const pass = p[Math.min(k, p.length - 1)];
      if (!pass) return;
      const f = factor[i]!;
      for (const w of pass.words) {
        words.push({
          ...w,
          x0: w.x0 * f, x1: w.x1 * f, y0: top + w.y0 * f, y1: top + w.y1 * f,
          baseline: w.baseline == null ? null : top + w.baseline * f,
        });
      }
      top += pass.height * f + JOIN_GAP;
    });
    out.push({ width, height: Math.round(top - JOIN_GAP), words });
  }
  return out;
}
