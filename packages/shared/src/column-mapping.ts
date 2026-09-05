/**
 * Universal column mapping.
 *
 * The existing importer reads one workbook shape very well, by finding labelled
 * anchors on named sheets. That is the right tool for a file the factory
 * controls. It is the wrong tool for a file a customer emails, because the
 * customer's file has whatever headers the customer felt like typing.
 *
 * This module is the other half: given a row of unfamiliar header text, work
 * out which concept each column represents.
 *
 *     Customer A:  Style  | Color | Size | Qty
 *     Customer B:  Article| Shade | Size | Pieces
 *
 * Both are the same four concepts. Recognising that is a scoring problem, not a
 * lookup: a header may be an exact synonym, a fuzzy match, a phrase containing
 * a keyword, or nothing at all — and the honest answer for the last case is to
 * say so and ask, rather than to guess.
 *
 * Nothing here is specific to a customer. Everything is data: the synonym table
 * below can be extended without touching the algorithm, and a mapping a
 * coordinator corrects by hand is saved per client and offered first next time.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The concepts a spreadsheet column can represent
// ─────────────────────────────────────────────────────────────────────────────

import { toIsoDayOrNull } from './excel-date.js';

export const ImportConcept = {
  PO_NUMBER: 'PO_NUMBER',
  CLIENT: 'CLIENT',
  ORDER_NAME: 'ORDER_NAME',
  STYLE: 'STYLE',
  ARTICLE: 'ARTICLE',
  PRODUCT_TYPE: 'PRODUCT_TYPE',
  DESCRIPTION: 'DESCRIPTION',
  COLOR: 'COLOR',
  SIZE: 'SIZE',
  QUANTITY: 'QUANTITY',
  UNIT_PRICE: 'UNIT_PRICE',
  CURRENCY: 'CURRENCY',
  MATERIAL: 'MATERIAL',
  FABRIC: 'FABRIC',
  COMPOSITION: 'COMPOSITION',
  SEASON: 'SEASON',
  GENDER: 'GENDER',
  ORDER_DATE: 'ORDER_DATE',
  DELIVERY_DATE: 'DELIVERY_DATE',
  SHIP_DATE: 'SHIP_DATE',
  DESTINATION: 'DESTINATION',
  CUSTOMER_REF: 'CUSTOMER_REF',
  NOTES: 'NOTES',
  UNIT: 'UNIT',
  CONSUMPTION_PER_PIECE: 'CONSUMPTION_PER_PIECE',

  // ── Laying & Marking (packages/server/src/services/import/laying-extractor.ts) ──
  //
  // A fabric name and a colour mean the same thing whether the sheet is
  // creating an order or reporting a lay plan, so FABRIC and COLOR above are
  // reused rather than duplicated here — cross-flow scoring is prevented by
  // the `allowedConcepts` allowlist each caller passes to `analyseColumns`,
  // not by giving every flow its own copy of the same concept.
  LAY_NUMBER: 'LAY_NUMBER',
  MARKER_NUMBER: 'MARKER_NUMBER',
  PANEL: 'PANEL',
  SIZE_RATIO: 'SIZE_RATIO',
  LAYERS: 'LAYERS',
  MARKER_LENGTH: 'MARKER_LENGTH',
  MARKER_WIDTH: 'MARKER_WIDTH',
  TOTAL_LENGTH: 'TOTAL_LENGTH',
  FABRIC_CONSUMPTION: 'FABRIC_CONSUMPTION',
  WASTAGE: 'WASTAGE',
  NEST_PCS: 'NEST_PCS',
  EFFICIENCY: 'EFFICIENCY',
  CUT_DATE: 'CUT_DATE',
  RESPONSIBLE_PERSON: 'RESPONSIBLE_PERSON',

  /** Recognised as a column, but not something the importer uses. */
  IGNORE: 'IGNORE',
} as const;
export type ImportConcept = (typeof ImportConcept)[keyof typeof ImportConcept];

export interface ConceptMeta {
  concept: ImportConcept;
  label: string;
  /** What it becomes on the order, where it maps to a field directly. */
  field: string | null;
  type: 'string' | 'number' | 'date';
  /** An order cannot be created without these. */
  essential?: boolean;
  hint?: string;
}

