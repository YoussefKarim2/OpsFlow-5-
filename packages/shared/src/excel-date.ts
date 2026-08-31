/**
 * Reading a date out of a spreadsheet, safely.
 *
 * This module exists because of one crash:
 *
 *     RangeError: Invalid time value
 *         at Date.toISOString
 *
 * `new Date("13/09/2026")` in Node is an Invalid Date — not an error, not null,
 * an object that passes `instanceof Date` and throws the moment anything calls
 * `.toISOString()` on it. So one badly formatted cell, three sheets into a
 * workbook, would take down an import that had already read four hundred rows
 * correctly.
 *
 * Two rules follow, and both are enforced by the types here:
 *
 * **Nothing ever returns an Invalid Date.** `parseSpreadsheetDate` returns a
 * valid `Date` or `null`. There is no third case, so no caller downstream has
 * to remember to check `isNaN(d.getTime())`.
 *
 * **An ambiguous date is a question, not a guess.** `03/09/2026` is the third
 * of September to the factory and the ninth of March to a spreadsheet saved in
 * the United States. The parser says so — it returns the reading it prefers
 * *and* the alternative — so the review screen can ask instead of silently
 * shipping an order two months early.
 *
 * Pure, dependency-free, and in `shared` so the API and the review screen agree
 * on what a cell said.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The result
// ─────────────────────────────────────────────────────────────────────────────

export type DateConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ParsedDate {
  /** A genuinely valid Date, or null. Never an Invalid Date. */
  value: Date | null;
  confidence: DateConfidence;
  /** How it was read, for the review screen: "Excel serial number 46264". */
  interpretation: string;
  /**
   * The other reading, when the text is genuinely ambiguous. Present only for
   * day/month pairs that are both ≤ 12 — `03/09/2026` yes, `13/09/2026` no.
   */
  alternative?: { value: Date; interpretation: string };
  /** Set when nothing could be read. Shown to the coordinator verbatim. */
  problem?: string;
}

const NOTHING: ParsedDate = {
  value: null, confidence: 'NONE', interpretation: 'empty',
};

/** A date is valid only if it is a Date AND its time is a number. */
export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The single safe way to turn a date into an ISO string.
 *
 * Every `toISOString()` in the import path goes through this. An invalid or
 * absent date yields null rather than an exception, which is the whole point.
 */
export function toIsoDateOrNull(value: unknown): string | null {
  return isValidDate(value) ? value.toISOString() : null;
}

/** The day part only — what a review screen and a date input both want. */
export function toIsoDayOrNull(value: unknown): string | null {
  return isValidDate(value) ? value.toISOString().slice(0, 10) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel serial numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Excel counts days from 1899-12-30, and believes 1900 was a leap year.
 *
 * The epoch below is already offset for that bug, which is why it is the 30th
 * of December and not the 31st. Serials below 1 are times of day with no date;
 * serials above 2958465 are past Excel's own maximum of 9999-12-31.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const MAX_EXCEL_SERIAL = 2_958_465;

/**
 * The narrow band a bare number is *assumed* to be a date in.
 *
 * 20000 is 1954 and 80000 is 2119. Outside that, a number in a spreadsheet is
 * overwhelmingly a quantity, a price or a style code, and reading `3091` as
 * the 12th of June 1908 would be worse than reading nothing.
 */
const LIKELY_SERIAL_MIN = 20_000;
const LIKELY_SERIAL_MAX = 80_000;

export function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > MAX_EXCEL_SERIAL) return null;
  // Rounded to the day: a serial with a fractional part carries a time, and an
  // order's delivery date does not have a time.
  const d = new Date(EXCEL_EPOCH_MS + Math.floor(serial) * MS_PER_DAY);
  return isValidDate(d) ? d : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

