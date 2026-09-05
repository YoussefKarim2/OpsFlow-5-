/**
 * Seed data transcribed from
 * `PO No. 85 – A302059B Florida T Shirt Summer order 2026.xlsx`.
 *
 * Every number here was read out of the workbook. Nothing is invented, per the
 * brief's instruction not to make up quantities for this order.
 */

// ── Reference data — the Data-Base sheet ────────────────────────────────────

export const SEASONS = ['Spring 26', 'SS26', 'FW26', 'Summer 26', 'Winter 26'];

export const ITEM_TYPES = [
  'T-Shirt', 'Short', 'Kit', 'Polo Shirt', 'Chemise', 'Swimming Short', 'Legging',
  'Vest', 'Running Vest', 'Athlete Vest', 'Basket Ball Vest', 'Base Ball T-shirt',
  'Cycle Top', 'Skort', 'Hoodie', 'Jacket', 'Hoodied Jacket', 'Sweet Shirt',
  'Sports Bra', 'Legging Short', 'Pants',
];

export const FITS = ['Regular', 'Slim', 'Lose Fit', 'Skinny'];

export const BLOCK_PATTERNS = [
  'submarine', 'League Short', 'Durham shirt', 'Cardiff', 'Continital',
  'Britania male', 'Britania Female',
];

export const GENDERS = ['Male', 'Female', 'Unisex', 'Kids', 'Teddy'];

export const SHIPPING_METHODS = ['Sea', 'Air', 'In Hand'];

export const FABRICS = [
  'Rosetta', '29/1923', 'Skin', 'Rosetta Pro Time', 'Rosetta Pro Time Boulder',
  'Rosetta Albasha', '29/1990', '29/1990 Only Olympic Team', '1990', 'Water Proof',
  'Water Proof Lisbon', 'Water Proof Licra', 'Ko 200', 'F 96', 'Nation Fabric',
  '29/2082 Sheffild', 'St James 29/2128', 'Tranmmere', '29/2115 Close Mesh',
  'Gsx 11 Close Mesh', 'Gsx 25 Close Mesh', 'Gsx 5 Close Mesh', 'Gsx 1 Close Mesh',
  'Rib 1X1', 'Rib 1X1 20/1', 'Rib 1X1 24/1', 'Rib 2X2', 'Rib 2X2 24/1',
  'Sin Jer 20/1', 'Sin Jer 24/1', 'Lestar City', 'Rosario', 'Leeds', 'Leeds Printed',
  '29/2165', 'Bib', 'Villa Hoody', 'Rib Villa', 'A3 29/2203', 'A3 29/2139Ry',
  '29/2214', 'Gabardine', 'Mesh American Football', 'Mesh', 'Mesh Protime',
  'Carlisle Knitted Jacket', 'Ragby 29/2136', 'Swindon', 'Close Mesh Jaket',
  'Lining Hoody', 'Rib 37', '29/2114', '29/2039', 'Rib 45', 'B 3', 'B 3 Clover',
  'Melton', 'Summer Melton', 'Rib Melton', 'Rib Summer', 'Sin Jer', 'Rib Sin Jer',
  'Pique', '29/2113 ( Bird Eye )', 'Klamer', 'Kadi Fabric', 'Sin Jer 30/1',
  'Interloak Kady', 'Honeycomb Kady', 'Pique Pant', 'Lining Dog',
];

export const POSITIONS = [
  'Main fabric', 'Front', 'Back', 'Cole', 'Right Top Front', 'Left Top Front',
  'Center Top Front', 'Center Front', 'Inside Top Back', 'Inside Right', 'Inside Left',
  'Inside Hem', 'Inside Waist Band', 'Outside Waist Band', 'In Hoodie', 'Cuff',
  'Right Sleeve', 'Both Sleeves', 'Left Sleeve', 'Right Leg', 'Left Leg',
  'On Pocket', 'Pockets', 'Front Left Hem', 'Front Right Hem', 'Cut Side Panel',
  'Collar', 'ALL', 'Collar+Cuff', 'Hoddi', 'Front+Sl', 'Front+Sl+Ins', 'Sl R', 'Sl L',
];

export const UNITS = ['Met.', 'Pcs', 'Kg.', 'Grm.', 'Cm.', 'Block', 'Roll'];

export const ITEM_SORTS = [
  'Fabric', 'Logo', 'Badge', 'Sponser', 'Size', 'Number', 'Authantic Bdge',
  'Washing Inst.', 'Elastic', 'Tie Cord', 'Thread', 'Tape', 'Sponge', 'Poly Bag',
  'Poly Bag Size', 'Hang Tag', 'Hang Tag Pins', 'Barcode Paper', 'Butter Paper',
  'Hologrram', 'Sticky Tape', 'Dzn. Box', 'Half Box', 'Carton', 'Side Woven', 'Yoko',
];