export const CONCEPT_META: Record<ImportConcept, ConceptMeta> = {
  PO_NUMBER:      { concept: 'PO_NUMBER',      label: 'PO number',            field: 'poNumber',             type: 'string', essential: true,  hint: 'The customer’s purchase order reference' },
  CLIENT:         { concept: 'CLIENT',         label: 'Customer',             field: 'clientName',           type: 'string', essential: true },
  ORDER_NAME:     { concept: 'ORDER_NAME',     label: 'Order name',           field: 'orderName',            type: 'string' },
  STYLE:          { concept: 'STYLE',          label: 'Style',                field: 'styleNumber',          type: 'string' },
  ARTICLE:        { concept: 'ARTICLE',        label: 'Article',              field: 'styleNumber',          type: 'string' },
  PRODUCT_TYPE:   { concept: 'PRODUCT_TYPE',   label: 'Product type',         field: 'itemType',             type: 'string' },
  DESCRIPTION:    { concept: 'DESCRIPTION',    label: 'Description',          field: 'orderName',            type: 'string' },
  COLOR:          { concept: 'COLOR',          label: 'Colour',               field: null,                   type: 'string', essential: true,  hint: 'Becomes a row of the quantity matrix' },
  SIZE:           { concept: 'SIZE',           label: 'Size',                 field: null,                   type: 'string', essential: true,  hint: 'Becomes a column of the quantity matrix' },
  QUANTITY:       { concept: 'QUANTITY',       label: 'Quantity',             field: null,                   type: 'number', essential: true,  hint: 'Pieces for this colour and size' },
  UNIT_PRICE:     { concept: 'UNIT_PRICE',     label: 'Unit price',           field: 'pricePerPieceUsd',     type: 'number' },
  CURRENCY:       { concept: 'CURRENCY',       label: 'Currency',             field: null,                   type: 'string' },
  MATERIAL:       { concept: 'MATERIAL',       label: 'Material',             field: 'fabric',               type: 'string' },
  FABRIC:         { concept: 'FABRIC',         label: 'Fabric',               field: 'fabric',               type: 'string' },
  COMPOSITION:    { concept: 'COMPOSITION',    label: 'Composition',          field: 'fabricDescription',    type: 'string' },
  SEASON:         { concept: 'SEASON',         label: 'Season',               field: 'season',               type: 'string' },
  GENDER:         { concept: 'GENDER',         label: 'Gender',               field: 'gender',               type: 'string' },
  ORDER_DATE:     { concept: 'ORDER_DATE',     label: 'Order date',           field: 'poDate',               type: 'date' },
  DELIVERY_DATE:  { concept: 'DELIVERY_DATE',  label: 'Delivery date',        field: 'requiredDeliveryDate', type: 'date' },
  SHIP_DATE:      { concept: 'SHIP_DATE',      label: 'Ship date',            field: 'promisedShippingDate', type: 'date' },
  DESTINATION:    { concept: 'DESTINATION',    label: 'Destination',          field: 'shippingAddress',      type: 'string' },
  CUSTOMER_REF:   { concept: 'CUSTOMER_REF',   label: 'Customer reference',   field: 'externalReference',    type: 'string' },
  NOTES:          { concept: 'NOTES',          label: 'Special instructions', field: 'generalNotes',         type: 'string' },
  UNIT:           { concept: 'UNIT',           label: 'Unit of measure',      field: null,                   type: 'string' },
  CONSUMPTION_PER_PIECE: { concept: 'CONSUMPTION_PER_PIECE', label: 'Consumption per piece', field: null, type: 'number' },

  LAY_NUMBER:         { concept: 'LAY_NUMBER',         label: 'Lay number',        field: 'position',          type: 'number' },
  MARKER_NUMBER:      { concept: 'MARKER_NUMBER',      label: 'Marker number',     field: 'markerNumber',      type: 'string' },
  PANEL:              { concept: 'PANEL',              label: 'Panel',             field: 'panel',             type: 'string' },
  SIZE_RATIO:         { concept: 'SIZE_RATIO',         label: 'Size ratio',        field: 'sizeRatio',         type: 'string' },
  LAYERS:             { concept: 'LAYERS',             label: 'Layers / plies',    field: 'layers',            type: 'number', essential: true },
  MARKER_LENGTH:      { concept: 'MARKER_LENGTH',      label: 'Marker length (m)', field: 'markerLengthM',     type: 'number', essential: true },
  MARKER_WIDTH:       { concept: 'MARKER_WIDTH',       label: 'Marker width (m)',  field: 'markerWidthM',      type: 'number' },
  TOTAL_LENGTH:       { concept: 'TOTAL_LENGTH',       label: 'Total length (m)',  field: 'totalLengthM',      type: 'number' },
  FABRIC_CONSUMPTION: { concept: 'FABRIC_CONSUMPTION', label: 'Fabric consumption (m)', field: 'actualConsumptionM', type: 'number' },
  WASTAGE:            { concept: 'WASTAGE',            label: 'Wastage (%)',       field: 'wastagePct',        type: 'number' },
  NEST_PCS:           { concept: 'NEST_PCS',           label: 'Pieces per lay',    field: 'nestPcs',           type: 'number' },
  EFFICIENCY:         { concept: 'EFFICIENCY',         label: 'Efficiency (%)',    field: 'efficiencyPct',     type: 'number' },
  CUT_DATE:           { concept: 'CUT_DATE',           label: 'Cut date',          field: 'cutDate',           type: 'date' },
  RESPONSIBLE_PERSON: { concept: 'RESPONSIBLE_PERSON', label: 'Responsible person', field: 'cutByName',        type: 'string' },

  IGNORE:         { concept: 'IGNORE',         label: 'Ignore this column',   field: null,                   type: 'string' },
};

