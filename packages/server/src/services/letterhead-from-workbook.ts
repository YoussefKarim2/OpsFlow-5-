/**
 * The letterhead read from the factory's own proforma workbook ("Proforma
 * No. 64 Spring 27.xlsx"): the exporter block at the bottom of its `invoice`
 * sheet, the numbered terms, the bank account rows, the signatory and the
 * stamp image. Nothing about the company lives in this code: it is read
 * from the file the office already keeps.
 */

import type { CompanyProfileDto } from '@opsflow/shared';
import { openWorkbook } from './import/open-workbook.js';

export type LetterheadFromWorkbook = Partial<Omit<CompanyProfileDto, 'updatedAt'>> & { notes: string[] };

const MAX_STAMP_BYTES = 300_000;

export async function letterheadFromWorkbook(buffer: Buffer): Promise<LetterheadFromWorkbook> {
  const wb = await openWorkbook(buffer);
  const notes: string[] = [];
  const ws = wb.getWorksheet('invoice') ?? wb.worksheets.find((w) => w.state !== 'hidden') ?? wb.worksheets[0];
  if (!ws) return { notes: ['The workbook has no sheets.'] };

  const text = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'object') {
      const o = v as { richText?: Array<{ text: string }>; result?: unknown; text?: string };
      if (o.richText) return o.richText.map((t) => t.text).join('').trim();
      if ('result' in o) return text(o.result);
      if (typeof o.text === 'string') return o.text.trim();
    }
    return String(v).trim();
  };
  // Row r as its non-empty cells, in column order.
  const cells = (r: number): Array<{ col: number; v: string }> => {
    const out: Array<{ col: number; v: string }> = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (c, col) => { const v = text(c.value); if (v) out.push({ col, v }); });
    return out;
  };
  const label = (s: string) => s.replace(/\s*:\s*$/, '').trim().toLowerCase();
  const out: LetterheadFromWorkbook = { notes };
  const terms: string[] = [];
  const bank: string[] = [];
  let inTerms = false;
  let signatureAt: number | null = null;

  for (let r = 1; r <= ws.rowCount; r++) {
    const row = cells(r);
    if (row.length === 0) continue;
    const first = row[0]!;
    const rest = row.slice(1).map((c) => c.v).join(' ').replace(/^:\s*/, '').trim();
    const key = label(first.v);
    if (signatureAt != null && r > signatureAt && !out.signatory && row.length === 1) { out.signatory = first.v; continue; }
    if (/^for and in behalf of\b/i.test(first.v)) { signatureAt = r; inTerms = false; continue; }
    if (key === 'terms and conditions') { inTerms = true; continue; }
    if (key === 'name' && rest) { out.name = rest; continue; }
    if (key === 'exporter name' && rest && !out.name) { out.name = rest; continue; }
    if (key === 'address' && rest && !inTerms) { out.address = rest; continue; }
    if (/^qiz ref/.test(key) && rest) { out.qizRef = rest; continue; }
    if (key === 'destination') continue;
    if (inTerms) {
      // "1 | Goods are of Egyptian origin…" is a term; "Bank | : National Bank…" a bank row.
      if (/^\d+$/.test(first.v) && rest) { terms.push(rest); continue; }
      if (row.length >= 2 && !/^\d+$/.test(first.v)) { bank.push(`${first.v.replace(/\s*:\s*$/, '')}: ${rest}`); continue; }
    }
  }
  if (terms.length > 0) out.invoiceTerms = terms.join('\n');
  if (bank.length > 0) out.bankDetails = bank.join('\n');

  // The stamp: the first image on the sheet, when it is a PNG or JPEG of a sensible size.
  const images = ws.getImages();
  if (images.length > 0) {
    const img = wb.getImage(Number(images[0]!.imageId));
    const ext = img.extension === 'jpeg' ? 'jpeg' : img.extension === 'png' ? 'png' : null;
    const bytes = img.buffer ? Buffer.from(img.buffer) : null;
    if (!ext || !bytes) notes.push('The stamp on the sheet is not a PNG or JPEG, so it was not read.');
    else if (bytes.length > MAX_STAMP_BYTES) notes.push(`The stamp image is ${Math.round(bytes.length / 1024)} KB; upload a smaller one (under 300 KB).`);
    else out.stampDataUrl = `data:image/${ext};base64,${bytes.toString('base64')}`;
  } else {
    notes.push('No stamp image was found on the sheet.');
  }
  for (const [k, what] of [['name', 'exporter name'], ['address', 'address'], ['qizRef', 'QIZ reference'], ['invoiceTerms', 'terms'], ['bankDetails', 'bank account'], ['signatory', 'signatory']] as const) {
    if (!out[k]) notes.push(`No ${what} was found on the sheet.`);
  }
  return out;
}
