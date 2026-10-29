/**
 * The bill of materials' department → item sequence, as the factory template
 * ("Final Template Po (Maestro)", sheet Bill Of Matrial_Coord_Warehouse) sets
 * it up.
 *
 * In the template, column C ("Item Sort / Dep.") picks a department from
 * Data-Base!AE, and column D ("Item") is a dropdown of `INDIRECT(C)`: the named
 * range for that department — Press = Data-Base!AH, Production = AI, Packing =
 * AJ. Yoko has no named range; it is offered its two parts, collar and cuffs.
 * Units come from AL.
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

/**
 * The template's dropdown lists. Fabric's is the factory's fabric list, which
 * is reference data an administrator edits, so the editor fills it in from
 * /lookups rather than from here.
 */
export const BOM_DEPARTMENT_ITEMS: Record<BomDepartment, readonly string[]> = {
  Fabric: [],
  Yoko: ['Yoko Collar', 'Yoko Cuffs'],
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

/**
 * Which department a saved line belongs to.
 *
 * A Yoko part says so in its name (see `bomItemName`). Otherwise the stored
 * category decides, because `bomCategoryFor` stores a department-specific
 * one: a line read by its item name first reopened under the wrong
 * department whenever the name happened to be on another department's list —
 * a fabric typed as "Tape" came back under Production. The item lists are
 * the fallback for a line whose category says nothing (OTHER).
 */
export function bomDepartmentOf(item: string, category: string): BomDepartment | null {
  const k = key(item);
  // Only a fabric-category line: a "Yoko Collar" moved to Press is stored as
  // a transfer and belongs there, whatever its name still says.
  if (category === 'FABRIC' && /\byoko\b/.test(k)) return 'Yoko';
  // A listed item whose stored category is the one its list gives it — a
  // "Hang Tag" stored as an accessory — belongs to that list; the same name
  // stored under another department's category was typed there.
  const listed = BOM_DEPARTMENTS.find((d) => BOM_DEPARTMENT_ITEMS[d].some((i) => key(i) === k));
  if (listed && bomCategoryFor(listed, item) === category) return listed;
  return CATEGORY_DEPARTMENT[category] ?? listed ?? null;
}

/**
 * The stored category for an item chosen or typed under a department.
 *
 * A listed item has its own category; a typed one takes the department's,
 * whatever it is called — "Size" typed under Fabric is a fabric, not a size
 * label.
 */
export function bomCategoryFor(department: BomDepartment, item: string): string {
  const listed = BOM_DEPARTMENT_ITEMS[department].some((i) => key(i) === key(item));
  return (listed ? ITEM_CATEGORY[key(item)] : undefined) ?? DEPARTMENT_CATEGORY[department];
}

/**
 * The item name as it is stored for a department.
 *
 * Yoko and Fabric are both stored as FABRIC, so a Yoko part is told apart by
 * its name: "Collar" typed under Yoko is saved as "Yoko Collar", which is
 * what the factory calls it and what brings it back under Yoko.
 */
export function bomItemName(department: BomDepartment | null, item: string): string {
  const t = item.trim().replace(/\s+/g, ' ');
  if (department === 'Yoko' && t && !/\byoko\b/i.test(t)) return `Yoko ${t}`;
  return t;
}