/**
 * Header synonyms, by concept.
 *
 * Everything is matched after normalisation (lowercase, punctuation stripped,
 * runs of whitespace collapsed), so `"Order Qty."`, `"ORDER_QTY"` and
 * `"order qty"` are one entry. Add to this list rather than to the algorithm.
 */
export const CONCEPT_SYNONYMS: Record<ImportConcept, readonly string[]> = {
  PO_NUMBER: [
    'po', 'po no', 'po number', 'po num', 'purchase order', 'purchase order no',
    'order no', 'order number', 'order ref', 'order id', 'po ref', 'ponumber', 'po#', 'order#',
  ],
  CLIENT: [
    'client', 'customer', 'customer name', 'client name', 'buyer', 'buyer name',
    'account', 'company', 'sold to', 'bill to',
  ],
  ORDER_NAME: ['order name', 'programme', 'program', 'project', 'order title', 'job name'],
  STYLE: [
    'style', 'style no', 'style number', 'style code', 'style ref', 'styleno',
    'model', 'model no', 'design', 'design no',
  ],
  ARTICLE: ['article', 'article no', 'article number', 'article code', 'art no', 'art', 'sku', 'item code', 'item no'],
  PRODUCT_TYPE: ['product', 'product type', 'item type', 'garment', 'garment type', 'category', 'type'],
  DESCRIPTION: ['description', 'desc', 'product description', 'item description', 'details', 'item'],
  COLOR: [
    'color', 'colour', 'shade', 'colorway', 'colourway', 'color name', 'colour name',
    'color code', 'colour code', 'col', 'shade name',
  ],
  SIZE: ['size', 'sizes', 'size name', 'size code', 'sz', 'size range', 'garment size'],
  QUANTITY: [
    'qty', 'quantity', 'pcs', 'pieces', 'piece', 'order qty', 'order quantity',
    'total qty', 'total quantity', 'qty pcs', 'no of pcs', 'number of pieces',
    'units', 'amount', 'qnty', 'quantite', 'menge',
  ],
  UNIT_PRICE: [
    'price', 'unit price', 'price per piece', 'price usd', 'unit cost', 'rate',
    'fob', 'fob price', 'cost', 'price per pc', 'usd',
  ],
  CURRENCY: ['currency', 'ccy', 'curr'],
  MATERIAL: ['material', 'material name', 'raw material', 'main material'],
  FABRIC: ['fabric', 'fabric name', 'fabric type', 'base fabric', 'shell fabric', 'cloth'],
  COMPOSITION: ['composition', 'fabric composition', 'content', 'fibre content', 'fiber content'],
  SEASON: ['season', 'collection', 'seasson', 'drop'],
  GENDER: ['gender', 'sex', 'mens womens', 'segment'],
  ORDER_DATE: ['order date', 'po date', 'date', 'issue date', 'created', 'order placed'],
  DELIVERY_DATE: [
    'delivery date', 'due date', 'required date', 'required delivery', 'deliver by',
    'delivery', 'due', 'exfactory', 'ex factory', 'ex factory date', 'xfd',
  ],
  SHIP_DATE: ['ship date', 'shipping date', 'shipment date', 'dispatch date', 'eta', 'etd', 'promised shipping date'],
  DESTINATION: ['destination', 'ship to', 'deliver to', 'delivery address', 'shipping address', 'country', 'port'],
  CUSTOMER_REF: ['customer ref', 'customer reference', 'your ref', 'buyer ref', 'reference', 'ref'],
  NOTES: ['notes', 'note', 'remarks', 'comment', 'comments', 'special instructions', 'instructions'],
  UNIT: ['unit', 'uom', 'unit of measure', 'measure'],
  CONSUMPTION_PER_PIECE: ['consumption', 'cons per piece', 'coms piece', 'consumption per piece', 'usage per piece', 'per piece'],

  LAY_NUMBER: ['lay no', 'lay number', 'lay #', 'lay', 'lay num', 'cut no'],
  MARKER_NUMBER: ['marker no', 'marker number', 'marker #', 'marker ref', 'marker code'],
  PANEL: ['panel', 'part', 'panel name', 'cutting panel', 'component'],
  SIZE_RATIO: ['size ratio', 'ratio', 'size combination', 'size set', 'marker ratio'],
  LAYERS: [
    'layers', 'no of layers', 'number of layers', 'ply', 'plies', 'no of ply',
    'no of plies', 'ply count', 'lay height', 'nb of layers',
  ],
  MARKER_LENGTH: ['marker length', 'length', 'marker len', 'marker length m', 'lay length'],
  MARKER_WIDTH: ['marker width', 'width', 'marker wid'],
  TOTAL_LENGTH: ['total length', 'lay length total', 'total lay length', 'total consumption', 'length used'],
  FABRIC_CONSUMPTION: ['fabric consumption', 'actual consumption', 'cons', 'usage', 'meters used', 'metres used'],
  WASTAGE: ['wastage', 'waste', 'wastage pct', 'waste percent', 'wastage percent', 'loss', 'loss percent'],
  NEST_PCS: ['nest', 'nest pcs', 'pieces per lay', 'pcs per marker', 'output per lay', 'marker output'],
  EFFICIENCY: ['efficiency', 'marker efficiency', 'efficiency percent', 'eff', 'fabric efficiency'],
  CUT_DATE: ['cut date', 'cutting date', 'lay date'],
  RESPONSIBLE_PERSON: ['cut by', 'responsible', 'done by', 'operator', 'marker by', 'prepared by'],

  IGNORE: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. `"Order  Qty."` → `"order qty"`. */
export function normaliseHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\-/\\.,;:()[\]{}'"#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance, capped — we only care whether two short header strings
 * are within a typo of each other, so there is no need to fill the whole matrix
 * for long inputs.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}

