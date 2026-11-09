/**
 * One purchase order, several orders.
 *
 * A customer's PO can carry many styles and models — jackets, jerseys, pants —
 * that the factory runs as separate jobs. On the review screen models can be
 * moved into orders of their own, each with its own PO number; this turns the
 * one reading into those orders.
 *
 * The first order is the document's own: it keeps everything the file carried
 * beyond the grid (BOM, lay plan, costing, notes). An order split off takes its
 * models' quantities, prices, stock and outside work, and the document's
 * header — customer, dates, addresses — since it is the same customer's buy.
 */

import { BadRequestError } from '../../errors.js';
import { normalisePoNumber } from '../rules.js';
import { axisKey } from './committer.js';
import type { ExtractionResult, ExtractedMatrix } from './extractor.js';

export interface SplitRequest {
  poNumber: string;
  /** The models (rows of the Main Order grid) that become this order. */
  colors: string[];
}

/** The most orders one document can be split into. */
export const MAX_SPLITS = 30;

/** A row's pieces, as the commit will count them. */
const piecesOf = (row: { cells: Record<string, number> }) =>
  Object.values(row.cells).reduce((a, q) => a + (q > 0 ? Math.round(q) : 0), 0);

/** Only the rows named, and only the sizes those rows use. */
function keepRows(m: ExtractedMatrix, keep: (color: string) => boolean): ExtractedMatrix {
  const rows = m.rows.filter((r) => keep(r.color));
  const used = new Set(rows.flatMap((r) => Object.entries(r.cells).filter(([, q]) => q > 0).map(([s]) => axisKey(s))));
  const sizes = m.sizes.filter((s) => used.has(axisKey(s)));
  const total = rows.reduce((a, r) => a + r.total, 0);
  return { ...m, sizes, rows, sheetTotal: null, computedTotal: total };
}

/** A name for an order split off, from its models. */
export function splitOrderName(models: readonly string[]): string {
  const joined = models.map((m) => m.trim()).join(', ');
  return joined.length <= 150 ? joined : `${joined.slice(0, 149).trimEnd()}…`;
}

/**
 * The orders to create, the document's own first.
 *
 * Refused by name, before anything is written: a model named twice or not in
 * the grid, an order left without pieces, a PO number used twice.
 */
export function splitExtraction(extraction: ExtractionResult, splits: readonly SplitRequest[] | undefined): ExtractionResult[] {
  if (!splits || splits.length === 0) return [extraction];
  if (splits.length > MAX_SPLITS) throw new BadRequestError(`A document can be split into at most ${MAX_SPLITS + 1} orders.`);

  const order = extraction.matrices.find((m) => m.ledger === 'ORDER');
  if (!order) throw new BadRequestError('There is no Main Order grid to split.');
  const inGrid = new Map(order.rows.map((r) => [axisKey(r.color), r] as const));

  const mainPo = String(extraction.fields.poNumber ?? '').trim();
  const usedPos = new Set<string>(mainPo ? [safePo(mainPo)] : []);
  const taken = new Map<string, number>();

  splits.forEach((s, i) => {
    const po = safePo(s.poNumber);
    if (usedPos.has(po)) throw new BadRequestError(`PO ${po} is used for two orders. Give each separate order its own PO number.`);
    usedPos.add(po);
    if (s.colors.length === 0) throw new BadRequestError(`The order PO ${po} has no models. Move at least one model into it, or remove it.`);
    for (const c of s.colors) {
      const key = axisKey(c);
      if (!inGrid.has(key)) throw new BadRequestError(`"${c}" is not a model in the grid, so it cannot be moved to PO ${po}.`);
      if (taken.has(key)) throw new BadRequestError(`"${c}" is in two of the separate orders. A model can only be in one order.`);
      taken.set(key, i);
    }
    const pieces = s.colors.reduce((a, c) => a + piecesOf(inGrid.get(axisKey(c))!), 0);
    if (pieces === 0) throw new BadRequestError(`The order PO ${po} has no quantities. Every order needs pieces to cut.`);
  });

  const stays = (color: string) => !taken.has(axisKey(color));
  const mainPieces = order.rows.filter((r) => stays(r.color)).reduce((a, r) => a + piecesOf(r), 0);
  if (mainPieces === 0) {
    throw new BadRequestError(
      `Every model was moved out of PO ${mainPo || 'the document\'s order'}. Keep at least one model in the first order, `
      + 'or remove the models you do not want instead of splitting them off.',
    );
  }

  const main: ExtractionResult = {
    ...extraction,
    fields: {
      ...extraction.fields,
      ...ownPrice(extraction, order.rows.filter((r) => stays(r.color))),
      ...ownName(extraction, order.rows.filter((r) => stays(r.color)).map((r) => r.color)),
    },
    matrices: extraction.matrices.map((m) => keepRows(m, stays)),
    externalColors: extraction.externalColors.filter((e) => stays(e.color)),
  };

  const parts = splits.map((s, i): ExtractionResult => {
    const mine = (color: string) => taken.get(axisKey(color)) === i;
    const models = order.rows.filter((r) => mine(r.color)).map((r) => r.color);
    return {
      ...extraction,
      fields: {
        ...extraction.fields,
        ...ownPrice(extraction, order.rows.filter((r) => mine(r.color))),
        poNumber: s.poNumber.trim(),
        orderName: splitOrderName(models),
      },
      matrices: extraction.matrices.map((m) => keepRows(m, mine)),
      externalColors: extraction.externalColors.filter((e) => mine(e.color)),
      // What the file carried beyond the grid stays with the document's own
      // order: one BOM or lay plan copied onto every split would be counted,
      // reserved and costed once per copy.
      lineItems: [], bom: [], lays: [], costing: {},
    };
  });

  return [main, ...parts];
}

/**
 * An order's price per piece, from its own models.
 *
 * When the document prices each model, the order-level figure is their
 * average weighted by pieces — across the whole document. A jacket order
 * split off at $25 kept the document's $19, and its costing said so.
 */
function ownPrice(extraction: ExtractionResult, rows: ExtractedMatrix['rows']): { pricePerPieceUsd?: number } {
  if (rows.length === 0 || rows.some((r) => r.unitPrice == null)) return {};
  const pcs = rows.reduce((a, r) => a + piecesOf(r), 0);
  if (pcs === 0 || typeof extraction.fields.pricePerPieceUsd !== 'number') return {};
  const value = rows.reduce((a, r) => a + piecesOf(r) * r.unitPrice!, 0);
  return { pricePerPieceUsd: Math.round((value / pcs) * 10_000) / 10_000 };
}

/** The document's own order keeps its name, unless the name only counted the styles it no longer has. */
function ownName(extraction: ExtractionResult, models: string[]): { orderName?: string } {
  const name = String(extraction.fields.orderName ?? '');
  const counted = /^(.*)\((\d+) styles\)\s*$/.exec(name);
  if (!counted) return {};
  return { orderName: models.length === 1 ? splitOrderName(models) : `${counted[1]}(${models.length} styles)` };
}

function safePo(raw: string): string {
  try {
    return normalisePoNumber(raw);
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : 'PO number is required.');
  }
}