/** External work types, with the Arabic the factory actually uses. */
export const EXTERNAL_WORK_TYPES: Array<{ en: string; ar: string; sort: string }> = [
  { en: 'Print Front',        ar: 'طباعة صدر',          sort: 'Print' },
  { en: 'Print Right Front',  ar: 'طباعة صدر يمين',     sort: 'Print' },
  { en: 'Print Left Front',   ar: 'طباعة صدر شمال',     sort: 'Print' },
  { en: 'Print Sleeves',      ar: 'طباعة الأكمام',       sort: 'Print' },
  { en: 'Print Right Sleeves',ar: 'طباعة الكم يمين',     sort: 'Print' },
  { en: 'Print Left Sleeves', ar: 'طباعة الكم الشمال',   sort: 'Print' },
  { en: 'Print Back',         ar: 'طباعة الظهر',         sort: 'Print' },
  { en: 'Full Print',         ar: 'طباعة قطعة كاملة',    sort: 'Print' },
  { en: 'Print Right Panel',  ar: 'طباعة القطعة اليمين', sort: 'Print' },
  { en: 'Print Left Panel',   ar: 'طباعة القطعة شمال',   sort: 'Print' },
  { en: 'Print Badges',       ar: 'طباعة البادجات',      sort: 'Print' },
  { en: 'Print Roll',         ar: 'طباعة أمتار',         sort: 'Print' },
  { en: 'Emb. Badges',        ar: 'قص البادجات',         sort: 'Embroidery' },
  { en: 'Emb. Front',         ar: 'تطريز الصدر',         sort: 'Embroidery' },
  { en: 'Emb. Right Front',   ar: 'تطريز صدر يمين',      sort: 'Embroidery' },
  { en: 'Emb. Left Front',    ar: 'تطريز صدر شمال',      sort: 'Embroidery' },
  { en: 'Emb. Sleeves',       ar: 'تطريز الأكمام',       sort: 'Embroidery' },
  { en: 'Emb. Right Sleeves', ar: 'تطريز كم يمين',       sort: 'Embroidery' },
  { en: 'Emb. Left Sleeves',  ar: 'تطريز كم شمال',       sort: 'Embroidery' },
  { en: 'Emb. Back',          ar: 'تطريز ظهر',           sort: 'Embroidery' },
  { en: 'Emb. Right Panel',   ar: 'تطريز القطعة اليمين', sort: 'Embroidery' },
  { en: 'Emb. Left Panel',    ar: 'تطريز القطعة الشمال', sort: 'Embroidery' },
];

/** Colours from the Data-Base sheet. Hex added for the matrix swatches. */
export const COLORS: Array<{ name: string; hex: string | null }> = [
  { name: 'SKY BLUE',   hex: '#7EC8E3' },
  { name: 'ATH. GOLD',  hex: '#D4A017' },
  { name: 'SCARLET',    hex: '#C81D25' },
  { name: 'LIME',       hex: '#B5D334' },
  { name: 'Black',      hex: '#1A1A1A' },
  { name: 'White',      hex: '#FFFFFF' },
  { name: 'Navy',       hex: '#1B2A4A' },
  { name: 'Royal',      hex: '#2B4FA2' },
  { name: 'Red',        hex: '#D22B2B' },
  { name: 'F.Green',    hex: '#1E6B3C' },
  { name: 'Grey',       hex: '#8A8A8A' },
  { name: 'Maroon',     hex: '#6B1F30' },
  { name: 'Orange',     hex: '#E4761B' },
  { name: 'Purple',     hex: '#6A3D9A' },
  { name: 'Teal',       hex: '#1F7A7A' },
  { name: 'Columbia',   hex: '#9BCBEB' },
  { name: 'V.Gold',     hex: '#C9A227' },
  { name: 'Charcoal',   hex: '#3C3C3C' },
  { name: 'Silver',     hex: '#C0C0C0' },
  { name: 'Pink',       hex: '#E8A0BF' },
];

/** Sizes with the long form the Customer Order Ref sheet uses. */
export const SIZES: Array<{ name: string; longName: string }> = [
  { name: '2YXS', longName: 'YOUTH 2X-SMALL' },
  { name: 'YXS',  longName: 'YOUTH X-SMALL' },
  { name: 'YS',   longName: 'YOUTH SMALL' },
  { name: 'YM',   longName: 'YOUTH MEDIUM' },
  { name: 'YL',   longName: 'YOUTH LARGE' },
  { name: 'S',    longName: 'ADULT SMALL' },
  { name: 'M',    longName: 'ADULT MEDIUM' },
  { name: 'L',    longName: 'ADULT LARGE' },
  { name: 'XL',   longName: 'ADULT X-LARGE' },
  { name: '2XL',  longName: 'ADULT 2X-LARGE' },
  { name: '3XL',  longName: 'ADULT 3X-LARGE' },
];

