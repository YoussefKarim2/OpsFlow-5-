/**
 * The bill of materials' department → item sequence, as the factory template
 * ("Final Template Po (Maestro)", sheet Bill Of Matrial_Coord_Warehouse) sets
 * it up.
 *
 * In the template, column C ("Item Sort / Dep.") picks a department from
 * Data-Base!AE, and column D ("Item") is a dropdown of `INDIRECT(C)`: the named
 * range for that department — Press = Data-Base!AH, Production = AI, Packing =
 * AJ. Yoko has no named range, so its item is typed. Units come from AL.
 *
 * Fabric is the template's separate fabric section above the accessories; it
 * is kept here as a department so a fabric line reads the same way.
 *
 * Each item also maps onto the stored BOM category, so nothing downstream —
 * shortages, costing, stock links — changes. The department of a saved line is
 * read back from its item, or failing that from its category.
 */

export const BOM_DEPARTMENTS = ['Fabric', 'Yoko', 'Press', 'Production', 'Packing'] as const;
export type BomDepartment = (typeof BOM_DEPARTMENTS)[number];

/** The template's dropdown lists. Yoko and Fabric have none: their items are typed. */
export const BOM_DEPARTMENT_ITEMS: Record<BomDepartment, readonly string[]> = {
  Fabric: [],
  Yoko: [],
  Press: ['Logo', 'Badge', 'Sponser', 'Size', 'Number', 'Authantic Bdge'],
  // "zipper" sits under the list on the Data-Base sheet, one row below the
  // named range's end; it is the factory's own addition, so it is offered.
  Production: ['Washing Inst.', 'Elastic', 'Tie Cord', 'Thread', 'Tape', 'Sponge', 'Side Woven', 'Zipper'],
  Packing: [
    'Poly Bag', 'Poly Bag Size', 'Hang Tag', 'Hang Tag Pins', 'Barcode Paper', 'Butter Paper',
    'Hologrram', 'Sticky Tape', 'Dzn. Box', 'Half Box', 'Carton',
  ],
};

/** The template's unit list (Data-Base!AL). */
export const BOM_UNITS = ['Met.', 'Pcs', 'Kg.', 'Grm.', 'Cm.', 'Block', 'Roll'] as const;

/** The stored category for each listed item. */
const ITEM_CATEGORY: Record<string, string> = {
  logo: 'LOGO', badge: 'BADGE', 'authantic bdge': 'BADGE', sponser: 'SPONSOR', size: 'SIZE', number: 'TRANSFER',
  'washing inst.': 'LABEL', 'side woven': 'LABEL', thread: 'THREAD', tape: 'TAPE',
  elastic: 'ACCESSORY', 'tie cord': 'ACCESSORY', sponge: 'ACCESSORY', zipper: 'ACCESSORY',
  'poly bag': 'POLY_BAG', 'poly bag size': 'POLY_BAG', 'butter paper': 'BUTTER_PAPER', 'sticky tape': 'STICKY_TAPE',
  'barcode paper': 'BARCODE_PAPER', 'half box': 'HALF_BOX', carton: 'CARTON', 'dzn. box': 'CARTON',
  'hang tag': 'ACCESSORY', 'hang tag pins': 'ACCESSORY', hologrram: 'ACCESSORY',
};

/** The category an item typed under a department is stored as, when it is not on a list. */
const DEPARTMENT_CATEGORY: Record<BomDepartment, string> = {
  Fabric: 'FABRIC', Yoko: 'FABRIC', Press: 'TRANSFER', Production: 'ACCESSORY', Packing: 'CARTON',
};

/** And back: the department a stored category belongs to. */
const CATEGORY_DEPARTMENT: Record<string, BomDepartment> = {
  FABRIC: 'Fabric',
  LOGO: 'Press', BADGE: 'Press', SPONSOR: 'Press', SIZE: 'Press', TRANSFER: 'Press',
  THREAD: 'Production', TAPE: 'Production', LABEL: 'Production', ACCESSORY: 'Production',
  POLY_BAG: 'Packing', BUTTER_PAPER: 'Packing', STICKY_TAPE: 'Packing', BARCODE_PAPER: 'Packing',
  HALF_BOX: 'Packing', CARTON: 'Packing',
};

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The items offered for a department, in the template's order. */
export function bomItemsFor(department: BomDepartment | null | undefined): readonly string[] {
  return department ? BOM_DEPARTMENT_ITEMS[department] : [];
}

/** Which department a saved line belongs to: by its item first, then its category. */
export function bomDepartmentOf(item: string, category: string): BomDepartment | null {
  const k = key(item);
  if (/\byoko\b/.test(k)) return 'Yoko';
  for (const d of BOM_DEPARTMENTS) if (BOM_DEPARTMENT_ITEMS[d].some((i) => key(i) === k)) return d;
  return CATEGORY_DEPARTMENT[category] ?? null;
}

/** The stored category for an item chosen or typed under a department. */
export function bomCategoryFor(department: BomDepartment, item: string): string {
  return ITEM_CATEGORY[key(item)] ?? DEPARTMENT_CATEGORY[department];
}
