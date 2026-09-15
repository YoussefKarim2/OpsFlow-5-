import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Do the tables in the editors still have as many headings as cells?
 *
 * The bill of materials grew an Issued column and the heading for it did not
 * land — a scripted edit asserted on one anchor and not the other, and the
 * failure was silent. The table then had ten cells under nine headings, so
 * every column after Quantity sat under the wrong title and the new input
 * looked like the Unit field. It rendered, it typechecked, and it was wrong.
 *
 * Nothing in a type system catches that. This does, by reading the source.
 */
const SRC = join(import.meta.dirname, '../../web/src');

function countTags(text: string, tag: string): number {
  return (text.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
}

/** The header block, and the widest row of cells beneath it. */
function tableShape(file: string): { headers: number; cells: number; spans: number[] } {
  const src = readFileSync(join(SRC, file), 'utf8');
  const head = src.slice(src.indexOf('<thead'), src.indexOf('</thead>'));
  const body = src.slice(src.indexOf('</thead>'));
  // The widest row is the data row; narrower ones use colSpan.
  const rows = body.split('</tr>').map((r) => countTags(r, 'td'));
  return {
    headers: countTags(head, 'th'),
    cells: Math.max(...rows),
    spans: [...src.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1])),
  };
}

describe('editor tables have a heading for every column', () => {
  test('the bill of materials editor', () => {
    const t = tableShape('components/BomEditor.tsx');
    assert.equal(t.headers, t.cells,
      `${t.headers} headings for ${t.cells} cells — a column has no title`);
  });

  test('no row in it spans more columns than the table has', () => {
    const t = tableShape('components/BomEditor.tsx');
    for (const span of t.spans) {
      assert.ok(span <= t.headers,
        `a row spans ${span} columns but the table has ${t.headers}`);
    }
  });

  test('the Issued column is one of them', () => {
    const src = readFileSync(join(SRC, 'components/BomEditor.tsx'), 'utf8');
    const head = src.slice(src.indexOf('<thead'), src.indexOf('</thead>'));
    assert.match(head, />Issued</, 'the Issued column lost its heading');
  });
});