// ── The order itself ────────────────────────────────────────────────────────

/** Main Order_Factory.Manger!C23:M26 — the sizes used by this order. */
export const ORDER_SIZES = ['2YXS', 'YXS', 'YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL'];

export const ORDER_MATRIX: Record<string, number[]> = {
  'SKY BLUE':  [20, 50, 138, 141, 90, 70, 35, 20, 10, 5], // total 579
  'ATH. GOLD': [20, 55, 114, 115, 60, 30, 35, 20, 10, 5], // total 464
  'SCARLET':   [20, 40,  80,  80, 70, 30, 35, 15, 10, 5], // total 385
  'LIME':      [20, 50, 138, 141, 80, 50, 35, 15, 10, 5], // total 544
};                                                        // grand total 1,972

/** Per-colour product names from the Customer Order Ref sheet. */
export const PRODUCT_NAMES: Record<string, string> = {
  'SKY BLUE':  'CREW NECK SOCCER JERSEY - STRIKERS',
  'ATH. GOLD': 'CREW NECK SOCCER JERSEY - BREAKERS',
  'SCARLET':   'CREW NECK SOCCER JERSEY - WOLVES',
  'LIME':      'CREW NECK SOCCER JERSEY - NIGHTHAWKS',
};

export const ORDER = {
  poNumber: 'A302059B',
  orderName: 'Florida T shirt',
  season: 'Summer 26',
  itemType: 'T-Shirt',
  gender: 'Male',
  styleNumber: '3091',
  fabric: 'Rosetta',
  shippingMethod: 'Air',
  pricePerPieceUsd: 7.25,
  cutPercentage: 0.05,
  accessoryPercentage: 0.05,
  poDate: '2026-08-04',
  promisedShippingDate: '2026-09-13',
  requiredDeliveryDate: '2026-09-13',
  externalWorkSort: 'Print',
  externalWorkTypeAr: 'طباعة قطعة كاملة',
  externalWorkTypeEn: 'Full-piece printing',
  clientName: 'ProTime',
  externalFactoryName: 'AGE',
  coordinatorName: 'Hassona',
  outsideWorkManagerName: 'Helmy',
  shippingAddress:
    'FLORIDA CELTIC\nJOHN ORR\n1645 EAST GROVELEAF AVE\nPALM HARBOR, FL 34683\n(727) 459-7287\nJohn.orr@floridaceltic.com',
  billingAddress:
    'PROTIME SPORTS INC\n18200 SEGALE PARK DRIVE B\nSEATTLE, WA 98188. USA\nTEL: 800-575-1603',
};

/** Free-text notes, verbatim from Order Details_Coordinator. */
export const NOTES = {
  SPREAD:
    'يوجد تكت جنب ستان - فى اقلام فى الجنب يجب ان تكون ماتش الصدر مع الظهر يجب عمل تكت المقاس الجديد فرى فتلات',
  EXTERNAL:
    'سيتم ارسال مساحات الكول بعد الانتهاء من حساب الاستهلاكات\nرفع اوثانتيك بادج 1 سم\nبرجاء عدم البدء ف طباعه الاوردر الا بعد موافقه العميل',
};

/**
 * BOM — Bill Of Matrial_Coord_Warehouse!C17:N40. Twenty-three lines.
 *
 * In the live file every single line has `Material issued` blank, so the
 * shortage column shows the full requirement as a negative. That is the real
 * state of this order and it is seeded as such: 23 lines, nothing issued.
 */
