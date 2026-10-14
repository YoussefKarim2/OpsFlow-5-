/**
 * A swatch for a colour name.
 *
 * Imported orders arrive with colour names and nothing else — "ROY/WHT",
 * "ATH. GOLD", "Navy" — and the grids showed a swatch only for the few
 * colours somebody had given a hex by hand. The names say what the colour
 * is; this reads them. A two-tone name ("BLACK/YELLOW") is a split swatch,
 * a single name a solid one, and a name nothing here recognises gets none,
 * which is better than a wrong one.
 */

/** Garment colour words, with the abbreviations purchase orders use. */
const WORDS: Array<[RegExp, string]> = [
  [/^(white|wht|wh|optic white|off white|offwhite)$/, '#ffffff'],
  [/^(black|blk|bk|jet black)$/, '#111111'],
  [/^(navy|nvy|nav|navy blue|dark navy|marine|bleu marine)$/, '#1b2a4a'],
  [/^(royal|roy|royal blue|ryl)$/, '#1e4fd8'],
  [/^(sky|sky blue|skyblue|light blue|lt blue|columbia|columbia blue|col)$/, '#8fc5f0'],
  [/^(blue|blu|bleu|blau)$/, '#2563eb'],
  [/^(red|rd|rot|rouge|scarlet|crimson)$/, '#d7263d'],
  [/^(maroon|burgundy|wine|bordeaux|cardinal)$/, '#7a1f2b'],
  [/^(green|grn|gr|kelly|kelly green|vert|grun|grün)$/, '#1f9d55'],
  [/^(hunter|hunter green|forest|forest green|dark green|bottle green)$/, '#1d5c3a'],
  [/^(lime|lime green|neon green|volt)$/, '#b5e61d'],
  [/^(yellow|yel|ylw|gelb|jaune)$/, '#f2d21b'],
  [/^(gold|gld|athletic gold|ath gold|a gld|a\.?gld|vegas gold|old gold)$/, '#d4a017'],
  [/^(orange|org|orng)$/, '#f07a1f'],
  [/^(purple|ppl|pur|violet|lilac)$/, '#6b3fa0'],
  [/^(pink|pnk|rose|fuchsia|magenta|hot pink)$/, '#e84393'],
  [/^(baby pink|light pink|lt pink|blush)$/, '#f4b6c7'],
  [/^(teal|tl|aqua|turquoise|jade)$/, '#148f8f'],
  [/^(grey|gray|gry|heather|heather grey|sport grey|ash|silver grey)$/, '#9aa3ad'],
  [/^(charcoal|char|dark grey|dark gray|graphite|anthracite)$/, '#4a4f55'],
  [/^(silver|slv|sil)$/, '#c0c4c8'],
  [/^(brown|brn|chocolate|coffee|tan)$/, '#7b4a2d'],
  [/^(beige|khaki|sand|stone|cream|ivory|ecru|natural)$/, '#e4d6b8'],
  [/^(olive|olive green|army|military)$/, '#6b7a2e'],
  [/^(cyan|electric blue)$/, '#06b6d4'],
  [/^(coral|salmon|peach)$/, '#f08a7a'],
  [/^(mint|sage)$/, '#9fd8b4'],
  [/^(lavender|lilac)$/, '#b9a7e0'],
  [/^(camo|camouflage)$/, '#5e6b3a'],
  [/^(multi|multicolour|multicolor|assorted)$/, '#9ca3af'],
];

export interface Swatch {
  /** The one or two colours to paint, left to right. */
  hexes: [string] | [string, string];
}

function hexForWord(part: string): string | null {
  const w = part.toLowerCase().replace(/[().]/g, '').replace(/\s+/g, ' ').trim();
  if (!w) return null;
  for (const [re, hex] of WORDS) if (re.test(w)) return hex;
  // "dark navy", "light grey": the last word carries the colour.
  const last = w.split(' ').pop()!;
  if (last !== w) for (const [re, hex] of WORDS) if (re.test(last)) return hex;
  return null;
}

/**
 * The swatch a colour name describes, or null when it describes none.
 *
 * "Style — Colour" rows (one order holding several styles) are read by the
 * colour after the dash. Parts are split on "/", "-", "&" and " with ", so
 * "ROY/WHT" is royal over white and "Red & Black" red over black.
 */
export function swatchFor(name: string | null | undefined): Swatch | null {
  if (!name) return null;
  const colour = name.includes(' — ') ? name.split(' — ').pop()! : name;
  // A colour code beside the name ("Black/Yellow 020") is not a colour.
  const cleaned = colour.replace(/\b\d{2,4}\b/g, ' ').trim();
  const parts = cleaned.split(/\s*(?:\/|-|&|\+|\bwith\b|\bw\/)\s*/i).map((p) => p.trim()).filter(Boolean);
  const hexes = parts.map(hexForWord).filter((h): h is string => h != null);
  if (hexes.length === 0) {
    const whole = hexForWord(cleaned);
    return whole ? { hexes: [whole] } : null;
  }
  if (hexes.length === 1) return { hexes: [hexes[0]!] };
  return { hexes: [hexes[0]!, hexes[1]!] };
}

/** The single hex to store for a colour name: its first tone. */
export function colourHexFor(name: string | null | undefined): string | null {
  return swatchFor(name)?.hexes[0] ?? null;
}
