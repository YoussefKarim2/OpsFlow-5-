/**
 * Reading screenshots of an order in the browser.
 *
 * The recogniser (tesseract.js) runs here, in a web worker, rather than on
 * the server: reading one picture takes a few hundred megabytes for a few
 * seconds, which the server cannot spare but any office computer can. Its
 * files are served by OpsFlow itself under /ocr/ (see vite.config.ts) and
 * loaded only when a picture is imported. The procedure is in ocr-read.ts.
 */

import { PAGE_PROBE_WIDTH, findPage, joinPictures, readPicture, type OcrEngine, type OcrPass, type OcrWord } from './ocr-read';

export type { OcrPass } from './ocr-read';

/** The picture types the import accepts. */
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const isPicture = (f: File) => PICTURE_TYPES.includes(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);
/** The most screenshots one import joins. */
export const MAX_PICTURES = 10;

const base = `/ocr/${__OCR_VERSION__}`;

type Worker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

/** The words of one reading, each with where its line's baseline sits under it. */
function wordsOf(data: unknown): OcrWord[] {
  const words: OcrWord[] = [];
  type Line = { baseline?: { x0: number; y0: number; x1: number; y1: number }; words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> };
  const blocks = (data as { blocks?: Array<{ paragraphs: Array<{ lines: Line[] }> }> }).blocks ?? [];
  for (const b of blocks) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
    const bl = l.baseline;
    const mid = (w.bbox.x0 + w.bbox.x1) / 2;
    const baseline = bl && bl.x1 !== bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (mid - bl.x0)) / (bl.x1 - bl.x0) : null;
    words.push({ text: w.text, ...w.bbox, baseline, conf: w.confidence });
  }
  return words;
}

/** The engine for one picture: the picture enlarged on a canvas, read by the worker. */
function engineFor(worker: Worker, bitmap: ImageBitmap, onProgress: (p: number) => void): OcrEngine {
  let canvas: HTMLCanvasElement | null = null;
  let canvasScale = 0;
  const enlarged = (scale: number) => {
    if (canvas && canvasScale === scale) return canvas;
    canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    // A transparent screenshot read as black text on black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    canvasScale = scale;
    return canvas;
  };
  return {
    async page(scale) {
      await worker.setParameters({
        tessedit_pageseg_mode: '11' as never, tessedit_char_whitelist: '', preserve_interword_spaces: '1',
      });
      onProgress(0);
      const { data } = await worker.recognize(enlarged(scale), {}, { blocks: true, text: false } as never);
      return wordsOf(data);
    },
    async line(scale, box) {
      const page = enlarged(scale);
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.min(box.width, page.width - box.left));
      crop.height = Math.max(1, Math.min(box.height, page.height - box.top));
      crop.getContext('2d')!.drawImage(page, box.left, box.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
      await worker.setParameters({ tessedit_pageseg_mode: '7' as never, tessedit_char_whitelist: '', preserve_interword_spaces: '1' });
      const { data } = await worker.recognize(crop, {}, { blocks: true, text: false } as never);
      return wordsOf(data).map((w) => ({
        ...w, x0: w.x0 + box.left, x1: w.x1 + box.left, y0: w.y0 + box.top, y1: w.y1 + box.top,
        baseline: w.baseline == null ? null : w.baseline + box.top,
      }));
    },
    async word(scale, box, allowed) {
      const page = enlarged(scale);
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.min(box.width, page.width - box.left));
      crop.height = Math.max(1, Math.min(box.height, page.height - box.top));
      crop.getContext('2d')!.drawImage(page, box.left, box.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
      await worker.setParameters({ tessedit_pageseg_mode: '8' as never, tessedit_char_whitelist: allowed });
      const { data } = await worker.recognize(crop);
      return { text: data.text, conf: data.confidence };
    },
  };
}

/**
 * The part of a screenshot to read: the document page, when the screenshot
 * is of the whole screen with other windows beside it (see findPage).
 */
