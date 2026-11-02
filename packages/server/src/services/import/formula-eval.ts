/**
 * A small calculator for the formulas a packing list or proforma carries,
 * for files saved without their results.
 *
 * Excel stores each formula's last result when it saves. A file written by
 * another program (a script, an exporter, some web tools) may store only the
 * formula, and a reader that does not calculate sees an empty cell: a TOTAL
 * row of blanks, cartons with no pieces. Most of these formulas are plain
 * sums and arithmetic on cells of the same workbook, so they are worked out
 * here. Anything beyond that — lookups, text functions, dates — is left as
 * "no saved result", and the reader says so, rather than guessed.
 *
 * Supported: numbers, "text" literals, cell and range references (with an
 * optional sheet name, quoted or not, and $ anchors), + - * / ^, unary minus,
 * parentheses, & between values, and SUM, ROUND, ROUNDUP, ROUNDDOWN, MIN,
 * MAX, AVERAGE, ABS, INT, COUNT.
 */

import type ExcelJS from 'exceljs';

type Value = number | string | null;
type Range = { ws: ExcelJS.Worksheet; r0: number; c0: number; r1: number; c1: number };
type Arg = Value | Range;

class Unsupported extends Error {}

const MAX_DEPTH = 40;
const MAX_RANGE_CELLS = 20_000;

/**
 * The value of a formula cell, worked out from the cells it refers to —
 * `{ value: null }` when it refers to an empty cell — or undefined when the
 * formula is beyond this calculator.
 */
export function evaluateCell(ws: ExcelJS.Worksheet, cell: ExcelJS.Cell): { value: number | string | null } | undefined {
  try {
    const v = cellValue(ws, cell.row as unknown as number, cell.col as unknown as number, 0, new Set());
    if (typeof v === 'number' && !Number.isFinite(v)) return undefined;
    return { value: v };
  } catch {
    return undefined;
  }
}

function formulaOf(cell: ExcelJS.Cell): string | null {
  const v = cell.value as unknown;
  if (v == null || typeof v !== 'object') return null;
  if (!('formula' in (v as object)) && !('sharedFormula' in (v as object))) return null;
  // ExcelJS translates a shared formula to this cell's own references.
  const f = (cell as unknown as { formula?: string }).formula;
  return typeof f === 'string' && f.trim() ? f : null;
}

function cellValue(ws: ExcelJS.Worksheet, row: number, col: number, depth: number, seen: Set<string>): Value {
  const cell = ws.getRow(row).getCell(col);
  // A merged range holds its value once, in its first cell. ExcelJS hands the
  // master's value back for every other cell of the range, so a SUM across a
  // merge counted it once per cell; Excel counts it once.
  if (cell.isMerged && cell.master !== cell) return null;
  const v = cell.value as unknown;
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) throw new Unsupported('date');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) throw new Unsupported('error');
    if ('richText' in o && Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join('');
    if ('formula' in o || 'sharedFormula' in o) {
      if (o.result != null && typeof o.result !== 'object') return o.result as number | string;
      if (o.result != null) throw new Unsupported('result');
      const key = `${ws.name}!${row}:${col}`;
      if (seen.has(key) || depth > MAX_DEPTH) throw new Unsupported('cycle');
      const f = formulaOf(cell);
      if (!f) throw new Unsupported('formula');
      seen.add(key);
      try {
        return new Parser(f, ws, depth + 1, seen).run();
      } finally {
        seen.delete(key);
      }
    }
    if ('text' in o && typeof o.text === 'string') return o.text;
  }
  throw new Unsupported('value');
}

const colNumber = (letters: string): number => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

const toNumber = (v: Value): number => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Unsupported('text as number');
  return n;
};

const toText = (v: Value): string => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1e9) / 1e9) : v);

class Parser {
  private i = 0;
  constructor(private readonly src: string, private readonly ws: ExcelJS.Worksheet, private readonly depth: number, private readonly seen: Set<string>) {}

  run(): Value {
    const v = this.concat();
    this.space();
    if (this.i < this.src.length) throw new Unsupported(`trailing ${this.src.slice(this.i)}`);
    return this.scalar(v);
  }

  private space() { while (this.src[this.i] === ' ') this.i++; }
  private peek(): string { this.space(); return this.src[this.i] ?? ''; }

  private scalar(a: Arg): Value {
    if (a != null && typeof a === 'object') {
      if (a.r0 === a.r1 && a.c0 === a.c1) return cellValue(a.ws, a.r0, a.c0, this.depth, this.seen);
      throw new Unsupported('range as value');
    }
    return a;
  }

  private concat(): Arg {
    let left = this.additive();
    while (this.peek() === '&') {
      this.i++;
      const right = this.additive();
      left = toText(this.scalar(left)) + toText(this.scalar(right));
    }
    return left;
  }

  private additive(): Arg {
    let left = this.term();
    for (let op = this.peek(); op === '+' || op === '-'; op = this.peek()) {
      this.i++;
      const right = toNumber(this.scalar(this.term()));
      const l = toNumber(this.scalar(left));
      left = op === '+' ? l + right : l - right;
    }
    return left;
  }

  private term(): Arg {
    let left = this.power();
    for (let op = this.peek(); op === '*' || op === '/'; op = this.peek()) {
      this.i++;
      const right = toNumber(this.scalar(this.power()));
      const l = toNumber(this.scalar(left));
      if (op === '/' && right === 0) throw new Unsupported('#DIV/0!');
      left = op === '*' ? l * right : l / right;
    }
    return left;
  }

