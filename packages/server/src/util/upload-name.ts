/**
 * Browsers send a multipart filename as raw UTF-8 bytes, and multer 1.x
 * (through busboy) reads those bytes as latin1 — so "فاتورة.pdf" arrived as
 * "ÙØ§ØªÙØ±Ø©.pdf" and was stored, listed and downloaded that way.
 *
 * Re-reading the latin1 string's bytes as UTF-8 restores the real name. A name
 * that is not valid UTF-8 underneath (or already holds characters latin1
 * cannot, so was decoded properly upstream) is left exactly as it came.
 */
export function decodeUploadName(name: string): string {
  if (/[^\u0000-\u00ff]/.test(name) || !/[\u0080-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * A Content-Disposition value that survives any filename. Node refuses a header
 * holding characters above U+00FF, so the plain `filename` is an ASCII stand-in
 * and `filename*` carries the real name for every browser that reads it.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
