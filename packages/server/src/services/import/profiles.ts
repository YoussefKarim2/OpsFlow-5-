/**
 * Import profiles.
 *
 * A profile describes how to read a family of workbooks. The key design choice
 * is **anchor-relative addressing**: instead of hard-coding `D7`, a field says
 * "find the cell that reads 'Po No', then take the cell one to the right".
 *
 * That matters because real files are edited. Someone inserts a row above the
 * header and every hard-coded reference silently reads the wrong cell — the
 * failure mode being that the import succeeds with wrong data. Anchors survive
 * inserted rows and columns; when an anchor is genuinely missing, the extractor
 * reports it as an unresolved mapping rather than guessing.
 */

export interface FieldSpec {
  field: string;
  label: string;
  sheet: string;
  /** Text to locate, case-insensitive, ignoring trailing punctuation and spaces. */
  anchor: string;
  /** [rowOffset, colOffset] from the anchor cell. Usually [0, 1]. */
  offset: [number, number];
  type: 'string' | 'number' | 'date' | 'percent';
  required?: boolean;
}

export interface MatrixSpec {
  /** Which ledger the matrix populates. */
  ledger: 'ORDER' | 'STOCK' | 'CUT';
  sheet: string;
  /** Cell text marking the top-left of the header row, e.g. "Color". */
  headerAnchor: string;
  /** Row label that ends the data block. */
  terminator: string;
}

export interface SheetSignature {
  /** Sheet names expected in this profile, used to score a match. */
  names: string[];
}

export interface ImportProfile {
  key: string;
  label: string;
  description: string;
  signature: SheetSignature;
  fields: FieldSpec[];
  matrices: MatrixSpec[];
  bom?: {
    sheet: string;
    headerAnchor: string;
    columns: Record<string, string>;
  };
  external?: {
    sheet: string;
    headerAnchor: string;
    terminator: string;
  };
  lays?: {
    sheet: string;
    headerAnchor: string;
    terminator: string;
  };
  production?: {
    sheet: string;
    headerAnchor: string;
  };
  costing?: {
    sheet: string;
    fields: FieldSpec[];
  };
}

/**
 * The AGE order workbook — the 17-sheet format this project was built from.
 * Matches `PO No. 85 – A302059B Florida T Shirt Summer order 2026.xlsx` exactly.
 */
