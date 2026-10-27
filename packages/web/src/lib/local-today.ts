/**
 * Today as the person at the keyboard sees it, as `YYYY-MM-DD`.
 *
 * `new Date().toISOString()` is UTC, which in Cairo is still yesterday until two
 * or three in the morning — so a form defaulted with it filed the night shift's
 * work on the wrong day. Every date input that defaults to today uses this.
 */
export function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
