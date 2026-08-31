/**
 * Strip anything that executes out of staff-authored rich text.
 *
 * Custom instructions are written by one member of staff and read by another.
 * Storing the HTML verbatim would let whoever writes an instruction run script
 * in the reader's session — the reader being, by design, someone with different
 * permissions from the author.
 *
 * An allowlist of tags is the only version of this that is safe by
 * construction. A blocklist is a list of the dangerous things somebody thought
 * of, and the interesting ones are always the others.
 *
 * Kept dependency-free and in its own file so it can be tested without the
 * database, the config, or an HTTP server.
 */

const ALLOWED_TAGS = /^(p|br|b|strong|i|em|u|ul|ol|li|h3|h4|blockquote)$/i;

export function sanitiseHtml(input: string): string {
  return input
    // Elements whose *content* is code rather than text: dropping the tag alone
    // would leave the script body on the page as visible text at best.
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|svg|math)\b[^>]*>/gi, '')
    // Every remaining tag: keep it only if it is on the allowlist, and drop all
    // attributes — `onerror=`, `href="javascript:"` and `style=` all live there.
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag: string) => {
      if (!ALLOWED_TAGS.test(tag)) return '';
      return match.startsWith('</') ? `</${tag.toLowerCase()}>` : `<${tag.toLowerCase()}>`;
    });
}