  private power(): Arg {
    const base = this.unary();
    if (this.peek() === '^') {
      this.i++;
      return toNumber(this.scalar(base)) ** toNumber(this.scalar(this.power()));
    }
    return base;
  }

  private unary(): Arg {
    const c = this.peek();
    if (c === '-') { this.i++; return -toNumber(this.scalar(this.unary())); }
    if (c === '+') { this.i++; return this.unary(); }
    return this.primary();
  }

  private primary(): Arg {
    const c = this.peek();
    if (c === '(') {
      this.i++;
      const v = this.concat();
      if (this.peek() !== ')') throw new Unsupported('paren');
      this.i++;
      return v;
    }
    if (c === '"') {
      let out = '';
      this.i++;
      for (;;) {
        const ch = this.src[this.i++];
        if (ch == null) throw new Unsupported('string');
        if (ch === '"') {
          if (this.src[this.i] === '"') { out += '"'; this.i++; continue; }
          break;
        }
        out += ch;
      }
      return out;
    }
    const rest = this.src.slice(this.i);
    const n = rest.match(/^\d+(\.\d+)?(e[+-]?\d+)?/i);
    if (n && !/^\d+(\.\d+)?[A-Za-z_]/.test(rest)) { this.i += n[0].length; return Number(n[0]); }

    // A sheet-qualified or plain reference, or a function call.
    let ws = this.ws;
    const quoted = rest.match(/^'((?:[^']|'')+)'!/);
    const bare = quoted ? null : rest.match(/^([A-Za-z0-9_.]+)!/);
    if (quoted || bare) {
      const name = quoted ? quoted[1]!.replace(/''/g, "'") : bare![1]!;
      const other = this.ws.workbook.getWorksheet(name);
      if (!other) throw new Unsupported(`sheet ${name}`);
      ws = other;
      this.i += (quoted ?? bare)![0].length;
    }
    const ref = this.src.slice(this.i).match(/^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?(?![A-Za-z0-9_(])/);
    if (ref) {
      this.i += ref[0].length;
      const c0 = colNumber(ref[1]!), r0 = Number(ref[2]);
      const c1 = ref[3] ? colNumber(ref[3]) : c0, r1 = ref[4] ? Number(ref[4]) : r0;
      return { ws, r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
    }
    if (ws !== this.ws) throw new Unsupported('sheet without reference');
    const fn = this.src.slice(this.i).match(/^([A-Za-z][A-Za-z0-9.]*)\s*\(/);
    if (fn) {
      this.i += fn[0].length;
      const args: Arg[] = [];
      if (this.peek() !== ')') {
        for (;;) {
          args.push(this.concat());
          if (this.peek() === ',') { this.i++; continue; }
          break;
        }
      }
      if (this.peek() !== ')') throw new Unsupported('call');
      this.i++;
      return this.call(fn[1]!.toUpperCase(), args);
    }
    throw new Unsupported(`token ${rest.slice(0, 10)}`);
  }

  /** Every number an argument holds: a range's numeric cells (text and blanks skipped, as Excel's SUM does). */
  private numbers(args: Arg[]): number[] {
    const out: number[] = [];
    for (const a of args) {
      if (a != null && typeof a === 'object') {
        if ((a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1) > MAX_RANGE_CELLS) throw new Unsupported('range too large');
        for (let r = a.r0; r <= a.r1; r++) for (let c = a.c0; c <= a.c1; c++) {
          const v = cellValue(a.ws, r, c, this.depth, this.seen);
          if (typeof v === 'number') out.push(v);
        }
      } else if (a != null && a !== '') {
        out.push(toNumber(a));
      }
    }
    return out;
  }

  private call(name: string, args: Arg[]): Value {
    const one = (k: number) => toNumber(this.scalar(args[k] ?? null));
    const roundTo = (x: number, places: number, mode: 'near' | 'up' | 'down') => {
      const f = 10 ** places;
      const y = Math.abs(x) * f;
      const r = mode === 'near' ? Math.round(y + 1e-9) : mode === 'up' ? Math.ceil(y - 1e-9) : Math.floor(y + 1e-9);
      return (Math.sign(x) * r) / f;
    };
    switch (name) {
      case 'SUM': return this.numbers(args).reduce((a, b) => a + b, 0);
      case 'MIN': { const n = this.numbers(args); return n.length ? Math.min(...n) : 0; }
      case 'MAX': { const n = this.numbers(args); return n.length ? Math.max(...n) : 0; }
      case 'AVERAGE': { const n = this.numbers(args); if (!n.length) throw new Unsupported('#DIV/0!'); return n.reduce((a, b) => a + b, 0) / n.length; }
      case 'COUNT': return this.numbers(args).length;
      case 'ROUND': return roundTo(one(0), args.length > 1 ? one(1) : 0, 'near');
      case 'ROUNDUP': return roundTo(one(0), args.length > 1 ? one(1) : 0, 'up');
      case 'ROUNDDOWN': return roundTo(one(0), args.length > 1 ? one(1) : 0, 'down');
      case 'ABS': return Math.abs(one(0));
      case 'INT': return Math.floor(one(0));
      default: throw new Unsupported(name);
    }
  }
}
