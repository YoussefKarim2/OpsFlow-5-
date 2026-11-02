/**
 * An efficiency as a percentage, whichever way the sheet wrote it.
 *
 * The factory's laying sheet formats EFF% as a percent, so the cell holds
 * 0.81 and Excel shows "81%". Stored as written, the Laying & Marker screen's
 * "Eff %" column read 0.8. A figure up to 1.5 is a fraction and is scaled;
 * anything larger is already a percentage. (No lay runs at 1.5% efficiency.)
 */
export function asPercent(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const v = n > 0 && n <= 1.5 ? n * 100 : n;
  return Math.round(v * 1000) / 1000;
}