export const BOM: Array<{
  category: string; position: string | null; item: string; description: string | null;
  color: string | null; requiredQty: number; unit: string; consumptionPerPiece: number | null;
}> = [
  { category: 'FABRIC', position: 'ALL',  item: 'cut',   description: 'Rosetta', color: 'White',     requiredQty: 1194,  unit: 'Met.', consumptionPerPiece: 0.5729 },
  { category: 'FABRIC', position: 'Cole', item: 'print', description: 'Rosetta', color: 'SKY BLUE',  requiredQty: 22,    unit: 'Met.', consumptionPerPiece: 0.035 },
  { category: 'FABRIC', position: 'Cole', item: 'print', description: 'Rosetta', color: 'ATH. GOLD', requiredQty: 18,    unit: 'Met.', consumptionPerPiece: 0.035 },
  { category: 'FABRIC', position: 'Cole', item: 'print', description: 'Rosetta', color: 'SCARLET',   requiredQty: 15,    unit: 'Met.', consumptionPerPiece: 0.035 },
  { category: 'FABRIC', position: 'Cole', item: 'print', description: 'Rosetta', color: 'LIME',      requiredQty: 21,    unit: 'Met.', consumptionPerPiece: 0.035 },

  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: '2YXS', color: 'DTF', requiredQty: 84,  unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'YXS',  color: 'DTF', requiredQty: 206, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'YS',   color: 'DTF', requiredQty: 494, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'YM',   color: 'DTF', requiredQty: 503, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'YL',   color: 'DTF', requiredQty: 316, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'S',    color: 'DTF', requiredQty: 191, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'M',    color: 'DTF', requiredQty: 148, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'L',    color: 'DTF', requiredQty: 74,  unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: 'XL',   color: 'DTF', requiredQty: 44,  unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'SIZE', position: 'Inside Top Back', item: 'Florida Transfer Size', description: '2XL',  color: 'DTF', requiredQty: 24,  unit: 'Pcs', consumptionPerPiece: 1 },

  { category: 'THREAD', position: 'Main fabric', item: 'Star Thread Roll', description: 'NO.', color: 'SKY BLUE',  requiredQty: 38.25,   unit: 'Pcs', consumptionPerPiece: null },
  { category: 'THREAD', position: 'Main fabric', item: 'Star Thread Roll', description: 'NO.', color: 'ATH. GOLD', requiredQty: 30.625,  unit: 'Pcs', consumptionPerPiece: null },
  { category: 'THREAD', position: 'Main fabric', item: 'Star Thread Roll', description: 'NO.', color: 'SCARLET',   requiredQty: 25.4375, unit: 'Pcs', consumptionPerPiece: null },
  { category: 'THREAD', position: 'Main fabric', item: 'Star Thread Roll', description: 'NO.', color: 'LIME',      requiredQty: 35.9375, unit: 'Pcs', consumptionPerPiece: null },

  { category: 'POLY_BAG',     position: null, item: 'Hummel',  description: null, color: null, requiredQty: 2084, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'BUTTER_PAPER', position: null, item: 'Butter Paper', description: null, color: null, requiredQty: 2084, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'STICKY_TAPE',  position: null, item: 'Unisex',  description: null, color: null, requiredQty: 2084, unit: 'Pcs', consumptionPerPiece: 1 },
  { category: 'CARTON',       position: null, item: 'Protime', description: null, color: null, requiredQty: 25,   unit: 'Pcs', consumptionPerPiece: null },
];

/**
 * Lay plan — Laying fabric instructions_Patr!C15:AA20.
 * Six lays, 408 layers, 1,194 m of Rosetta, producing 2,090 pieces against a
 * 2,084 requirement.
 *
 * `totalLengthM` is the sheet's own column X, and it is deliberately NOT
 * `layers × markerLengthM`. The two differ by about 7% — the end loss and
 * splice allowance on each lay — so the recorded consumption is stored as the
 * fact. Deriving it from the product alone would under-state this order's
 * fabric requirement by 80 m, which is how a cutting floor runs out.
 */
export const LAYS: Array<{
  fabric: string; color: string; panel: string; sizeRatio: string;
  layers: number; markerLengthM: number; nestPcs: number; totalLengthM: number;
}> = [
  { fabric: 'Rosetta', color: 'White', panel: 'ALL', sizeRatio: '(YXS1), (YS1), (YM1), (YL1), (M1)', layers: 140, markerLengthM: 2.61, nestPcs: 5, totalLengthM: 391 },
  { fabric: 'Rosetta', color: 'White', panel: 'ALL', sizeRatio: '(YS2), (YM2), (YL1)',               layers: 177, markerLengthM: 2.41, nestPcs: 5, totalLengthM: 457 },
  { fabric: 'Rosetta', color: 'White', panel: 'ALL', sizeRatio: '(2YXS1), (S3), (L1), (XL1)',        layers: 44,  markerLengthM: 4.15, nestPcs: 6, totalLengthM: 196 },
  { fabric: 'Rosetta', color: 'White', panel: 'ALL', sizeRatio: '(2YXS1), (YXS2), (S2), (L1)',       layers: 30,  markerLengthM: 3.20, nestPcs: 6, totalLengthM: 103 },
  { fabric: 'Rosetta', color: 'White', panel: 'ALL', sizeRatio: '(2YXS1), (2XL2)',                   layers: 12,  markerLengthM: 2.40, nestPcs: 3, totalLengthM: 31 },
  { fabric: 'Rosetta', color: 'White', panel: 'ALL', sizeRatio: '(YXS1), (YM2), (M2)',               layers: 5,   markerLengthM: 2.90, nestPcs: 5, totalLengthM: 16 },
];