export const AGE_ORDER_V1: ImportProfile = {
  key: 'age-order-v1',
  label: 'AGE Order Workbook (17 sheets)',
  description:
    'The standard AGE order follow-up workbook: Customer Order Ref, Order Details, Main Order, ' +
    'Proforma Invoice, Progress Status, Cut Order, Laying fabric instructions, External Order, ' +
    'Bill Of Matrial, Custom Instructions, Packing, Stock, Follow up, Production Follow up, ' +
    'Audit, Actual Costing and Data-Base.',

  signature: {
    names: [
      'Customer Order Ref_Coordinator',
      'Order Details_Coordinator',
      'Main Order_Factory.Manger',
      'Proforma Invoice_Factory.Manger',
      'Progress Status',
      'Cut Order',
      'Laying fabric instructions_Patr',
      'External Order_Ex.Op',
      'Bill Of Matrial_Coord_Warehouse',
      'Custom Instructions_Coordinator',
      'Packing_Coordinator',
      'Stock_Packing',
      'Follow up',
      'Production Follow up',
      'Audit_Quality Manger',
      'Actual Costing_Coordinator',
      'Data-Base',
    ],
  },

  // All anchored on the Order Details sheet, which is the workbook's own source
  // of truth — every other sheet mirrors it with `='Order Details'!Dn` formulas.
  fields: [
    { field: 'clientName',           label: 'Client',                  sheet: 'Order Details_Coordinator', anchor: 'Client',                   offset: [0, 1], type: 'string', required: true },
    { field: 'season',               label: 'Season',                  sheet: 'Order Details_Coordinator', anchor: 'Seasson',                  offset: [0, 1], type: 'string', required: true },
    { field: 'poNumber',             label: 'PO Number',               sheet: 'Order Details_Coordinator', anchor: 'Po No',                    offset: [0, 1], type: 'string', required: true },
    { field: 'orderName',            label: 'Order Name',              sheet: 'Order Details_Coordinator', anchor: 'Order name',               offset: [0, 1], type: 'string', required: true },
    { field: 'itemType',             label: 'Item Type',               sheet: 'Order Details_Coordinator', anchor: 'Item Type',                offset: [0, 1], type: 'string' },
    { field: 'fit',                  label: 'Fit',                     sheet: 'Order Details_Coordinator', anchor: 'Fit',                      offset: [0, 1], type: 'string' },
    { field: 'blockPattern',         label: 'Block Pattern',           sheet: 'Order Details_Coordinator', anchor: 'Block Pattern',            offset: [0, 1], type: 'string' },
    { field: 'gender',               label: 'Gender',                  sheet: 'Order Details_Coordinator', anchor: 'Gender',                   offset: [0, 1], type: 'string' },
    { field: 'styleNumber',          label: 'Style Number',            sheet: 'Order Details_Coordinator', anchor: 'Style No',                 offset: [0, 1], type: 'string' },
    { field: 'coordinatorName',      label: 'Coordinator',             sheet: 'Order Details_Coordinator', anchor: 'Coordinator',              offset: [0, 1], type: 'string' },
    { field: 'outsideWorkManager',   label: 'Outside Work Manager',    sheet: 'Order Details_Coordinator', anchor: 'Outside work Manager',     offset: [0, 1], type: 'string' },
    { field: 'pricePerPieceUsd',     label: 'Price in USD',            sheet: 'Order Details_Coordinator', anchor: 'Price in US$',             offset: [0, 1], type: 'number' },
    { field: 'shippingMethod',       label: 'Shipping Method',         sheet: 'Order Details_Coordinator', anchor: 'Method of shipping',       offset: [0, 1], type: 'string' },
    { field: 'cutPercentage',        label: 'Cut Percentage',          sheet: 'Order Details_Coordinator', anchor: 'Cut Percentage',           offset: [0, 1], type: 'percent' },
    { field: 'accessoryPercentage',  label: 'Accessory Percentage',    sheet: 'Order Details_Coordinator', anchor: 'Acc Percentage',           offset: [0, 1], type: 'percent' },
    { field: 'externalFactoryName',  label: 'External Factory',        sheet: 'Order Details_Coordinator', anchor: 'Extrnal Factory Name',     offset: [0, 1], type: 'string' },
    { field: 'fabric',               label: 'Fabric',                  sheet: 'Order Details_Coordinator', anchor: 'Fabric',                   offset: [0, 1], type: 'string' },
    { field: 'poDate',               label: 'PO Date',                 sheet: 'Order Details_Coordinator', anchor: 'Po Date',                  offset: [0, 1], type: 'date' },
    { field: 'promisedShippingDate', label: 'Promised Shipping Date',  sheet: 'Order Details_Coordinator', anchor: 'Promissed shipping date',  offset: [0, 1], type: 'date' },
    { field: 'requiredDeliveryDate', label: 'Required Delivery Date',  sheet: 'Order Details_Coordinator', anchor: 'Required delivery date',   offset: [0, 1], type: 'date' },
    { field: 'externalWorkSort',     label: 'External Work Sort',      sheet: 'Order Details_Coordinator', anchor: 'External Work Sort',       offset: [0, 1], type: 'string' },
    { field: 'externalWorkType',     label: 'External Work Type',      sheet: 'Order Details_Coordinator', anchor: 'External Work Type',       offset: [0, 1], type: 'string' },
    { field: 'shippingAddress',      label: 'Shipping Address',        sheet: 'Order Details_Coordinator', anchor: 'Shipping Adress',          offset: [0, 1], type: 'string' },
    { field: 'billingAddress',       label: 'Billing Address',         sheet: 'Order Details_Coordinator', anchor: 'Billing Adress',           offset: [0, 1], type: 'string' },
    { field: 'generalNotes',         label: 'General Notes',           sheet: 'Order Details_Coordinator', anchor: 'General Notes',            offset: [0, 1], type: 'string' },
    { field: 'spreadNotes',          label: 'Spread Notes',            sheet: 'Order Details_Coordinator', anchor: 'Spread Notes',             offset: [0, 1], type: 'string' },
    { field: 'cutNotes',             label: 'Cut Notes',               sheet: 'Order Details_Coordinator', anchor: 'Cut Notes',                offset: [0, 1], type: 'string' },
    { field: 'packingNotes',         label: 'Packing Instructions',    sheet: 'Order Details_Coordinator', anchor: 'Packing Inst',             offset: [0, 1], type: 'string' },
    { field: 'externalNotes',        label: 'External Notes',          sheet: 'Order Details_Coordinator', anchor: 'External Notes',           offset: [0, 1], type: 'string' },
  ],

  matrices: [
    // The Main Order matrix is the only one imported as fact. Cut is derived
    // from it by formula, and importing a derived value risks importing a stale
    // one — so it is recomputed rather than read.
    { ledger: 'ORDER', sheet: 'Main Order_Factory.Manger', headerAnchor: 'Color', terminator: 'Totals' },
    { ledger: 'STOCK', sheet: 'Stock_Packing',             headerAnchor: 'Color', terminator: 'Totals' },
  ],

  bom: {
    sheet: 'Bill Of Matrial_Coord_Warehouse',
    headerAnchor: 'Item Sort',
    columns: {
      category: 'Item Sort',
      position: 'Position',
      consumptionPerPiece: 'Coms./Piece',
      item: 'Item',
      description: 'Description',
      color: 'Color',
      requiredQty: 'Order Qty',
      unit: 'Unit',
      issuedQty: 'Material issued',
      issuedBy: 'Issued by',
      issuedTo: 'Issued to',
    },
  },

  external: { sheet: 'External Order_Ex.Op', headerAnchor: 'Color', terminator: 'Totals' },
  lays:     { sheet: 'Laying fabric instructions_Patr', headerAnchor: 'fabric', terminator: 'TOTAL' },
  production: { sheet: 'Production Follow up', headerAnchor: 'ITEM' },

  costing: {
    sheet: 'Actual Costing_Coordinator',
    fields: [
      { field: 'dollarRate',      label: 'Dollar Rate',      sheet: 'Actual Costing_Coordinator', anchor: 'Dollar Rate',      offset: [0, 1], type: 'number' },
      { field: 'dailyCostEgp',    label: 'Daily Cost',       sheet: 'Actual Costing_Coordinator', anchor: 'Daily Cost',       offset: [0, 1], type: 'number' },
      { field: 'machineCount',    label: 'All F. Machines',  sheet: 'Actual Costing_Coordinator', anchor: 'All F. Machines',  offset: [0, 1], type: 'number' },
      { field: 'machineDaysUsed', label: 'Machines Used',    sheet: 'Actual Costing_Coordinator', anchor: 'Machine Already Used', offset: [1, 0], type: 'number' },
      { field: 'daysInLine',      label: 'Days in Line',     sheet: 'Actual Costing_Coordinator', anchor: 'Days in line',     offset: [1, 0], type: 'number' },
    ],
  },
};

export const PROFILES: ImportProfile[] = [AGE_ORDER_V1];

/**
 * Score each profile against the sheet names in an uploaded file.
 * A file matching every expected sheet scores 1.0.
 */
export function detectProfile(sheetNames: string[]): { profile: ImportProfile | null; confidence: number } {
  const normalised = sheetNames.map((s) => s.trim().toLowerCase());
  let best: { profile: ImportProfile; confidence: number } | null = null;

  for (const profile of PROFILES) {
    const expected = profile.signature.names.map((s) => s.trim().toLowerCase());
    const hits = expected.filter((e) => normalised.includes(e)).length;
    const confidence = expected.length === 0 ? 0 : hits / expected.length;
    if (!best || confidence > best.confidence) best = { profile, confidence };
  }

  // Below half the expected sheets, treat it as an unknown layout needing
  // manual mapping rather than forcing a bad automatic match.
  if (!best || best.confidence < 0.5) return { profile: null, confidence: best?.confidence ?? 0 };
  return best;
}