/** Build a UTC date only if the parts describe a real calendar day. */
function utc(year: number, monthIndex: number, day: number): Date | null {
  if (year < 1900 || year > 2200) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, monthIndex, day));
  // Rejects 31 February, which JavaScript would silently roll into March.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** Two digits: 26 → 2026, 98 → 1998. The pivot is 70, as everywhere else. */
function expandYear(n: number): number {
  if (n >= 1000) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/;
const SLASHED = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;
const DAY_MONTH_NAME = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]*([a-z]+)[\s-]*(\d{2,4})$/i;
const MONTH_NAME_DAY = /^([a-z]+)[\s-]*(\d{1,2})(?:st|nd|rd|th)?,?[\s-]*(\d{2,4})$/i;

/**
 * Read a date out of text.
 *
 * `dayFirst` decides how `03/09/2026` is read. It defaults to true because this
 * is a factory in Egypt working with European and Asian suppliers, where
 * day/month is the norm — but when both numbers are ≤ 12 the other reading is
 * returned alongside, so the review screen can ask rather than assume.
 */
export function parseDateText(raw: string, dayFirst = true): ParsedDate {
  const text = raw.trim();
  if (text === '') return NOTHING;

  const iso = ISO.exec(text);
  if (iso) {
    const d = utc(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return d
      ? { value: d, confidence: 'HIGH', interpretation: 'ISO date (year first)' }
      : { value: null, confidence: 'NONE', interpretation: 'unreadable',
          problem: `“${text}” looks like a date but is not a real day` };
  }

  const named = DAY_MONTH_NAME.exec(text);
  if (named && MONTH_NAMES[named[2]!.toLowerCase()] !== undefined) {
    const d = utc(expandYear(Number(named[3])), MONTH_NAMES[named[2]!.toLowerCase()]!, Number(named[1]));
    if (d) return { value: d, confidence: 'HIGH', interpretation: 'day, month name, year' };
  }

  const namedFirst = MONTH_NAME_DAY.exec(text);
  if (namedFirst && MONTH_NAMES[namedFirst[1]!.toLowerCase()] !== undefined) {
    const d = utc(expandYear(Number(namedFirst[3])), MONTH_NAMES[namedFirst[1]!.toLowerCase()]!, Number(namedFirst[2]));
    if (d) return { value: d, confidence: 'HIGH', interpretation: 'month name, day, year' };
  }

  const slashed = SLASHED.exec(text);
  if (slashed) {
    const a = Number(slashed[1]);
    const b = Number(slashed[2]);
    const year = expandYear(Number(slashed[3]));

    const dayFirstDate = utc(year, b - 1, a);
    const monthFirstDate = utc(year, a - 1, b);

    // Only one reading is a real day: no ambiguity at all. 13/09 can only be
    // the 13th of September, whatever the file's origin.
    if (dayFirstDate && !monthFirstDate) {
      return { value: dayFirstDate, confidence: 'HIGH', interpretation: 'day/month/year' };
    }
    if (monthFirstDate && !dayFirstDate) {
      return { value: monthFirstDate, confidence: 'HIGH', interpretation: 'month/day/year' };
    }

    // Both are real days. This is the case that quietly ships an order two
    // months early, so it is reported as ambiguous rather than resolved.
    if (dayFirstDate && monthFirstDate) {
      const preferred = dayFirst ? dayFirstDate : monthFirstDate;
      const other = dayFirst ? monthFirstDate : dayFirstDate;
      return {
        value: preferred,
        confidence: 'MEDIUM',
        interpretation: dayFirst ? 'day/month/year (assumed)' : 'month/day/year (assumed)',
        alternative: {
          value: other,
          interpretation: dayFirst ? 'month/day/year' : 'day/month/year',
        },
      };
    }

    return {
      value: null, confidence: 'NONE', interpretation: 'unreadable',
      problem: `“${text}” is not a real calendar date`,
    };
  }

  // Last resort. `Date.parse` accepts a great deal, including things nobody
  // meant as a date, so anything it returns is LOW confidence and the review
  // screen shows it for confirmation.
  const parsed = new Date(text);
  if (isValidDate(parsed)) {
    const year = parsed.getUTCFullYear();
    if (year >= 1900 && year <= 2200) {
      return {
        value: new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())),
        confidence: 'LOW',
        interpretation: `read loosely from “${text}”`,
      };
    }
  }

  return {
    value: null,
    confidence: 'NONE',
    interpretation: 'unreadable',
    problem: `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}” could not be read as a date`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The one entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a date from anything a spreadsheet cell can hold.
 *
 * Handles: a real Date, an Invalid Date, an Excel serial number, an ExcelJS
 * formula object, rich text, ISO, `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`,
 * `13 Sep 2026`, `September 13, 2026`, blanks, `#VALUE!`, `N/A`, `TBC`, and
 * whatever else somebody typed into a cell that was supposed to be a date.
 *
 * It never throws and never returns an Invalid Date.
 */
export function parseSpreadsheetDate(value: unknown, dayFirst = true): ParsedDate {
  if (value == null) return NOTHING;

  // An Invalid Date is the exact thing that used to crash the import.
  if (value instanceof Date) {
    return isValidDate(value)
      ? { value, confidence: 'HIGH', interpretation: 'a date value in the cell' }
      : {
          value: null, confidence: 'NONE', interpretation: 'unreadable',
          problem: 'The cell holds a date Excel itself could not represent',
        };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { value: null, confidence: 'NONE', interpretation: 'unreadable',
               problem: 'The cell holds a number that is not finite' };
    }
    if (value >= LIKELY_SERIAL_MIN && value <= LIKELY_SERIAL_MAX) {
      const d = excelSerialToDate(value);
      if (d) {
        return { value: d, confidence: 'HIGH', interpretation: `Excel serial number ${Math.floor(value)}` };
      }
    }
    // A number outside the plausible band is a quantity, not a date.
    return {
      value: null, confidence: 'NONE', interpretation: 'not a date',
      problem: `${value} is a number, not a date. If it is a date, enter it directly.`,
    };
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // ExcelJS shapes: formula results, rich text, hyperlinks.
    if ('result' in v) return parseSpreadsheetDate(v.result, dayFirst);
    if ('richText' in v && Array.isArray(v.richText)) {
      return parseDateText((v.richText as Array<{ text: string }>).map((r) => r.text).join(''), dayFirst);
    }
    if ('text' in v && typeof v.text === 'string') return parseDateText(v.text, dayFirst);
    return { value: null, confidence: 'NONE', interpretation: 'unreadable',
             problem: 'The cell holds something OpsFlow cannot read as a date' };
  }

  const text = String(value).trim();
  if (text === '') return NOTHING;

  // The placeholders people type where a date is not known yet. All of them
  // mean "no date", and none of them is a failure worth reporting.
  if (/^(n\/?a|tbc|tba|tbd|unknown|none|-{1,3}|\?+|asap|pending)$/i.test(text)) {
    return { value: null, confidence: 'NONE', interpretation: `“${text}” — no date given` };
  }
  // Excel's own error strings.
  if (/^#(VALUE|DIV\/0|REF|NAME|N\/A|NULL|NUM)[!?]/i.test(text)) {
    return { value: null, confidence: 'NONE', interpretation: 'an Excel error in the cell',
             problem: `The cell reads ${text} in the workbook itself` };
  }

  // Text that is only digits may still be a serial the sheet stored as text.
  if (/^\d+(\.\d+)?$/.test(text)) {
    return parseSpreadsheetDate(Number(text), dayFirst);
  }

  return parseDateText(text, dayFirst);
}

/**
 * The short form, for the many call sites that only want the date.
 *
 * Returns a valid Date or null — never an Invalid Date, and never throws.
 */
export function safeDate(value: unknown, dayFirst = true): Date | null {
  return parseSpreadsheetDate(value, dayFirst).value;
}