export interface ConceptGuess {
  concept: ImportConcept;
  /** 0–1. Above 0.8 the importer proceeds; below, it asks. */
  confidence: number;
  /** Why it matched, shown to the coordinator so the guess is checkable. */
  reason: string;
}

/** Confidence at or above which a guess is applied without asking. */
export const AUTO_ACCEPT_CONFIDENCE = 0.8;

/**
 * Score one header against every concept and return the best guesses.
 *
 * Four kinds of evidence, in descending strength:
 *   1.0   the header is exactly a known synonym
 *   0.92  a synonym with a size/colour qualifier, e.g. "qty pcs"
 *   0.85  the header contains a synonym as a whole word ("total order qty")
 *   0.6+  within one or two edits of a synonym — a typo or a plural
 *
 * A sample of the column's values can raise or lower a guess: a column of
 * numbers is unlikely to be a colour whatever it is called.
 */
export function guessConcept(
  header: string,
  sampleValues: readonly unknown[] = [],
  allowedConcepts?: ReadonlySet<ImportConcept>,
): ConceptGuess[] {
  const h = normaliseHeader(header);
  if (!h) return [{ concept: ImportConcept.IGNORE, confidence: 1, reason: 'Blank header' }];

  const guesses: ConceptGuess[] = [];

  for (const [concept, synonyms] of Object.entries(CONCEPT_SYNONYMS) as Array<[ImportConcept, readonly string[]]>) {
    if (synonyms.length === 0) continue;
    if (allowedConcepts && !allowedConcepts.has(concept)) continue;
    let best = 0;
    let reason = '';

    for (const syn of synonyms) {
      if (h === syn) {
        if (1 > best) { best = 1; reason = `“${header}” is a known name for this`; }
        continue;
      }
      // Whole-word containment: "total order qty" contains "order qty".
      if (containsPhrase(h, syn)) {
        const score = syn.length >= 4 ? 0.85 : 0.7; // short words match by accident
        if (score > best) { best = score; reason = `“${header}” contains “${syn}”`; }
        continue;
      }
      // A typo or a plural.
      if (Math.abs(h.length - syn.length) <= 2 && h.length >= 3) {
        const d = editDistance(h, syn);
        if (d <= 2) {
          const score = d === 1 ? 0.75 : 0.6;
          if (score > best) { best = score; reason = `“${header}” is close to “${syn}”`; }
        }
      }
    }

    if (best > 0) guesses.push({ concept, confidence: best, reason });
  }

  const adjusted = guesses.map((g) => applyValueEvidence(g, sampleValues));
  adjusted.sort((a, b) => b.confidence - a.confidence);

  if (adjusted.length === 0) {
    return [{ concept: ImportConcept.IGNORE, confidence: 0, reason: `“${header}” was not recognised` }];
  }
  return adjusted.slice(0, 4);
}

