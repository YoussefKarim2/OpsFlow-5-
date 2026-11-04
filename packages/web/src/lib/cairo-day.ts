/**
 * The calendar day in Cairo, where the factory is — "YYYY-MM-DD".
 *
 * `new Date().toISOString()` is the UTC day, which before 02:00 in Cairo is
 * still yesterday: a proforma dated the day before it was made, an invoice
 * issued on the 1st counted in last month.
 */
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
export const cairoDay = (d: Date | string = new Date()): string => fmt.format(typeof d === 'string' ? new Date(d) : d);
/** "YYYY-MM" in Cairo. */
export const cairoMonth = (d: Date | string = new Date()): string => cairoDay(d).slice(0, 7);