/** External Order_Ex.Op!C21:V24 — colour area for full-piece printing at 0.035 m/pc. */
export const EXTERNAL_COLORS: Array<{ color: string; qty: number; rate: number; areaM: number }> = [
  { color: 'SKY BLUE',  qty: 612, rate: 0.035, areaM: 22 },
  { color: 'ATH. GOLD', qty: 490, rate: 0.035, areaM: 18 },
  { color: 'SCARLET',   qty: 407, rate: 0.035, areaM: 15 },
  { color: 'LIME',      qty: 575, rate: 0.035, areaM: 21 },
];

/** Actual Costing_Coordinator — the machine and rate figures. */
export const COSTING = {
  dollarRate: 48.5,      // D12
  dailyCostEgp: 1867,    // D13
  machineCount: 38,      // D14 — All F. Machines
  machineDaysUsed: 130,  // D22 — Machine Already Used
  daysInLine: 11,        // F22
  productionLineMachines: { Single: 7, Over: 6, 'Cover Stitch': 1 }, // D31/D32/D34
};

/** Accessory unit prices, quoted in EGP on the sheet and divided by the rate. */
export const COST_LINES: Array<{ group: string; label: string; unit: string; unitPriceEgp: number | null; unitPriceUsd: number | null }> = [
  { group: 'ACCESSORY', label: 'Logo',                 unit: 'Pcs',  unitPriceEgp: null, unitPriceUsd: 0.1 },
  { group: 'ACCESSORY', label: 'Tie Cord',             unit: 'Pcs',  unitPriceEgp: 1,    unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Heat Transfer Size',   unit: 'Pcs',  unitPriceEgp: 0.12, unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Hang Tag + Pins gun',  unit: 'Pcs',  unitPriceEgp: 0.4,  unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Elastic',              unit: 'Kg',   unitPriceEgp: 55,   unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Washing inst',         unit: 'Pcs',  unitPriceEgp: 0.25, unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Poly Bag',             unit: 'Pcs',  unitPriceEgp: 0.25, unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Butter Paper',         unit: 'Pcs',  unitPriceEgp: 0.4,  unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Thread',               unit: 'Roll', unitPriceEgp: 18,   unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Sticky Tape',          unit: 'Roll', unitPriceEgp: 5,    unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Dzn. Box',             unit: 'Pcs',  unitPriceEgp: 3,    unitPriceUsd: null },
  { group: 'ACCESSORY', label: 'Carton',               unit: 'Pcs',  unitPriceEgp: 16,   unitPriceUsd: null },
  { group: 'FABRIC',    label: 'Rosetta (main)',       unit: 'met.', unitPriceEgp: null, unitPriceUsd: null },
];

/**
 * Users. Names come from the Data-Base sheet's coordinator and member lists;
 * the factory's real people, given accounts and roles.
 */
export const USERS: Array<{ name: string; email: string; roleKey: string; department: string }> = [
  { name: 'Amr Sheha',      email: 'admin@soccertex.biz',       roleKey: 'ADMIN',              department: 'ADMIN' },
  { name: 'Hassona',        email: 'hassona@soccertex.biz',     roleKey: 'COORDINATOR',        department: 'COORDINATOR' },
  { name: 'Ahmed Samy',     email: 'ahmed.samy@soccertex.biz',  roleKey: 'COORDINATOR',        department: 'COORDINATOR' },
  { name: 'Aya Mahmed',     email: 'aya@soccertex.biz',         roleKey: 'COORDINATOR',        department: 'COORDINATOR' },
  { name: 'Ibrahem Samy',   email: 'ibrahem@soccertex.biz',     roleKey: 'FACTORY_MANAGER',    department: 'FACTORY_MANAGER' },
  { name: 'Abdo Mahmoud',   email: 'abdo@soccertex.biz',        roleKey: 'PRODUCTION_MANAGER', department: 'PRODUCTION_MANAGER' },
  { name: 'Tamer',          email: 'tamer@soccertex.biz',       roleKey: 'FACTORY_MANAGER',    department: 'CUTTING_MARKER' },
  { name: 'Khaled',         email: 'khaled@soccertex.biz',      roleKey: 'WAREHOUSE',          department: 'WAREHOUSE' },
  { name: 'Helmy',          email: 'helmy@soccertex.biz',       roleKey: 'EXTERNAL_OPS',       department: 'EXTERNAL_OPS' },
  { name: 'Shimaa',         email: 'shimaa@soccertex.biz',      roleKey: 'QUALITY',            department: 'QUALITY' },
  { name: 'Sabry Khamis',   email: 'sabry@soccertex.biz',       roleKey: 'PACKING',            department: 'PACKING' },
  { name: 'Aya Fawzy',      email: 'aya.fawzy@soccertex.biz',   roleKey: 'FOLLOW_UP',          department: 'FOLLOW_UP' },
  { name: 'Magdy',          email: 'magdy@soccertex.biz',       roleKey: 'FINANCE',            department: 'FINANCE' },
];

// ═══════════════════════════════════════════════════════════════════════════
// Materials & inventory
//
// Two groups. The first is the stock this order actually draws on, linked to
// its BOM lines by `bomItem` below, so the material position on the order page
// is computed from real balances rather than from illustration. The second is
// the rest of the factory's catalogue, so the inventory screens look like a
// working store rather than a demo with four rows.
//
// One deliberate shortage: Rosetta White has 718 m against a 1,194 m
// requirement, leaving it **476 m short** — the brief's own worked example, and
// the reason the cutting stage is blocked when the seeded order is opened.
// ═══════════════════════════════════════════════════════════════════════════

export interface SeedMaterial {
  code: string;
  name: string;
  type: string;
  unit: string;
  colorName?: string;
  composition?: string;
  gsm?: number;
  widthCm?: number;
  sizeLabel?: string;
  supplierName?: string;
  minimumQty?: number;
  unitCostUsd?: number;
  /** Ending physical stock. Movements below must add up to exactly this. */
  physicalQty: number;
  /** BOM lines this material supplies, matched on item + description + colour. */
  bomMatch?: Array<{ item: string; description?: string; color?: string }>;
  notes?: string;
}

export const MATERIALS: SeedMaterial[] = [
  {
    code: 'FAB-ROS-WHT', name: 'Rosetta Jersey — White', type: 'FABRIC', unit: 'M',
    colorName: 'White', composition: '100% Polyester', gsm: 140, widthCm: 180,
    supplierName: 'Delta Textiles', minimumQty: 500, unitCostUsd: 1.85,
    physicalQty: 718,
    bomMatch: [{ item: 'cut', description: 'Rosetta', color: 'White' }],
    notes: 'Main shell fabric. Short against the current order — purchase request raised.',
  },
  {
    code: 'FAB-ROS-SKY', name: 'Rosetta Jersey — Sky Blue', type: 'FABRIC', unit: 'M',
    colorName: 'Sky Blue', composition: '100% Polyester', gsm: 140, widthCm: 180,
    supplierName: 'Delta Textiles', minimumQty: 40, unitCostUsd: 1.9, physicalQty: 96,
    bomMatch: [{ item: 'print', color: 'SKY BLUE' }],
  },
  {
    code: 'FAB-ROS-GLD', name: 'Rosetta Jersey — Athletic Gold', type: 'FABRIC', unit: 'M',
    colorName: 'Athletic Gold', composition: '100% Polyester', gsm: 140, widthCm: 180,
    supplierName: 'Delta Textiles', minimumQty: 40, unitCostUsd: 1.9, physicalQty: 74,
    bomMatch: [{ item: 'print', color: 'ATH. GOLD' }],
  },
  {
    code: 'FAB-ROS-SCR', name: 'Rosetta Jersey — Scarlet', type: 'FABRIC', unit: 'M',
    colorName: 'Scarlet', composition: '100% Polyester', gsm: 140, widthCm: 180,
    supplierName: 'Delta Textiles', minimumQty: 40, unitCostUsd: 1.9, physicalQty: 58,
    bomMatch: [{ item: 'print', color: 'SCARLET' }],
  },
  {
    code: 'FAB-ROS-LIM', name: 'Rosetta Jersey — Lime', type: 'FABRIC', unit: 'M',
    colorName: 'Lime', composition: '100% Polyester', gsm: 140, widthCm: 180,
    supplierName: 'Delta Textiles', minimumQty: 40, unitCostUsd: 1.9, physicalQty: 88,
    bomMatch: [{ item: 'print', color: 'LIME' }],
  },
  {
    code: 'TRF-DTF-FLA', name: 'DTF Transfer — Florida size label', type: 'PRINT_TRANSFER', unit: 'PCS',
    colorName: 'DTF', supplierName: 'Pro Print', minimumQty: 500, unitCostUsd: 0.06,
    physicalQty: 2500,
    bomMatch: [{ item: 'Florida Transfer Size' }],
  },
  {
    code: 'THR-STAR-SKY', name: 'Star Thread — Sky Blue', type: 'THREAD', unit: 'PCS',
    colorName: 'Sky Blue', supplierName: 'Star Threads', minimumQty: 20, unitCostUsd: 0.42,
    physicalQty: 120, bomMatch: [{ item: 'Star Thread Roll', color: 'SKY BLUE' }],
  },
  {
    code: 'THR-STAR-GLD', name: 'Star Thread — Athletic Gold', type: 'THREAD', unit: 'PCS',
    colorName: 'Athletic Gold', supplierName: 'Star Threads', minimumQty: 20, unitCostUsd: 0.42,
    physicalQty: 96, bomMatch: [{ item: 'Star Thread Roll', color: 'ATH. GOLD' }],
  },
  {
    code: 'THR-STAR-SCR', name: 'Star Thread — Scarlet', type: 'THREAD', unit: 'PCS',
    colorName: 'Scarlet', supplierName: 'Star Threads', minimumQty: 20, unitCostUsd: 0.42,
    physicalQty: 84, bomMatch: [{ item: 'Star Thread Roll', color: 'SCARLET' }],
  },
  {
    code: 'THR-STAR-LIM', name: 'Star Thread — Lime', type: 'THREAD', unit: 'PCS',
    colorName: 'Lime', supplierName: 'Star Threads', minimumQty: 20, unitCostUsd: 0.42,
    physicalQty: 110, bomMatch: [{ item: 'Star Thread Roll', color: 'LIME' }],
  },
  {
    code: 'PKG-POLY-HUM', name: 'Poly bag — Hummel print', type: 'POLY_BAG', unit: 'PCS',
    sizeLabel: '35x45cm', supplierName: 'Nile Packaging', minimumQty: 2000, unitCostUsd: 0.035,
    physicalQty: 6400, bomMatch: [{ item: 'Hummel' }],
  },
  {
    code: 'PKG-BUTTER', name: 'Butter paper', type: 'PACKAGING', unit: 'PCS',
    supplierName: 'Nile Packaging', minimumQty: 2000, unitCostUsd: 0.012,
    physicalQty: 5200, bomMatch: [{ item: 'Butter Paper' }],
  },
  {
    code: 'PKG-TAPE-UNI', name: 'Sticky tape — Unisex', type: 'PACKAGING', unit: 'PCS',
    supplierName: 'Nile Packaging', minimumQty: 1500, unitCostUsd: 0.008,
    physicalQty: 4800, bomMatch: [{ item: 'Unisex' }],
  },
  {
    code: 'PKG-CTN-PRO', name: 'Carton — Protime', type: 'CARTON', unit: 'PCS',
    sizeLabel: '60x40x40', supplierName: 'Nile Packaging', minimumQty: 40, unitCostUsd: 1.15,
    physicalQty: 180, bomMatch: [{ item: 'Protime' }],
  },

  // ── The rest of the store ────────────────────────────────────────────────
  {
    code: 'FAB-CJ-180', name: 'Cotton Jersey 180gsm', type: 'FABRIC', unit: 'M',
    colorName: 'Natural', composition: '100% Cotton', gsm: 180, widthCm: 185,
    supplierName: 'Delta Textiles', minimumQty: 2000, unitCostUsd: 2.4, physicalQty: 12500,
  },
  {
    code: 'FAB-PES-WHT', name: 'Polyester Interlock — White', type: 'FABRIC', unit: 'M',
    colorName: 'White', composition: '100% Polyester', gsm: 160, widthCm: 175,
    supplierName: 'Delta Textiles', minimumQty: 1500, unitCostUsd: 1.6, physicalQty: 1200,
  },
  {
    code: 'TRM-BTN-15', name: 'Button 15mm — Matt Black', type: 'BUTTON', unit: 'PCS',
    colorName: 'Black', sizeLabel: '15mm', supplierName: 'Cairo Trims',
    minimumQty: 5000, unitCostUsd: 0.02, physicalQty: 18500,
  },
  {
    code: 'TRM-ZIP-YKK', name: 'YKK Zipper 45cm — Black', type: 'ZIPPER', unit: 'PCS',
    colorName: 'Black', sizeLabel: '45cm', supplierName: 'YKK Egypt',
    minimumQty: 1000, unitCostUsd: 0.38, physicalQty: 0,
  },
  {
    code: 'THR-COT-40', name: 'Cotton Thread 40/2 — White', type: 'THREAD', unit: 'CONE',
    colorName: 'White', supplierName: 'Star Threads', minimumQty: 400, unitCostUsd: 0.55,
    physicalQty: 340,
  },
  {
    code: 'LBL-CARE-EN', name: 'Care label — English', type: 'LABEL', unit: 'PCS',
    supplierName: 'Cairo Trims', minimumQty: 10000, unitCostUsd: 0.004, physicalQty: 42000,
  },
  {
    code: 'ELS-25-WHT', name: 'Elastic 25mm — White', type: 'ELASTIC', unit: 'M',
    colorName: 'White', widthCm: 2.5, supplierName: 'Cairo Trims',
    minimumQty: 1000, unitCostUsd: 0.11, physicalQty: 820,
  },
];

/**
 * Movement history for the main fabric — the brief's §21 screen.
 *
 * These must add up to `FAB-ROS-WHT.physicalQty` (718). Every other material
 * gets a single opening receipt, so `reconcileStock()` reports no drift on a
 * freshly seeded database. A seed that drifted would look exactly like a bug.
 */
export const MATERIAL_MOVEMENTS: Array<{
  code: string; type: string; qty: number; daysAgo: number; reason: string; batchLot?: string;
}> = [
  { code: 'FAB-ROS-WHT', type: 'RECEIPT', qty: 5000, daysAgo: 71, reason: 'Purchase receipt — supplier PO S-1188', batchLot: 'ROS-2606-A' },
  { code: 'FAB-ROS-WHT', type: 'ISSUE',   qty: 3000, daysAgo: 54, reason: 'Issued to production — order A301988' },
  { code: 'FAB-ROS-WHT', type: 'WASTAGE', qty: 82,   daysAgo: 53, reason: 'Roll-end damage found on inspection' },
  { code: 'FAB-ROS-WHT', type: 'ISSUE',   qty: 1400, daysAgo: 28, reason: 'Issued to production — order A302011' },
  { code: 'FAB-ROS-WHT', type: 'RETURN',  qty: 200,  daysAgo: 24, reason: 'Returned unused from cutting' },
];

export const INVENTORY_LOCATIONS: Array<{ name: string; code: string; kind: string }> = [
  { name: 'Main store', code: 'MAIN', kind: 'STORE' },
  { name: 'Cutting floor', code: 'CUT', kind: 'PRODUCTION' },
  { name: 'Packing store', code: 'PACK', kind: 'STORE' },
];

/**
 * The named super administrators — the only accounts permitted to create,
 * disable, re-role or reset another account.
 *
 * Seeding them is not what grants the power: `SUPER_ADMIN_EMAILS` in the
 * environment decides who *may* hold it, and this list only creates the
 * accounts for the two addresses the brief names. An address seeded here but
 * absent from the environment is refused at runtime, exactly as if the flag
 * were not set.
 */
export const SUPER_ADMINS: Array<{ name: string; email: string; department: string }> = [
  { name: 'Ahmed', email: 'ahmed@soccertex.biz', department: 'ADMIN' },
  { name: 'Laila', email: 'laila@soccertex.biz', department: 'ADMIN' },
];

export const CLIENTS: Array<{ name: string; shippingAddress?: string; billingAddress?: string }> = [
  {
    name: 'ProTime',
    shippingAddress: ORDER.shippingAddress,
    billingAddress: ORDER.billingAddress,
  },
  {
    name: 'Kittrich Xara division',
    billingAddress: '11585 W. Mission Blvd\nPomona, CA 91766 USA\nPhone Number: 714-736-1000',
  },
  { name: 'Olympic Team' },
  { name: 'Mas' },
  { name: 'Kotn' },
  { name: 'MandM' },
  { name: 'Donkey' },
  {
    name: 'HLD',
    billingAddress: 'Heritage Leisure Design\n3 King Street\nNewcastle-Under-Lyme ST5 1EN, UK\nPhone 01782 618115',
  },
  { name: 'Viga' },
];

export const FACTORIES: Array<{ name: string; address?: string; isExternal: boolean }> = [
  {
    name: 'AGE',
    address: 'AGE (Al Shimaa Garment and Embroidery)\nStreet 6 - Public Free Zone - Nasr City, Cairo, Egypt',
    isExternal: true,
  },
  { name: 'Pro Print', isExternal: true },
];

/**
 * Production history for the demo.
 *
 * The workbook's `Production Follow up` sheet is empty for this order — it has
 * headers and a SUM row and nothing else. Rather than leave the demo with no
 * production picture at all, a short realistic ramp is seeded so the analytics,
 * the trend chart and the delay detection have something to work on. It is
 * clearly marked as demo data and is the only fabricated data in this seed.
 */
export const DEMO_PRODUCTION: Array<{ dayOffset: number; operation: string; qty: number; line: string }> = [
  { dayOffset: -9, operation: 'CUTTING', qty: 2084, line: 'Cutting floor' },
  { dayOffset: -6, operation: 'SEWING',  qty: 180,  line: 'Line 1' },
  { dayOffset: -5, operation: 'SEWING',  qty: 240,  line: 'Line 1' },
  { dayOffset: -4, operation: 'SEWING',  qty: 210,  line: 'Line 1' },
  { dayOffset: -3, operation: 'SEWING',  qty: 260,  line: 'Line 2' },
  { dayOffset: -2, operation: 'SEWING',  qty: 200,  line: 'Line 2' },
  { dayOffset: -1, operation: 'SEWING',  qty: 160,  line: 'Line 2' },
];