async function pageOf(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const w = Math.min(PAGE_PROBE_WIDTH, bitmap.width);
  const h = Math.max(1, Math.round((bitmap.height * w) / bitmap.width));
  const probe = document.createElement('canvas');
  probe.width = w;
  probe.height = h;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return bitmap;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const light = new Uint8Array(w * h);
  for (let i = 0; i < light.length; i++) light[i] = Math.min(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
  const box = findPage(light, w, h);
  if (!box) return bitmap;
  const sx = Math.round(box.x0 * bitmap.width), sy = Math.round(box.y0 * bitmap.height);
  const sw = Math.round((box.x1 - box.x0) * bitmap.width), sh = Math.round((box.y1 - box.y0) * bitmap.height);
  try {
    return await createImageBitmap(bitmap, sx, sy, sw, sh);
  } catch {
    return bitmap;
  }
}

/** Several screenshots as one picture, top to bottom, at their own size. */
async function joinImages(bitmaps: readonly ImageBitmap[]): Promise<Blob> {
  const gap = 24;
  const width = Math.max(...bitmaps.map((b) => b.width));
  const height = bitmaps.reduce((a, b) => a + b.height, 0) + gap * (bitmaps.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  let top = 0;
  for (const b of bitmaps) { ctx.drawImage(b, 0, top); top += b.height + gap; }
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (png && png.size < 15 * 1024 * 1024) return png;
  const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!jpeg) throw new Error('The screenshots could not be joined into one picture.');
  return jpeg;
}

export interface PictureProgress {
  /** "Reading screenshot 1 of 2" and the like. */
  label: string;
  /** 0–1 across the whole job. */
  fraction: number;
}

/**
 * Read one or more screenshots of an order.
 *
 * Returns the picture to upload (the screenshot itself, or several joined top
 * to bottom) and what was read from it.
 */
export async function readPictures(
  files: readonly File[],
  onProgress: (p: PictureProgress) => void,
): Promise<{ file: File; passes: OcrPass[] }> {
  if (files.length === 0) throw new Error('No picture was chosen.');
  if (files.length > MAX_PICTURES) throw new Error(`At most ${MAX_PICTURES} screenshots can be read for one order.`);
  const bitmaps: ImageBitmap[] = [];
  for (const f of files) {
    try {
      bitmaps.push(await createImageBitmap(f));
    } catch {
      throw new Error(`"${f.name}" could not be opened as a picture. Use a PNG or JPEG screenshot.`);
    }
  }

  onProgress({ label: 'Loading the text reader…', fraction: 0 });
  const unavailable = () => new Error(
    'The text reader could not be loaded, so the screenshot was not read. Check the internet connection and refresh the page, then try again — or import the PDF or spreadsheet instead.',
  );
  let createWorker: typeof import('tesseract.js')['createWorker'];
  try {
    ({ createWorker } = await import('tesseract.js'));
  } catch {
    throw unavailable();
  }
  // Each screenshot is read twice; progress runs across all of those readings.
  const steps = files.length * 2;
  let step = 0;
  let current = { label: '', within: 0 };
  const report = () => onProgress({ label: current.label, fraction: Math.min(1, (step + current.within) / steps) });
  const worker = await createWorker('eng', 1, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/`,
    langPath: base,
    workerBlobURL: false,
    gzip: true,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') { current.within = m.progress; report(); }
    },
  }).catch(() => { throw unavailable(); });
  try {
    const pictures: OcrPass[][] = [];
    for (const [i, bitmap] of bitmaps.entries()) {
      const name = files.length === 1 ? 'the screenshot' : `screenshot ${i + 1} of ${files.length}`;
      // Only the document is read; the screenshot itself is what is kept.
      const page = await pageOf(bitmap);
      try {
        const engine = engineFor(worker, page, () => {});
        pictures.push(await readPicture(engine, page.width, page.height, (which, done) => {
          if (done) { step += 1; current = { label: current.label, within: 0 }; report(); return; }
          current = { label: `Reading ${name}${which === 'second' ? ' again, enlarged' : ''}…`, within: 0 };
          report();
        }));
      } finally {
        if (page !== bitmap) page.close();
      }
      // A screenshot read only once still counts its second step as done.
      step = (i + 1) * 2;
    }
    const passes = joinPictures(pictures);
    let file: File;
    if (files.length === 1 && PICTURE_TYPES.includes(files[0]!.type)) {
      file = files[0]!;
    } else {
      const joined = await joinImages(bitmaps);
      const ext = joined.type === 'image/png' ? 'png' : 'jpg';
      const stem = files[0]!.name.replace(/\.[^.]+$/, '') || 'screenshot';
      file = new File([joined], files.length === 1 ? `${stem}.${ext}` : `${stem} (+${files.length - 1} more).${ext}`, { type: joined.type });
    }
    onProgress({ label: 'Reading the order from the text…', fraction: 1 });
    return { file, passes };
  } finally {
    await worker.terminate();
    for (const b of bitmaps) b.close();
  }
}
