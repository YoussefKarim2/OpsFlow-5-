/**
 * Renders the invoice document to a static HTML file, for a visual check
 * outside the app: `npx tsx scripts/render-invoice-preview.tsx <invoice.json> <out.html> [css]`.
 *
 * The JSON is an InvoiceDto as the API returns it. The stylesheet is the built
 * one from `dist/assets`, so the classes resolve exactly as they do in the app.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InvoiceDto } from '@opsflow/shared';
import { InvoiceDocument } from '../src/components/InvoiceDocument';

const [input, output, css] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: render-invoice-preview <invoice.json> <out.html> [stylesheet.css]');
  process.exit(1);
}
const doc = JSON.parse(readFileSync(input, 'utf8')) as InvoiceDto;
const body = renderToStaticMarkup(createElement(InvoiceDocument, { doc }));
const style = css ? `<style>${readFileSync(css, 'utf8')}</style>` : '';
writeFileSync(output, `<!doctype html><html><head><meta charset="utf-8"><title>${doc.number}</title>${style}
<style>body{background:#fff;margin:0;padding:24px;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}</style></head><body>${body}</body></html>`);
console.log(`wrote ${output}`);
