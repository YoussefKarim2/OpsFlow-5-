/**
 * Production orders written one style to a block.
 *
 * A factory's own production order, and some buyers' tech-pack style sheets,
 * carry no grid at all. Each style is a titled block:
 *
 *     16 PCS   01. T-Shirt / Short Sleeve - Navy
 *     Color    Navy
 *     Fabric   ROSETTA
 *     Size S   8
 *     Size M   8
 *     Size L   0
 *     Total    16 pcs
 *
 * Read line by line, those "Size S | 8" lines look like nothing — or worse,
 * like a heading of sizes S and 8 — and a two-style order came out empty. This
 * reads the blocks for what they are and hands back the same `GridBlock`s the
 * size-grid reader produces, so the rest of the PDF reader treats both alike:
 * several styles become "Style — Colour" rows, the printed totals are checked
 * against the sizes, and the reading competes with the others on pieces.
 */

import type { GridBlock, GridLine, GridRow } from './size-grid.js';
import { isSizeLabel } from './size-grid.js';

/** "01. T-Shirt / Short Sleeve - Navy", with or without a piece count before it. */
const TITLE = /^(\d{1,3})\.\s+(.+)$/;
const SIZE_LINE = /^size\s+(.+)$/i;
const TOTAL_LINE = /^total$/i;
const COLOUR_LINE = /^colou?r$/i;
const PIECES = /^(\d{1,6})\s*(pcs|pieces|units)?$/i;

/** The style and the colour of a block title, split on its last dash. */
function splitTitle(text: string): { style: string; colour: string | null } {
  const m = /^(.*?)\s+[-–—]\s+([^-–—]+)$/.exec(text);
  if (!m) return { style: text.trim(), colour: null };
  return { style: m[1]!.trim(), colour: m[2]!.trim() };
}

export function readStyleBlocks(lines: readonly GridLine[]): GridBlock[] {
  type Open = { style: string; colour: string | null; cells: Record<string, number>; sizes: string[]; printed: number | null; number: string };
  const blocks: GridBlock[] = [];
  let open: Open | null = null;
  const seen = new Set<string>();

  const close = () => {
    if (!open) return;
    const key = `${open.number}|${open.style}|${open.colour ?? ''}`;
    // A block that repeats on a later page — a cover summary, then the detail
    // pages — is read once.
    if (!seen.has(key) && open.sizes.length > 0) {
      seen.add(key);
      const total = Object.values(open.cells).reduce((a, b) => a + b, 0);
      const row: GridRow = { colour: open.colour ?? open.style, cells: open.cells, total, printedQty: open.printed, price: null, amount: null };
      const problems: string[] = [];
      if (open.printed != null && open.printed !== total) {
        problems.push(`${open.number}. ${open.style}${open.colour ? ` ${open.colour}` : ''}: the sizes add up to ${total} pcs but the block says ${open.printed}.`);
      }
      blocks.push({ style: open.style, styleCode: null, sizes: open.sizes.filter((s) => (open!.cells[s] ?? 0) > 0), rows: [row], printedTotal: open.printed, problems });
    }
    open = null;
  };

  for (const line of lines) {
    const cells = line.cells.map((c) => c.text.trim()).filter(Boolean);
    if (cells.length === 0) continue;

    // A title opens a block; the piece count before it is kept as its own claim.
    const titleCell = cells.find((c) => TITLE.test(c));
    if (titleCell) {
      const m = TITLE.exec(titleCell)!;
      close();
      const { style, colour } = splitTitle(m[2]!);
      const before = cells[cells.indexOf(titleCell) - 1];
      const pm = before ? PIECES.exec(before) : null;
      open = { style, colour, cells: {}, sizes: [], printed: pm && pm[2] ? Number(pm[1]) : null, number: m[1]! };
      continue;
    }
    if (!open) continue;

    const [label, value] = [cells[0]!, cells[1]];
    if (COLOUR_LINE.test(label) && value) { open.colour = value; continue; }
    const sm = SIZE_LINE.exec(label);
    if (sm && value != null) {
      const size = sm[1]!.trim();
      const n = Number(value.replace(/[^\d.]/g, ''));
      if (!isSizeLabel(size) || !Number.isFinite(n)) continue;
      if (!open.sizes.includes(size)) open.sizes.push(size);
      if (n > 0) open.cells[size] = (open.cells[size] ?? 0) + n;
      continue;
    }
    if (TOTAL_LINE.test(label) && value) {
      const pm = PIECES.exec(value);
      if (pm) open.printed = Number(pm[1]);
      continue;
    }
  }
  close();
  return blocks;
}