/** Whole-word phrase containment, so "size" does not match "resized". */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length < 2) return false;
  const words = haystack.split(' ');
  const nWords = needle.split(' ');
  for (let i = 0; i + nWords.length <= words.length; i++) {
    if (nWords.every((w, k) => words[i + k] === w)) return true;
  }
  return false;
}

/**
 * Let the data argue with the header.
 *
 * A column headed "Size" holding 1,972 and 480 is a quantity column somebody
 * mislabelled, or a size column holding numeric sizes — either way the header
 * alone should not carry full confidence. Conversely a column of small integers
 * under an ambiguous header is more likely to be a quantity.
 */
function applyValueEvidence(guess: ConceptGuess, samples: readonly unknown[]): ConceptGuess {
  const values = samples.filter((v) => v != null && String(v).trim() !== '');
  if (values.length === 0) return guess;

  const numericShare =
    values.filter((v) => typeof v === 'number' || /^-?[\d,]+(\.\d+)?$/.test(String(v).trim())).length / values.length;
  const dateShare =
    values.filter((v) => v instanceof Date || !Number.isNaN(Date.parse(String(v)))).length / values.length;

  const meta = CONCEPT_META[guess.concept];
  let confidence = guess.confidence;
  let reason = guess.reason;

  if (meta.type === 'number' && numericShare < 0.5) {
    confidence *= 0.5;
    reason += `, but the values are mostly not numbers`;
  }
  if (meta.type === 'number' && numericShare >= 0.9) {
    confidence = Math.min(1, confidence * 1.1);
  }
  if (meta.type === 'string' && guess.concept !== ImportConcept.SIZE && numericShare >= 0.9) {
    // Sizes are legitimately numeric (32, 34, 36); other text fields are not.
    confidence *= 0.7;
    reason += `, but every value is a number`;
  }
  if (meta.type === 'date' && dateShare < 0.5) {
    confidence *= 0.4;
    reason += `, but the values do not look like dates`;
  }

  return { ...guess, confidence: Math.round(confidence * 100) / 100, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-table resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface ColumnAnalysis {
  index: number;
  header: string;
  /** Up to five non-empty values, for the preview and for value evidence. */
  samples: string[];
  guesses: ConceptGuess[];
  /** The applied choice: the top guess, a saved mapping, or the user's pick. */
  concept: ImportConcept;
  confidence: number;
  /** True when the importer chose without being confident. Drives "please confirm". */
  needsConfirmation: boolean;
  source: 'AUTO' | 'SAVED' | 'MANUAL';
}

/**
 * Resolve a whole header row.
 *
 * A saved mapping for this client always wins over a fresh guess — the point of
 * saving it is that a human already decided. Beyond that, each column takes its
 * best guess, and anything below the auto-accept threshold is flagged for
 * confirmation rather than quietly applied.
 *
 * One concept, one column: if two columns both claim QUANTITY, the more
 * confident keeps it and the other is offered as a choice. Two quantity columns
 * silently summed is a wrong order total that nobody notices until cutting.
 */
export function analyseColumns(
  headers: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  savedMapping: Readonly<Record<string, ImportConcept>> = {},
  allowedConcepts?: ReadonlySet<ImportConcept>,
): ColumnAnalysis[] {
  const analyses: ColumnAnalysis[] = headers.map((header, index) => {
    const samples = rows
      .map((r) => r[index])
      .filter((v) => v != null && String(v).trim() !== '')
      .slice(0, 5)
      // Not `v.toISOString()`: an Invalid Date passes `instanceof Date` and
      // throws. Sampling five cells to guess a column's meaning must never be
      // able to kill an import — this was the third of the three sites.
      .map((v) => (v instanceof Date ? (toIsoDayOrNull(v) ?? '(unreadable date)') : String(v)));

    const columnValues = rows.map((r) => r[index]);
    const saved = savedMapping[normaliseHeader(header)];

    if (saved) {
      return {
        index, header, samples,
        guesses: guessConcept(header, columnValues, allowedConcepts),
        concept: saved,
        confidence: 1,
        needsConfirmation: false,
        source: 'SAVED' as const,
      };
    }

    const guesses = guessConcept(header, columnValues, allowedConcepts);
    const top = guesses[0]!;
    return {
      index, header, samples, guesses,
      concept: top.concept,
      confidence: top.confidence,
      needsConfirmation: top.confidence < AUTO_ACCEPT_CONFIDENCE || top.concept === ImportConcept.IGNORE,
      source: 'AUTO' as const,
    };
  });

  return resolveDuplicates(analyses);
}

/** Concepts that may legitimately appear on more than one column. */
const REPEATABLE = new Set<ImportConcept>([ImportConcept.IGNORE, ImportConcept.NOTES]);

function resolveDuplicates(analyses: ColumnAnalysis[]): ColumnAnalysis[] {
  const claimed = new Map<ImportConcept, ColumnAnalysis>();

  for (const a of [...analyses].sort((x, y) => y.confidence - x.confidence)) {
    if (a.concept === ImportConcept.IGNORE || REPEATABLE.has(a.concept)) continue;
    const holder = claimed.get(a.concept);
    if (!holder) {
      claimed.set(a.concept, a);
      continue;
    }
    // Loser falls back to its next-best guess, and is always flagged: two
    // columns competing for one concept is exactly when a human should look.
    const next = a.guesses.find((g) => g.concept !== a.concept && !claimed.has(g.concept));
    a.concept = next?.concept ?? ImportConcept.IGNORE;
    a.confidence = next ? next.confidence * 0.8 : 0;
    a.needsConfirmation = true;
    if (a.concept !== ImportConcept.IGNORE) claimed.set(a.concept, a);
  }

  return analyses;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────────

export interface MappingReadiness {
  ready: boolean;
  /** Essential concepts with no column assigned. */
  missing: ImportConcept[];
  /** Columns the coordinator should look at before importing. */
  unconfirmed: ColumnAnalysis[];
  /** Concepts that were found, for the "Excel Analysis" checklist. */
  detected: ImportConcept[];
}

/**
 * Can this mapping produce an order?
 *
 * Colour, size and quantity are the irreducible minimum — without them there is
 * no quantity matrix and therefore no order. A PO number and a customer can be
 * typed in on the review screen if the file does not carry them, so they are
 * reported as detected-or-not but do not block.
 */
export const MATRIX_ESSENTIALS: readonly ImportConcept[] = [
  ImportConcept.COLOR,
  ImportConcept.SIZE,
  ImportConcept.QUANTITY,
];

export function assessMapping(
  analyses: readonly ColumnAnalysis[],
  essentials: readonly ImportConcept[] = MATRIX_ESSENTIALS,
): MappingReadiness {
  const assigned = new Set(analyses.map((a) => a.concept));
  const missing = essentials.filter((c) => !assigned.has(c));

  return {
    ready: missing.length === 0,
    missing,
    unconfirmed: analyses.filter((a) => a.needsConfirmation && a.concept !== ImportConcept.IGNORE),
    detected: [...assigned].filter((c) => c !== ImportConcept.IGNORE),
  };
}

/**
 * The checklist shown after analysis — §5's "✓ Quantity detected".
 * Reports on the concepts a coordinator expects to see, present or not.
 */
export const ANALYSIS_CHECKLIST: readonly ImportConcept[] = [
  ImportConcept.PO_NUMBER,
  ImportConcept.CLIENT,
  ImportConcept.STYLE,
  ImportConcept.COLOR,
  ImportConcept.SIZE,
  ImportConcept.QUANTITY,
  ImportConcept.MATERIAL,
  ImportConcept.DELIVERY_DATE,
];

/** Turn the resolved mapping into the shape saved against a client. */
export function toSavedMapping(analyses: readonly ColumnAnalysis[]): Record<string, ImportConcept> {
  const out: Record<string, ImportConcept> = {};
  for (const a of analyses) {
    if (a.concept === ImportConcept.IGNORE) continue;
    out[normaliseHeader(a.header)] = a.concept;
  }
  return out;
}
